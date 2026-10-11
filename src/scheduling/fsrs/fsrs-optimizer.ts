import { clipParameters, default_w as defaultFsrsWeights } from "ts-fsrs";

import { ReviewLogData } from "src/data/collection/collection-types";

export interface FsrsHistoryPoint {
    reviewedAt: number;
    rating: number;
}

export interface FsrsOptimizerPayload {
    histories: FsrsHistoryPoint[][];
    initialWeights: number[];
    bounds: Array<[number, number]>;
    validationRatio: number;
    passes: number;
}

export interface FsrsOptimizerResult {
    weights: number[];
    sampleSize: number;
    trainingSize: number;
    validationSize: number;
    baselineLogLoss: number;
    logLoss: number;
    baselineValidationLogLoss: number;
    validationLogLoss: number;
    rmse: number;
    validationRmse: number;
    improvement: number;
    recommended: boolean;
}

interface KernelMetrics {
    trainLoss: number;
    trainRmse: number;
    validationLoss: number;
    validationRmse: number;
    trainingSize: number;
    validationSize: number;
}

/**
 * Self-contained FSRS-6 optimizer kernel. Keeping every dependency inside the function lets the
 * same implementation run in a Blob worker on desktop and mobile without bundling a second file.
 */
export function runFsrsOptimization(payload: FsrsOptimizerPayload): FsrsOptimizerResult {
    const day = 86_400_000;
    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
    const probability = (weights: number[], elapsed: number, stability: number) => {
        const decay = -clamp(weights[20] || 0.1542, 0.1, 0.8);
        const factor = Math.exp(Math.log(0.9) / decay) - 1;
        return clamp(
            Math.pow(1 + (factor * elapsed) / Math.max(0.001, stability), decay),
            0.001,
            0.999,
        );
    };
    const initDifficulty = (weights: number[], rating: number) =>
        clamp(weights[4] - Math.exp((rating - 1) * weights[5]) + 1, 1, 10);
    const nextDifficulty = (weights: number[], difficulty: number, rating: number) => {
        const delta = -weights[6] * (rating - 3);
        const damped = delta * ((10 - difficulty) / 9);
        const initialEasy = initDifficulty(weights, 4);
        return clamp(weights[7] * initialEasy + (1 - weights[7]) * (difficulty + damped), 1, 10);
    };
    const nextState = (
        weights: number[],
        state: { stability: number; difficulty: number } | null,
        elapsed: number,
        rating: number,
    ) => {
        if (!state) {
            return {
                stability: Math.max(0.001, weights[Math.max(0, rating - 1)]),
                difficulty: initDifficulty(weights, rating),
            };
        }
        const { stability, difficulty } = state;
        const retrievability = probability(weights, elapsed, stability);
        let nextStability: number;
        if (elapsed === 0) {
            const increment =
                Math.pow(stability, -weights[19]) *
                Math.exp(weights[17] * (rating - 3 + weights[18]));
            nextStability = stability * (rating >= 2 ? Math.max(1, increment) : increment);
        } else if (rating === 1) {
            const failed =
                weights[11] *
                Math.pow(difficulty, -weights[12]) *
                (Math.pow(stability + 1, weights[13]) - 1) *
                Math.exp((1 - retrievability) * weights[14]);
            nextStability = Math.min(failed, stability / Math.exp(weights[17] * weights[18]));
        } else {
            const hardPenalty = rating === 2 ? weights[15] : 1;
            const easyBonus = rating === 4 ? weights[16] : 1;
            nextStability =
                stability *
                (1 +
                    Math.exp(weights[8]) *
                        (11 - difficulty) *
                        Math.pow(stability, -weights[9]) *
                        (Math.exp((1 - retrievability) * weights[10]) - 1) *
                        hardPenalty *
                        easyBonus);
        }
        return {
            stability: clamp(nextStability, 0.001, 36_500),
            difficulty: nextDifficulty(weights, difficulty, rating),
        };
    };
    const evaluate = (weights: number[]): KernelMetrics => {
        let trainLoss = 0;
        let trainSquared = 0;
        let validationLoss = 0;
        let validationSquared = 0;
        let trainingSize = 0;
        let validationSize = 0;
        for (const history of payload.histories) {
            let state: { stability: number; difficulty: number } | null = null;
            let previousAt = history[0]?.reviewedAt ?? 0;
            const validationStart = Math.max(
                2,
                Math.floor(history.length * (1 - payload.validationRatio)),
            );
            for (let index = 0; index < history.length; index++) {
                const point = history[index];
                const elapsed = Math.max(0, (point.reviewedAt - previousAt) / day);
                if (state) {
                    const predicted = probability(weights, elapsed, state.stability);
                    const actual = point.rating === 1 ? 0 : 1;
                    const loss = -(
                        actual * Math.log(predicted) +
                        (1 - actual) * Math.log(1 - predicted)
                    );
                    const squared = Math.pow(predicted - actual, 2);
                    if (index >= validationStart && history.length >= 5) {
                        validationLoss += loss;
                        validationSquared += squared;
                        validationSize++;
                    } else {
                        trainLoss += loss;
                        trainSquared += squared;
                        trainingSize++;
                    }
                }
                state = nextState(weights, state, elapsed, point.rating);
                previousAt = point.reviewedAt;
            }
        }
        return {
            trainLoss: trainingSize ? trainLoss / trainingSize : 0,
            trainRmse: trainingSize ? Math.sqrt(trainSquared / trainingSize) : 0,
            validationLoss: validationSize ? validationLoss / validationSize : 0,
            validationRmse: validationSize ? Math.sqrt(validationSquared / validationSize) : 0,
            trainingSize,
            validationSize,
        };
    };

    let weights = payload.initialWeights.map((value, index) =>
        clamp(value, payload.bounds[index][0], payload.bounds[index][1]),
    );
    const baseline = evaluate(weights);
    let best = baseline;
    const passes = Math.max(1, Math.min(5, payload.passes));
    for (let pass = 0; pass < passes; pass++) {
        const step = 0.18 / (pass + 1);
        for (let index = 0; index < weights.length; index++) {
            const [min, max] = payload.bounds[index];
            const distance = Math.max(
                (max - min) * step * 0.08,
                Math.abs(weights[index]) * step,
                0.001,
            );
            let selected = weights;
            let selectedMetrics = best;
            for (const direction of [-1, 1]) {
                const candidate = [...weights];
                candidate[index] = clamp(candidate[index] + distance * direction, min, max);
                const metrics = evaluate(candidate);
                const validationSafe =
                    metrics.validationSize === 0 ||
                    metrics.validationLoss <= baseline.validationLoss * 1.01;
                if (validationSafe && metrics.trainLoss + 1e-7 < selectedMetrics.trainLoss) {
                    selected = candidate;
                    selectedMetrics = metrics;
                }
            }
            weights = selected;
            best = selectedMetrics;
        }
    }
    const reference = baseline.validationSize ? baseline.validationLoss : baseline.trainLoss;
    const candidate = best.validationSize ? best.validationLoss : best.trainLoss;
    const improvement = reference > 0 ? (reference - candidate) / reference : 0;
    return {
        weights,
        sampleSize: best.trainingSize + best.validationSize,
        trainingSize: best.trainingSize,
        validationSize: best.validationSize,
        baselineLogLoss: baseline.trainLoss,
        logLoss: best.trainLoss,
        baselineValidationLogLoss: baseline.validationLoss,
        validationLogLoss: best.validationLoss,
        rmse: best.trainRmse,
        validationRmse: best.validationRmse,
        improvement,
        recommended: best.trainingSize >= 50 && improvement >= 0.005,
    };
}

function historiesFromReviewLog(reviewLog: ReviewLogData): FsrsHistoryPoint[][] {
    const grouped = new Map<string, FsrsHistoryPoint[]>();
    for (const entry of Object.values(reviewLog.entries)) {
        if (entry.deletedAt || entry.mode !== "review") continue;
        const history = grouped.get(entry.cardId) ?? [];
        history.push({ reviewedAt: entry.reviewedAt, rating: entry.rating });
        grouped.set(entry.cardId, history);
    }
    return [...grouped.values()]
        .map((history) => history.sort((left, right) => left.reviewedAt - right.reviewedAt))
        .filter((history) => history.length >= 2);
}

function createPayload(
    reviewLog: ReviewLogData,
    currentWeights: number[] | null = null,
): FsrsOptimizerPayload {
    const weights = clipParameters(
        [...(currentWeights?.length ? currentWeights : defaultFsrsWeights)],
        1,
        true,
    );
    const bounds: Array<[number, number]> = [
        [0.001, 100],
        [0.001, 100],
        [0.001, 100],
        [0.001, 100],
        [1, 10],
        [0.001, 4],
        [0.001, 4],
        [0.001, 0.75],
        [0, 4.5],
        [0, 0.8],
        [0.001, 3.5],
        [0.001, 5],
        [0.001, 0.25],
        [0.001, 0.9],
        [0, 4],
        [0, 1],
        [1, 6],
        [0, 2],
        [0, 2],
        [0.01, 0.8],
        [0.1, 0.8],
    ];
    return {
        histories: historiesFromReviewLog(reviewLog),
        initialWeights: weights,
        bounds: bounds.slice(0, weights.length),
        validationRatio: 0.2,
        passes: 2,
    };
}

export function optimizeFsrsWeightsFull(
    reviewLog: ReviewLogData,
    currentWeights: number[] | null = null,
): FsrsOptimizerResult {
    return runFsrsOptimization(createPayload(reviewLog, currentWeights));
}

/** Runs the exact same optimizer in a worker and falls back safely where workers are unavailable. */
export async function optimizeFsrsWeightsInBackground(
    reviewLog: ReviewLogData,
    currentWeights: number[] | null = null,
): Promise<FsrsOptimizerResult> {
    const payload = createPayload(reviewLog, currentWeights);
    if (
        typeof Worker === "undefined" ||
        typeof Blob === "undefined" ||
        typeof URL === "undefined" ||
        typeof URL.createObjectURL !== "function"
    ) {
        return await Promise.resolve().then(() => runFsrsOptimization(payload));
    }
    const source = `self.onmessage = function(event) { try { const result = (${runFsrsOptimization.toString()})(event.data); self.postMessage({ result: result }); } catch (error) { self.postMessage({ error: String(error && error.message || error) }); } };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    try {
        return await new Promise<FsrsOptimizerResult>((resolve, reject) => {
            const worker = new Worker(url);
            worker.onmessage = (
                event: MessageEvent<{ result?: FsrsOptimizerResult; error?: string }>,
            ) => {
                worker.terminate();
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.result);
            };
            worker.onerror = (event) => {
                worker.terminate();
                reject(new Error(event.message));
            };
            worker.postMessage(payload);
        });
    } catch {
        return runFsrsOptimization(payload);
    } finally {
        URL.revokeObjectURL(url);
    }
}
