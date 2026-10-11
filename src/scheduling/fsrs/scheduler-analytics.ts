import { default_w as defaultFsrsWeights } from "ts-fsrs";

import {
    CollectionCard,
    CollectionData,
    ReviewLogData,
} from "src/data/collection/collection-types";
import { KnowledgeArea } from "src/data/plugin-data";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";

const DAY = 86_400_000;

export interface SchedulerMetrics {
    reviewCount: number;
    trueRetention: number;
    logLoss: number;
    rmse: number;
    averageResponseMs: number;
    todayDue: number;
    estimatedSessionMinutes: number;
    ratings: [number, number, number, number];
    averageStability: number;
    averageDifficulty: number;
    averageRetrievability: number;
    activity: Array<{ day: string; count: number }>;
    forecast: Array<{ day: string; count: number }>;
    difficultTopics: Array<{ name: string; score: number; cards: number }>;
    problematicTemplates: Array<{ name: string; score: number; cards: number }>;
    knowledgeAreaEfficiency: Array<{ name: string; retention: number; reviews: number }>;
}

export interface FsrsOptimizationResult {
    weights: number[];
    stabilityScale: number;
    sampleSize: number;
    logLoss: number;
    rmse: number;
}

interface RecallSample {
    stability: number;
    elapsedDays: number;
    remembered: number;
}

function fsrsData(card: Pick<CollectionCard, "schedule">): ISerializedFSRSScheduleData | null {
    if (!card.schedule || card.schedule.algorithm !== SRAlgorithmType.FSRS) return null;
    return card.schedule.scheduleData as ISerializedFSRSScheduleData;
}

function probability(stability: number, elapsedDays: number): number {
    const safeStability = Math.max(0.001, stability);
    return Math.max(
        0.001,
        Math.min(0.999, Math.pow(1 + (19 / 81) * (elapsedDays / safeStability), -0.5)),
    );
}

function metricsForSamples(
    samples: RecallSample[],
    stabilityScale = 1,
): { logLoss: number; rmse: number } {
    if (samples.length === 0) return { logLoss: 0, rmse: 0 };
    let logLoss = 0;
    let squaredError = 0;
    for (const sample of samples) {
        const predicted = probability(sample.stability * stabilityScale, sample.elapsedDays);
        logLoss -=
            sample.remembered * Math.log(predicted) +
            (1 - sample.remembered) * Math.log(1 - predicted);
        squaredError += Math.pow(predicted - sample.remembered, 2);
    }
    return {
        logLoss: logLoss / samples.length,
        rmse: Math.sqrt(squaredError / samples.length),
    };
}

function reviewSamples(reviewLog: ReviewLogData): RecallSample[] {
    return Object.values(reviewLog.entries).flatMap((entry) => {
        if (
            entry.deletedAt ||
            !entry.previousSchedule ||
            entry.previousSchedule.algorithm !== SRAlgorithmType.FSRS
        )
            return [];
        const schedule = entry.previousSchedule.scheduleData as ISerializedFSRSScheduleData;
        const lastReview = Date.parse(schedule.lastReview);
        if (!Number.isFinite(lastReview) || !Number.isFinite(schedule.stability)) return [];
        return [
            {
                stability: Math.max(0.001, schedule.stability),
                elapsedDays: Math.max(0, (entry.reviewedAt - lastReview) / DAY),
                remembered: entry.rating === 1 ? 0 : 1,
            },
        ];
    });
}

export function optimizeFsrsWeights(
    reviewLog: ReviewLogData,
    currentWeights: number[] | null = null,
): FsrsOptimizationResult {
    const samples = reviewSamples(reviewLog);
    let bestScale = 1;
    let best = metricsForSamples(samples);
    for (let scale = 0.5; scale <= 1.8; scale += 0.025) {
        const candidate = metricsForSamples(samples, scale);
        if (candidate.logLoss < best.logLoss) {
            bestScale = scale;
            best = candidate;
        }
    }
    const weights = [...(currentWeights?.length ? currentWeights : defaultFsrsWeights)];
    for (let index = 0; index < Math.min(4, weights.length); index++) {
        weights[index] = Math.max(0.001, weights[index] * bestScale);
    }
    return {
        weights,
        stabilityScale: bestScale,
        sampleSize: samples.length,
        logLoss: best.logLoss,
        rmse: best.rmse,
    };
}

function dayKey(timestamp: number): string {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function mean(values: number[]): number {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function analyzeScheduler(
    collection: CollectionData,
    reviewLog: ReviewLogData,
    knowledgeAreas: KnowledgeArea[] = [],
    now = Date.now(),
): SchedulerMetrics {
    const cards = Object.values(collection.cards).filter((card) => !card.deletedAt);
    const reviews = Object.values(reviewLog.entries).filter((entry) => !entry.deletedAt);
    const samples = reviewSamples(reviewLog);
    const evaluation = metricsForSamples(samples);
    const ratings: [number, number, number, number] = [0, 0, 0, 0];
    for (const review of reviews) ratings[review.rating - 1]++;

    const activityMap = new Map<string, number>();
    for (let offset = 83; offset >= 0; offset--) activityMap.set(dayKey(now - offset * DAY), 0);
    for (const review of reviews) {
        const key = dayKey(review.reviewedAt);
        if (activityMap.has(key)) activityMap.set(key, activityMap.get(key)! + 1);
    }
    const forecastMap = new Map<string, number>();
    for (let offset = 0; offset < 90; offset++) forecastMap.set(dayKey(now + offset * DAY), 0);
    for (const card of cards) {
        const schedule = fsrsData(card);
        if (!schedule || card.state !== "active") continue;
        const due = Date.parse(schedule.dueDate);
        if (!Number.isFinite(due)) continue;
        const key = dayKey(Math.max(now, due));
        if (forecastMap.has(key)) forecastMap.set(key, forecastMap.get(key)! + 1);
    }

    const topicMap = new Map<string, CollectionCard[]>();
    const templateMap = new Map<string, CollectionCard[]>();
    for (const card of cards) {
        const topic = card.deckPath || "General";
        topicMap.set(topic, [...(topicMap.get(topic) ?? []), card]);
        const note = collection.notes[card.noteId];
        const type = note ? collection.noteTypes[note.noteTypeId] : null;
        const template = type?.templates.find((candidate) => candidate.id === card.templateId);
        const name = template ? `${type!.name} · ${template.name}` : card.templateId;
        templateMap.set(name, [...(templateMap.get(name) ?? []), card]);
    }
    const rank = (map: Map<string, CollectionCard[]>) =>
        [...map.entries()]
            .map(([name, grouped]) => ({
                name,
                cards: grouped.length,
                score: mean(grouped.map((card) => card.lapses / Math.max(1, card.reps))),
            }))
            .sort((left, right) => right.score - left.score)
            .slice(0, 6);

    const areaEfficiency = knowledgeAreas.map((area) => {
        const areaCardIds = new Set(
            cards
                .filter((card) =>
                    area.deckPaths.some(
                        (path) => card.deckPath === path || card.deckPath.startsWith(`${path}/`),
                    ),
                )
                .map((card) => card.id),
        );
        const areaReviews = reviews.filter((review) => areaCardIds.has(review.cardId));
        return {
            name: area.name,
            reviews: areaReviews.length,
            retention: areaReviews.length
                ? areaReviews.filter((review) => review.rating > 1).length / areaReviews.length
                : 0,
        };
    });

    const fsrsCards = cards
        .map(fsrsData)
        .filter((value): value is ISerializedFSRSScheduleData => value !== null);
    const averageResponseMs = mean(
        reviews.flatMap((review) => (review.durationMs === null ? [] : [review.durationMs])),
    );
    const todayDue = forecastMap.get(dayKey(now)) ?? 0;
    return {
        reviewCount: reviews.length,
        trueRetention: reviews.length
            ? reviews.filter((review) => review.rating > 1).length / reviews.length
            : 0,
        logLoss: evaluation.logLoss,
        rmse: evaluation.rmse,
        averageResponseMs,
        todayDue,
        estimatedSessionMinutes: Math.ceil((todayDue * (averageResponseMs || 12_000)) / 60_000),
        ratings,
        averageStability: mean(fsrsCards.map((card) => card.stability)),
        averageDifficulty: mean(fsrsCards.map((card) => card.difficulty)),
        averageRetrievability: mean(
            fsrsCards.map((card) => {
                const lastReview = Date.parse(card.lastReview);
                return probability(
                    card.stability,
                    Number.isFinite(lastReview) ? (now - lastReview) / DAY : 0,
                );
            }),
        ),
        activity: [...activityMap].map(([day, count]) => ({ day, count })),
        forecast: [...forecastMap].map(([day, count]) => ({ day, count })),
        difficultTopics: rank(topicMap),
        problematicTemplates: rank(templateMap),
        knowledgeAreaEfficiency: areaEfficiency.sort((left, right) => right.reviews - left.reviews),
    };
}

export function intervalForRetention(stability: number, retention: number): number {
    return Math.max(1, Math.round(stability * (81 / 19) * (Math.pow(retention, -2) - 1)));
}
