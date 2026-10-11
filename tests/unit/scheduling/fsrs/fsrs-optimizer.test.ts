import { ReviewLogData } from "src/data/collection/collection-types";
import {
    optimizeFsrsWeightsFull,
    optimizeFsrsWeightsInBackground,
    runFsrsOptimization,
} from "src/scheduling/fsrs/fsrs-optimizer";

const DAY = 86_400_000;

function history(): ReviewLogData {
    const entries: ReviewLogData["entries"] = {};
    for (let cardIndex = 0; cardIndex < 8; cardIndex++) {
        for (let reviewIndex = 0; reviewIndex < 12; reviewIndex++) {
            const id = `${cardIndex}-${reviewIndex}`;
            entries[id] = {
                id,
                cardId: `card-${cardIndex}`,
                noteId: `note-${cardIndex}`,
                rating: (reviewIndex % 7 === 0 ? 1 : reviewIndex % 5 === 0 ? 4 : 3) as 1 | 3 | 4,
                reviewedAt: Date.UTC(2026, 0, 1) + (reviewIndex * 2 + cardIndex) * DAY,
                durationMs: 8_000,
                mode: "review",
                previousSchedule: null,
                nextSchedule: null,
            };
        }
    }
    return { schemaVersion: 1, revision: 1, updatedAt: Date.now(), entries };
}

describe("full FSRS optimizer", () => {
    test("optimizes every FSRS-6 parameter and protects a chronological validation split", () => {
        const result = optimizeFsrsWeightsFull(history());

        expect(result.weights).toHaveLength(21);
        expect(result.trainingSize).toBeGreaterThan(50);
        expect(result.validationSize).toBeGreaterThan(0);
        expect(result.logLoss).toBeLessThanOrEqual(result.baselineLogLoss);
        expect(result.validationLogLoss).toBeLessThanOrEqual(
            result.baselineValidationLogLoss * 1.01,
        );
        expect(result.sampleSize).toBe(result.trainingSize + result.validationSize);
    });

    test("kernel is deterministic and does not mutate worker payload", () => {
        const payload = {
            histories: [
                [
                    { reviewedAt: 0, rating: 3 },
                    { reviewedAt: 0, rating: 1 },
                    { reviewedAt: 0, rating: 2 },
                    { reviewedAt: DAY, rating: 2 },
                    { reviewedAt: DAY * 3, rating: 1 },
                    { reviewedAt: DAY * 4, rating: 3 },
                    { reviewedAt: DAY * 8, rating: 4 },
                ],
                [],
            ],
            initialWeights: [
                0.2, 1.3, 2.3, 8.3, 6.4, 0.8, 3, 0.01, 1.8, 0.16, 0.8, 1.4, 0.06, 0.26, 1.6, 0.6,
                1.8, 0.5, 0.09, 0.06, 0,
            ],
            bounds: Array.from({ length: 21 }, (_, index) =>
                index === 20 ? ([0, 100] as [number, number]) : ([0.001, 100] as [number, number]),
            ),
            validationRatio: 0.2,
            passes: 1,
        };
        const before = JSON.stringify(payload);
        expect(runFsrsOptimization(payload)).toEqual(runFsrsOptimization(payload));
        expect(JSON.stringify(payload)).toBe(before);
    });

    test("handles an empty collection and clamps invalid starting parameters", () => {
        const result = runFsrsOptimization({
            histories: [],
            initialWeights: [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
            bounds: [
                [0.1, 1],
                [0.1, 1],
            ],
            validationRatio: 0.2,
            passes: 99,
        });

        expect(result.weights).toEqual([0.1, 1]);
        expect(result.sampleSize).toBe(0);
        expect(result.improvement).toBe(0);
        expect(result.recommended).toBe(false);
    });

    test("ignores deleted/non-review entries and falls back when workers are unavailable", async () => {
        const log = history();
        log.entries.deleted = {
            ...log.entries["0-0"],
            id: "deleted",
            deletedAt: Date.now(),
        };
        log.entries.preview = {
            ...log.entries["0-0"],
            id: "preview",
            mode: "cram",
        };

        const result = await optimizeFsrsWeightsInBackground(log, []);
        expect(result.weights).toHaveLength(21);
        expect(result.sampleSize).toBeGreaterThan(0);
    });
});
