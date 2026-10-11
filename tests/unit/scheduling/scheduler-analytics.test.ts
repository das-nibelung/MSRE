import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import {
    analyzeScheduler,
    intervalForRetention,
    optimizeFsrsWeights,
} from "src/scheduling/fsrs/scheduler-analytics";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 11);

function fsrsSchedule(stability = 10, dueOffset = 2) {
    return {
        algorithm: SRAlgorithmType.FSRS,
        scheduleData: {
            dueDate: new Date(now + dueOffset * DAY).toISOString(),
            interval: 10,
            stability,
            difficulty: 6,
            state: 2,
            reps: 3,
            lapses: 1,
            learningSteps: 0,
            lastReview: new Date(now - 10 * DAY).toISOString(),
        },
    };
}

describe("scheduler analytics", () => {
    const reviewLog = {
        schemaVersion: 1,
        revision: 1,
        updatedAt: now,
        entries: Object.fromEntries(
            Array.from({ length: 24 }, (_, index) => [
                `review-${index}`,
                {
                    id: `review-${index}`,
                    cardId: "card-1",
                    noteId: "note-1",
                    rating: (index % 5 === 0 ? 1 : 3) as 1 | 3,
                    reviewedAt: now - index * DAY,
                    durationMs: 1200,
                    mode: "review" as const,
                    previousSchedule: fsrsSchedule(8, -index),
                    nextSchedule: fsrsSchedule(10, 2),
                },
            ]),
        ),
    };

    test("optimizes a complete FSRS weight vector and reports prediction quality", () => {
        const result = optimizeFsrsWeights(reviewLog);
        expect(result.sampleSize).toBe(24);
        expect(result.weights.length).toBeGreaterThanOrEqual(19);
        expect(result.stabilityScale).toBeGreaterThanOrEqual(0.5);
        expect(result.logLoss).toBeGreaterThanOrEqual(0);
        expect(result.rmse).toBeGreaterThanOrEqual(0);
    });

    test("builds retention, workload, topic, template, and area analytics", () => {
        const collection = {
            schemaVersion: 10,
            revision: 1,
            updatedAt: now,
            noteTypes: {
                basic: {
                    id: "basic",
                    version: 1,
                    name: "Basic",
                    kind: "standard" as const,
                    fields: [] as never[],
                    templates: [{ id: "front", name: "Forward" }],
                    css: "",
                    createdAt: 0,
                    updatedAt: 0,
                },
            },
            deckOptions: {},
            decks: {},
            notes: {
                "note-1": {
                    id: "note-1",
                    noteTypeId: "basic",
                    fields: {},
                    tags: [] as string[],
                    source: {
                        kind: "managed" as const,
                        path: "card.md",
                        questionId: null as string | null,
                    },
                    createdAt: 0,
                    updatedAt: 0,
                },
            },
            cards: {
                "card-1": {
                    id: "card-1",
                    noteId: "note-1",
                    templateId: "front",
                    variantId: "base",
                    stableKey: "note-1::front::base",
                    ordinal: 0,
                    deckId: "deck-1",
                    deckPath: "Medicine/Cardiology",
                    state: "active" as const,
                    buriedUntil: null as number | null,
                    flag: 0 as const,
                    queue: "review" as const,
                    schedule: fsrsSchedule(),
                    reps: 10,
                    lapses: 2,
                    lastReviewAt: now - DAY,
                    legacyStableId: null as string | null,
                    createdAt: 0,
                    updatedAt: 0,
                },
            },
            conflicts: {},
        };
        const metrics = analyzeScheduler(
            collection as never,
            reviewLog,
            [{ id: "area", name: "Medicine", deckPaths: ["Medicine"], pinned: true }],
            now,
        );
        expect(metrics.trueRetention).toBeCloseTo(19 / 24);
        expect(metrics.activity).toHaveLength(84);
        expect(metrics.forecast).toHaveLength(90);
        expect(metrics.difficultTopics[0].name).toBe("Medicine/Cardiology");
        expect(metrics.problematicTemplates[0].name).toBe("Basic · Forward");
        expect(metrics.knowledgeAreaEfficiency[0].reviews).toBe(24);
    });

    test("higher retention produces a shorter interval", () => {
        expect(intervalForRetention(30, 0.95)).toBeLessThan(intervalForRetention(30, 0.85));
    });

    test("handles an empty or partially migrated history without invented data", () => {
        const emptyLog = { schemaVersion: 1, revision: 0, updatedAt: 0, entries: {} };
        const optimized = optimizeFsrsWeights(emptyLog, [1, 2, 3, 4]);
        expect(optimized.sampleSize).toBe(0);
        expect(optimized.weights.slice(0, 4)).toEqual([1, 2, 3, 4]);

        const metrics = analyzeScheduler(
            {
                schemaVersion: 10,
                revision: 0,
                updatedAt: 0,
                noteTypes: {},
                deckOptions: {},
                decks: {},
                notes: {},
                cards: {},
                conflicts: {},
            },
            emptyLog,
            [{ id: "empty", name: "Empty", deckPaths: ["Empty"], pinned: false }],
            now,
        );
        expect(metrics.trueRetention).toBe(0);
        expect(metrics.averageResponseMs).toBe(0);
        expect(metrics.averageRetrievability).toBe(0);
        expect(metrics.knowledgeAreaEfficiency[0]).toEqual({
            name: "Empty",
            reviews: 0,
            retention: 0,
        });
    });

    test("ignores deleted, non-FSRS, and malformed review samples", () => {
        const malformed = {
            schemaVersion: 1,
            revision: 1,
            updatedAt: now,
            entries: {
                deleted: { ...reviewLog.entries["review-0"], id: "deleted", deletedAt: now },
                missing: {
                    ...reviewLog.entries["review-1"],
                    id: "missing",
                    previousSchedule: null as null,
                    durationMs: null as number | null,
                },
                legacy: {
                    ...reviewLog.entries["review-2"],
                    id: "legacy",
                    previousSchedule: {
                        algorithm: SRAlgorithmType.SM_2_OSR,
                        scheduleData: { dueDate: "-", interval: 1, latestEase: 250 },
                    },
                },
                invalid: {
                    ...reviewLog.entries["review-3"],
                    id: "invalid",
                    previousSchedule: {
                        ...fsrsSchedule(),
                        scheduleData: { ...fsrsSchedule().scheduleData, lastReview: "invalid" },
                    },
                },
            },
        };
        expect(optimizeFsrsWeights(malformed as never).sampleSize).toBe(0);
    });

    test("keeps malformed and out-of-window cards out of workload projections", () => {
        const card = (id: string, overrides: Record<string, unknown> = {}) => ({
            id,
            noteId: "missing-note",
            templateId: "missing-template",
            variantId: "base",
            stableKey: `${id}::base`,
            ordinal: 0,
            deckId: "deck",
            deckPath: "",
            state: "active",
            buriedUntil: null as number | null,
            flag: 0,
            queue: "review",
            schedule: null as ReturnType<typeof fsrsSchedule> | null,
            reps: 0,
            lapses: 1,
            lastReviewAt: null as number | null,
            legacyStableId: null as string | null,
            createdAt: 0,
            updatedAt: 0,
            ...overrides,
        });
        const invalidDue = fsrsSchedule();
        invalidDue.scheduleData.dueDate = "invalid";
        const outside = fsrsSchedule();
        outside.scheduleData.dueDate = new Date(now + 120 * DAY).toISOString();
        const invalidReview = fsrsSchedule();
        invalidReview.scheduleData.lastReview = "invalid";
        const collection = {
            schemaVersion: 10,
            revision: 0,
            updatedAt: now,
            noteTypes: {},
            deckOptions: {},
            decks: {},
            notes: {},
            cards: {
                plain: card("plain"),
                legacy: card("legacy", {
                    schedule: {
                        algorithm: SRAlgorithmType.SM_2_OSR,
                        scheduleData: { dueDate: "-", interval: 1, latestEase: 250 },
                    },
                }),
                inactive: card("inactive", { schedule: fsrsSchedule(), state: "suspended" }),
                invalidDue: card("invalid-due", { schedule: invalidDue }),
                outside: card("outside", { schedule: outside, deckPath: "Exact" }),
                invalidReview: card("invalid-review", { schedule: invalidReview }),
                deleted: card("deleted", { deletedAt: now }),
            },
            conflicts: {},
        };
        const oldReview = {
            ...reviewLog.entries["review-0"],
            id: "old",
            reviewedAt: now - 200 * DAY,
            durationMs: null as number | null,
        };
        const metrics = analyzeScheduler(
            collection as never,
            { schemaVersion: 1, revision: 0, updatedAt: now, entries: { old: oldReview } },
            [{ id: "exact", name: "Exact", deckPaths: ["Exact"], pinned: false }],
            now,
        );
        expect(metrics.activity.every((day) => day.count === 0)).toBe(true);
        expect(metrics.forecast.reduce((sum, day) => sum + day.count, 0)).toBe(1);
        expect(metrics.averageResponseMs).toBe(0);
        expect(metrics.problematicTemplates[0].name).toBe("missing-template");
    });
});
