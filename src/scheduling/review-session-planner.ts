import {
    CollectionCard,
    CollectionData,
    ReviewLogData,
} from "src/data/collection/collection-types";
import { Card } from "src/data/data-structures/card/card";
import { Deck } from "src/data/data-structures/deck/deck";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { RepItemState } from "src/scheduling/algorithms/base/repetition-item";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";

const DAY = 86_400_000;
const DEFAULT_RESPONSE_MS = 12_000;

export interface ReviewSessionPlan {
    availableCards: number;
    selectedCards: number;
    dueCards: number;
    newCards: number;
    backlogCards: number;
    aheadCards: number;
    estimatedMinutes: number;
    averageResponseMs: number;
    finishAt: number;
}

export interface PlannedCard {
    card: CollectionCard;
    dueAt: number | null;
    priority: number;
    score: number;
    /** Positive when this card was promoted to unlock dependent knowledge. */
    dependencyBoost: number;
    /** Human-readable paths whose review depends on this prerequisite. */
    unlocks: string[];
    /** Weak prerequisite paths that should be reviewed before this card. */
    blockedBy: string[];
    /** Exact additive factors used to calculate the final score. */
    scoreBreakdown: ReviewPlanScoreBreakdown;
    /** Confidence that the prerequisite ordering is useful for this card. */
    prerequisiteConfidence: number;
    /** Set only when the user deliberately changes the generated order. */
    manualReason?: string;
}

export interface ReviewPlanScoreBreakdown {
    importance: number;
    learning: number;
    overdue: number;
    forgetting: number;
    dependency: number;
    blocked: number;
    schedule: number;
    manual: number;
}

export interface KnowledgeDependencyEdge {
    prerequisitePath: string;
    dependentPath: string;
    reason?: string;
    source: "frontmatter" | "compiler" | "manual";
    /** Optional explicit confidence from a compiler or a manual graph edit. */
    confidence?: number;
}

export type ReviewPlanExclusionCode =
    | "not-due"
    | "daily-limit"
    | "time-limit"
    | "manual"
    | "suspended"
    | "buried"
    | "missing-stable-id";

export interface ExcludedPlannedCard {
    card: CollectionCard;
    dueAt: number | null;
    code: ReviewPlanExclusionCode;
    headline: string;
    detail: string;
}

export interface ReviewLoadBucket {
    date: string;
    cards: number;
    minutes: number;
    overdue: number;
}

export interface ReviewLoadSimulation {
    days: number;
    totalCards: number;
    totalMinutes: number;
    peakCards: number;
    peakDate: string | null;
    buckets: ReviewLoadBucket[];
}

export interface DependencyImpact {
    prerequisitePath: string;
    dependentPath: string;
    reason?: string;
    source: KnowledgeDependencyEdge["source"];
    strength: number;
    confidence: number;
    withPrerequisite: { reviews: number; successRate: number };
    withoutPrerequisite: { reviews: number; successRate: number };
    uplift: number;
}

export interface ReviewPlanInsight {
    cardId: string;
    stableId: string | null;
    kind: "prerequisite" | "dependent" | "learning" | "overdue" | "new" | "scheduled";
    headline: string;
    detail: string;
    score: number;
    unlocks: string[];
    blockedBy: string[];
}

export function explainPlannedCard(item: PlannedCard, now = Date.now()): ReviewPlanInsight {
    const stableId = item.card.legacyStableId;
    if (item.dependencyBoost > 0) {
        return {
            cardId: item.card.id,
            stableId,
            kind: "prerequisite",
            headline: "Prerequisite first",
            detail: `Reviewing this now unlocks ${item.unlocks.length} dependent knowledge ${item.unlocks.length === 1 ? "path" : "paths"}.`,
            score: item.score,
            unlocks: item.unlocks,
            blockedBy: item.blockedBy,
        };
    }
    if (item.blockedBy.length > 0) {
        return {
            cardId: item.card.id,
            stableId,
            kind: "dependent",
            headline: "Dependent knowledge",
            detail: `${item.blockedBy.length} weak ${item.blockedBy.length === 1 ? "prerequisite is" : "prerequisites are"} scheduled before this card.`,
            score: item.score,
            unlocks: item.unlocks,
            blockedBy: item.blockedBy,
        };
    }
    if (item.card.queue === "learning" || item.card.queue === "relearning") {
        return {
            cardId: item.card.id,
            stableId,
            kind: "learning",
            headline: "Learning step",
            detail: "This card is in an active learning sequence and should not wait.",
            score: item.score,
            unlocks: [],
            blockedBy: [],
        };
    }
    if (item.card.queue === "new") {
        return {
            cardId: item.card.id,
            stableId,
            kind: "new",
            headline: "New knowledge",
            detail: "Selected inside today’s new-card and time limits.",
            score: item.score,
            unlocks: [],
            blockedBy: [],
        };
    }
    const overdueDays = item.dueAt === null ? 0 : Math.max(0, Math.floor((now - item.dueAt) / DAY));
    return {
        cardId: item.card.id,
        stableId,
        kind: overdueDays > 0 ? "overdue" : "scheduled",
        headline: overdueDays > 0 ? `${overdueDays}d overdue` : "Memory due",
        detail:
            overdueDays > 0
                ? "Forgetting risk and overdue time raised this card in the queue."
                : "The scheduler placed this card inside the current review horizon.",
        score: item.score,
        unlocks: [],
        blockedBy: [],
    };
}

export function averageReviewDuration(reviewLog: ReviewLogData): number {
    const recent = Object.values(reviewLog.entries)
        .filter((entry) => !entry.deletedAt && entry.durationMs !== null && entry.durationMs > 0)
        .sort((left, right) => right.reviewedAt - left.reviewedAt)
        .slice(0, 500)
        .map((entry) => Math.min(120_000, entry.durationMs));
    if (!recent.length) return DEFAULT_RESPONSE_MS;
    return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

export function cardDueAt(card: Pick<CollectionCard, "schedule">): number | null {
    if (!card.schedule) return null;
    const due = Date.parse(card.schedule.scheduleData.dueDate);
    return Number.isFinite(due) ? due : null;
}

export function cardRetrievability(card: CollectionCard, now: number): number {
    if (!card.schedule || card.schedule.algorithm !== SRAlgorithmType.FSRS) return 1;
    const schedule = card.schedule.scheduleData as ISerializedFSRSScheduleData;
    const lastReview = Date.parse(schedule.lastReview);
    if (!Number.isFinite(lastReview) || !Number.isFinite(schedule.stability)) return 1;
    const elapsed = Math.max(0, (now - lastReview) / DAY);
    return Math.pow(1 + (19 / 81) * (elapsed / Math.max(0.001, schedule.stability)), -0.5);
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function dependencyConfidence(edge: KnowledgeDependencyEdge): number {
    if (typeof edge.confidence === "number") return clamp01(edge.confidence);
    if (edge.source === "manual") return 1;
    if (edge.source === "compiler") return 0.86;
    return 0.92;
}

function localDateKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** Simulates the known review load without mutating schedules. */
export function simulateReviewLoad(
    collection: CollectionData,
    reviewLog: ReviewLogData,
    options: { now?: number; days?: number } = {},
): ReviewLoadSimulation {
    const now = options.now ?? Date.now();
    const days = Math.max(1, Math.min(365, Math.round(options.days ?? 7)));
    const responseMs = averageReviewDuration(reviewLog);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const counts = Array.from({ length: days }, () => ({ cards: 0, overdue: 0 }));
    for (const card of Object.values(collection.cards)) {
        if (card.deletedAt || card.state !== "active") continue;
        const dueAt = cardDueAt(card);
        let index = 0;
        let overdue = false;
        if (card.queue !== "new" && dueAt !== null) {
            index = Math.floor((dueAt - start.valueOf()) / DAY);
            overdue = dueAt < now;
            if (index < 0) index = 0;
        }
        if (index >= days) continue;
        counts[index].cards++;
        if (overdue) counts[index].overdue++;
    }
    const buckets = counts.map((bucket, index) => ({
        date: localDateKey(start.valueOf() + index * DAY),
        cards: bucket.cards,
        minutes: Math.ceil((bucket.cards * responseMs) / 60_000),
        overdue: bucket.overdue,
    }));
    const peak = buckets.reduce<ReviewLoadBucket | null>(
        (best, bucket) => (!best || bucket.cards > best.cards ? bucket : best),
        null,
    );
    return {
        days,
        totalCards: buckets.reduce((sum, bucket) => sum + bucket.cards, 0),
        totalMinutes: Math.ceil(
            (buckets.reduce((sum, bucket) => sum + bucket.cards, 0) * responseMs) / 60_000,
        ),
        peakCards: peak?.cards ?? 0,
        peakDate: peak?.cards ? peak.date : null,
        buckets,
    };
}

/**
 * Measures whether a recent prerequisite review correlates with better dependent-card results.
 * Laplace smoothing prevents tiny samples from being presented as certainty.
 */
export function analyzeDependencyImpact(
    collection: CollectionData,
    reviewLog: ReviewLogData,
    edges: readonly KnowledgeDependencyEdge[],
    recentWindowDays = 7,
): DependencyImpact[] {
    const noteIdsByPath = new Map<string, Set<string>>();
    for (const note of Object.values(collection.notes)) {
        if (note.deletedAt || !note.source.path) continue;
        const ids = noteIdsByPath.get(note.source.path) ?? new Set<string>();
        ids.add(note.id);
        noteIdsByPath.set(note.source.path, ids);
    }
    const entries = Object.values(reviewLog.entries)
        .filter((entry) => !entry.deletedAt && entry.mode === "review")
        .sort((left, right) => left.reviewedAt - right.reviewedAt);
    const windowMs = Math.max(1, recentWindowDays) * DAY;
    return edges.map((edge) => {
        const prerequisiteIds = noteIdsByPath.get(edge.prerequisitePath) ?? new Set<string>();
        const dependentIds = noteIdsByPath.get(edge.dependentPath) ?? new Set<string>();
        const prerequisiteReviews = entries.filter((entry) => prerequisiteIds.has(entry.noteId));
        const dependentReviews = entries.filter((entry) => dependentIds.has(entry.noteId));
        let withTotal = 0;
        let withSuccess = 0;
        let withoutTotal = 0;
        let withoutSuccess = 0;
        for (const entry of dependentReviews) {
            const hasRecentPrerequisite = prerequisiteReviews.some(
                (candidate) =>
                    candidate.reviewedAt <= entry.reviewedAt &&
                    candidate.reviewedAt >= entry.reviewedAt - windowMs,
            );
            if (hasRecentPrerequisite) {
                withTotal++;
                if (entry.rating >= 3) withSuccess++;
            } else {
                withoutTotal++;
                if (entry.rating >= 3) withoutSuccess++;
            }
        }
        const withRate = (withSuccess + 1) / (withTotal + 2);
        const withoutRate = (withoutSuccess + 1) / (withoutTotal + 2);
        const uplift = withRate - withoutRate;
        const sampleConfidence = clamp01((withTotal + withoutTotal) / 16);
        const declaredConfidence = dependencyConfidence(edge);
        return {
            prerequisitePath: edge.prerequisitePath,
            dependentPath: edge.dependentPath,
            reason: edge.reason,
            source: edge.source,
            strength: clamp01(
                0.45 + Math.max(-0.35, Math.min(0.45, uplift)) + declaredConfidence * 0.2,
            ),
            confidence: clamp01(declaredConfidence * (0.35 + sampleConfidence * 0.65)),
            withPrerequisite: { reviews: withTotal, successRate: withRate },
            withoutPrerequisite: { reviews: withoutTotal, successRate: withoutRate },
            uplift,
        };
    });
}

export function planReviewSession(
    collection: CollectionData,
    reviewLog: ReviewLogData,
    options: {
        now?: number;
        minutes?: number;
        aheadDays?: number;
        intelligentBacklog?: boolean;
        priorityForDeck?: (deckPath: string) => number;
        aheadDaysForDeck?: (deckPath: string) => number;
        dependencyEdges?: KnowledgeDependencyEdge[];
        dependencyRetentionThreshold?: number;
        /** Optional queue boundary after daily deck limits; graph prerequisites may cross it. */
        baselineCardIds?: ReadonlySet<string>;
    } = {},
): {
    plan: ReviewSessionPlan;
    cards: PlannedCard[];
    rankedCards: PlannedCard[];
    excluded: ExcludedPlannedCard[];
} {
    const now = options.now ?? Date.now();
    const responseMs = averageReviewDuration(reviewLog);
    const activeCards = Object.values(collection.cards).filter(
        (card) => !card.deletedAt && card.state === "active",
    );
    const notePath = (card: CollectionCard): string =>
        collection.notes[card.noteId]?.source.path ?? "";
    const eligible = new Set<string>();
    const dueById = new Map<string, number | null>();
    for (const card of activeCards) {
        const dueAt = cardDueAt(card);
        dueById.set(card.id, dueAt);
        if (!card.legacyStableId) continue;
        const aheadDays = Math.max(
            0,
            options.aheadDays ?? 0,
            options.aheadDaysForDeck?.(card.deckPath) ?? 0,
        );
        const horizon = now + aheadDays * DAY;
        const insideBaseline = !options.baselineCardIds || options.baselineCardIds.has(card.id);
        if (insideBaseline && (card.queue === "new" || (dueAt !== null && dueAt <= horizon))) {
            eligible.add(card.id);
        }
    }

    const dependencyBoost = new Map<string, number>();
    const unlocks = new Map<string, Set<string>>();
    const blockedBy = new Map<string, Set<string>>();
    const threshold = Math.max(0.7, Math.min(0.99, options.dependencyRetentionThreshold ?? 0.88));
    const cardsByPath = new Map<string, CollectionCard[]>();
    for (const card of activeCards) {
        const path = notePath(card);
        if (path) cardsByPath.set(path, [...(cardsByPath.get(path) ?? []), card]);
    }
    for (const edge of options.dependencyEdges ?? []) {
        const dependents = cardsByPath.get(edge.dependentPath) ?? [];
        const prerequisites = cardsByPath.get(edge.prerequisitePath) ?? [];
        const dependentReady = dependents.some((card) => eligible.has(card.id));
        if (!dependentReady || prerequisites.length === 0) continue;
        const weakPrerequisites = prerequisites.filter((card) => {
            if (!card.legacyStableId) return false;
            const dueAt = dueById.get(card.id) ?? null;
            return (
                card.queue === "new" ||
                (dueAt !== null && dueAt <= now) ||
                card.lapses >= 2 ||
                cardRetrievability(card, now) < threshold
            );
        });
        if (!weakPrerequisites.length) continue;
        for (const card of weakPrerequisites) {
            eligible.add(card.id);
            const risk = 1 - cardRetrievability(card, now);
            const confidence = dependencyConfidence(edge);
            dependencyBoost.set(
                card.id,
                (dependencyBoost.get(card.id) ?? 0) + (420 + risk * 180) * confidence,
            );
            const paths = unlocks.get(card.id) ?? new Set<string>();
            paths.add(edge.dependentPath);
            unlocks.set(card.id, paths);
        }
        for (const card of dependents) {
            if (!eligible.has(card.id)) continue;
            const paths = blockedBy.get(card.id) ?? new Set<string>();
            paths.add(edge.prerequisitePath);
            blockedBy.set(card.id, paths);
        }
    }

    const cards = activeCards
        .filter((card) => eligible.has(card.id))
        .map((card): PlannedCard => {
            const dueAt = cardDueAt(card);
            const priority = options.priorityForDeck?.(card.deckPath) ?? 0;
            const overdueDays = dueAt === null ? 0 : Math.max(0, (now - dueAt) / DAY);
            const memoryRisk = 1 - cardRetrievability(card, now);
            const learningBoost =
                card.queue === "learning" || card.queue === "relearning" ? 500 : 0;
            const graphBoost = dependencyBoost.get(card.id) ?? 0;
            const dependencyPenalty = (blockedBy.get(card.id)?.size ?? 0) * 90;
            const scoreBreakdown: ReviewPlanScoreBreakdown = {
                importance: priority * 1000,
                learning: learningBoost,
                dependency: graphBoost,
                blocked: -dependencyPenalty,
                overdue: options.intelligentBacklog === false ? 0 : overdueDays * 12,
                forgetting: options.intelligentBacklog === false ? 0 : memoryRisk * 100,
                schedule: -(dueAt !== null && dueAt > now ? (dueAt - now) / DAY : 0),
                manual: 0,
            };
            const score =
                scoreBreakdown.importance +
                scoreBreakdown.learning +
                scoreBreakdown.overdue +
                scoreBreakdown.forgetting +
                scoreBreakdown.dependency +
                scoreBreakdown.blocked +
                scoreBreakdown.schedule +
                scoreBreakdown.manual;
            const relatedEdges = (options.dependencyEdges ?? []).filter(
                (edge) =>
                    edge.prerequisitePath === notePath(card) ||
                    edge.dependentPath === notePath(card),
            );
            return {
                card,
                dueAt,
                priority,
                score,
                dependencyBoost: graphBoost,
                unlocks: [...(unlocks.get(card.id) ?? [])],
                blockedBy: [...(blockedBy.get(card.id) ?? [])],
                scoreBreakdown,
                prerequisiteConfidence: relatedEdges.length
                    ? Math.max(...relatedEdges.map(dependencyConfidence))
                    : 0,
            };
        })
        .sort((left, right) => right.score - left.score || (left.dueAt ?? 0) - (right.dueAt ?? 0));
    const availableCards = cards.length;
    const maxCards = options.minutes
        ? Math.max(1, Math.floor((options.minutes * 60_000) / responseMs))
        : availableCards;
    const selected = cards.slice(0, maxCards);
    const selectedIds = new Set(selected.map((item) => item.card.id));
    const excluded: ExcludedPlannedCard[] = [];
    for (const item of cards) {
        if (selectedIds.has(item.card.id)) continue;
        excluded.push({
            card: item.card,
            dueAt: item.dueAt,
            code: "time-limit",
            headline: "Outside the session budget",
            detail: "This card is ready, but lower-ranked cards do not fit the selected time budget.",
        });
    }
    for (const card of Object.values(collection.cards)) {
        if (
            card.deletedAt ||
            selectedIds.has(card.id) ||
            cards.some((item) => item.card.id === card.id)
        )
            continue;
        const dueAt = cardDueAt(card);
        if (card.state === "suspended") {
            excluded.push({
                card,
                dueAt,
                code: "suspended",
                headline: "Suspended",
                detail: "Resume the card to include it in a study plan.",
            });
            continue;
        }
        if (card.state === "buried") {
            excluded.push({
                card,
                dueAt,
                code: "buried",
                headline: "Buried",
                detail: "The card is temporarily hidden from today’s queue.",
            });
            continue;
        }
        if (!card.legacyStableId) {
            excluded.push({
                card,
                dueAt,
                code: "missing-stable-id",
                headline: "Index is incomplete",
                detail: "Rebuild the card index to make this card reviewable.",
            });
            continue;
        }
        const aheadDays = Math.max(
            0,
            options.aheadDays ?? 0,
            options.aheadDaysForDeck?.(card.deckPath) ?? 0,
        );
        const ready = card.queue === "new" || (dueAt !== null && dueAt <= now + aheadDays * DAY);
        if (ready && options.baselineCardIds && !options.baselineCardIds.has(card.id)) {
            excluded.push({
                card,
                dueAt,
                code: "daily-limit",
                headline: "Daily limit reached",
                detail: "The deck’s daily limit reserved this card for a later session.",
            });
        } else {
            const daysUntil = dueAt === null ? null : Math.max(1, Math.ceil((dueAt - now) / DAY));
            excluded.push({
                card,
                dueAt,
                code: "not-due",
                headline: "Not due today",
                detail:
                    daysUntil === null
                        ? "This new card is outside today’s limits."
                        : `Scheduled in ${daysUntil} ${daysUntil === 1 ? "day" : "days"}.`,
            });
        }
    }
    const dueCards = selected.filter(
        ({ card, dueAt }) => card.queue !== "new" && dueAt !== null && dueAt <= now,
    ).length;
    const newCards = selected.filter(({ card }) => card.queue === "new").length;
    const aheadCards = selected.filter(({ dueAt }) => dueAt !== null && dueAt > now).length;
    const backlogCards = selected.filter(
        ({ card, dueAt }) => card.queue !== "new" && dueAt !== null && dueAt < now - DAY,
    ).length;
    const estimatedMinutes = Math.ceil((selected.length * responseMs) / 60_000);
    return {
        cards: selected,
        rankedCards: cards,
        excluded,
        plan: {
            availableCards,
            selectedCards: selected.length,
            dueCards,
            newCards,
            backlogCards,
            aheadCards,
            estimatedMinutes,
            averageResponseMs: responseMs,
            finishAt: now + selected.length * responseMs,
        },
    };
}

/** Keeps the exact legacy Card objects selected by the file-native plan. */
export function applyStableIdPlanToQueue(
    deckTree: Deck,
    stableIds: ReadonlySet<string> | readonly string[],
): Deck {
    const ordered = Array.isArray(stableIds) ? stableIds : [...stableIds];
    const rank = new Map(ordered.map((id, index) => [id, index]));
    const filtered = deckTree.copyWithRepItemFilter(
        (item) => item instanceof Card && item.stableId !== null && rank.has(item.stableId),
    );
    const sortDeck = (deck: Deck): void => {
        const score = (card: Card) => rank.get(card.stableId ?? "") ?? Number.MAX_SAFE_INTEGER;
        deck.dueRepItems.sort((left, right) => score(left) - score(right));
        deck.newRepItems.sort((left, right) => score(left) - score(right));
        for (const child of deck.subdecks) sortDeck(child);
        const firstRank = (candidate: Deck) =>
            Math.min(
                Number.MAX_SAFE_INTEGER,
                ...candidate
                    .getFlattenedRepItemArray(RepItemState.AnyItem, true)
                    .filter((item): item is Card => item instanceof Card)
                    .map(score),
            );
        deck.subdecks.sort((left, right) => firstRank(left) - firstRank(right));
    };
    sortDeck(filtered);
    return filtered;
}

/** Sorts due cards by urgency and applies a global time budget without mutating the shared tree. */
export function applyTimeBudgetToQueue(
    deckTree: Deck,
    minutes: number,
    averageResponseMs: number,
): Deck {
    if (minutes <= 0) return deckTree;
    const maxCards = Math.max(1, Math.floor((minutes * 60_000) / Math.max(500, averageResponseMs)));
    const all = [...new Set(deckTree.getFlattenedRepItemArray(RepItemState.AnyItem, true))]
        .filter((item): item is Card => item instanceof Card)
        .sort((left, right) => {
            if (left.isNew !== right.isNew) return left.isNew ? 1 : -1;
            const leftDue = left.scheduleInfo?.dueDateAsUnix ?? Number.MAX_SAFE_INTEGER;
            const rightDue = right.scheduleInfo?.dueDateAsUnix ?? Number.MAX_SAFE_INTEGER;
            return leftDue - rightDue;
        });
    const selected = new Set(all.slice(0, maxCards));
    return deckTree.copyWithRepItemFilter((item) => item instanceof Card && selected.has(item));
}
