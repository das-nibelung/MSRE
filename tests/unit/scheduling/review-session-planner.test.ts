import { ReviewLogData } from "src/data/collection/collection-types";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import {
    averageReviewDuration,
    cardDueAt,
    planReviewSession,
} from "src/scheduling/review-session-planner";

const now = Date.UTC(2026, 9, 11, 12);
const DAY = 86_400_000;

function card(id: string, deckPath: string, dueOffset: number | null, queue = "review") {
    return {
        id,
        noteId: `note-${id}`,
        templateId: "template",
        variantId: "base",
        stableKey: `${id}::base`,
        ordinal: 0,
        deckId: `deck-${deckPath}`,
        deckPath,
        state: "active" as const,
        buriedUntil: null as number | null,
        flag: 0 as const,
        queue: queue as "new" | "review",
        schedule:
            dueOffset === null
                ? null
                : {
                      algorithm: SRAlgorithmType.FSRS,
                      scheduleData: {
                          dueDate: new Date(now + dueOffset * DAY).toISOString(),
                          interval: 7,
                          stability: 7,
                          difficulty: 5,
                          state: 2,
                          reps: 3,
                          lapses: 0,
                          learningSteps: 0,
                          lastReview: new Date(now - 7 * DAY).toISOString(),
                      },
                  },
        reps: 3,
        lapses: 0,
        lastReviewAt: now - DAY,
        legacyStableId: `^${id}:0`,
        createdAt: 0,
        updatedAt: 0,
    };
}

describe("review session planner", () => {
    const reviewLog = {
        schemaVersion: 1,
        revision: 1,
        updatedAt: now,
        entries: Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
                `r-${index}`,
                {
                    id: `r-${index}`,
                    cardId: "old",
                    noteId: "note",
                    rating: 3 as const,
                    reviewedAt: now - index * DAY,
                    durationMs: 30_000,
                    mode: "review" as const,
                    previousSchedule: null as null,
                    nextSchedule: null as null,
                },
            ]),
        ),
    };

    test("plans to available time and prioritizes important overdue knowledge", () => {
        const cards = {
            urgent: card("urgent", "Medicine", -10),
            normal: card("normal", "Law", -1),
            ahead: card("ahead", "Law", 2),
            new: card("new", "Law", null, "new"),
        };
        const { plan, cards: selected } = planReviewSession(
            {
                schemaVersion: 12,
                revision: 1,
                updatedAt: now,
                noteTypes: {},
                deckOptions: {},
                decks: {},
                notes: {},
                cards,
                editHistory: {},
                conflicts: {},
            },
            reviewLog,
            {
                now,
                minutes: 1,
                aheadDays: 3,
                intelligentBacklog: true,
                priorityForDeck: (path) => (path === "Medicine" ? 10 : 0),
            },
        );

        expect(averageReviewDuration(reviewLog)).toBe(30_000);
        expect(plan.selectedCards).toBe(2);
        expect(plan.availableCards).toBe(4);
        expect(selected[0].card.id).toBe("urgent");
        expect(plan.estimatedMinutes).toBe(1);
        expect(plan.finishAt).toBe(now + 60_000);
    });

    test("uses safe duration samples and accepts deck-specific review ahead", () => {
        const log: ReviewLogData = {
            ...reviewLog,
            entries: {
                long: { ...reviewLog.entries["r-0"], id: "long", durationMs: 900_000 },
                deleted: {
                    ...reviewLog.entries["r-1"],
                    id: "deleted",
                    durationMs: 1,
                    deletedAt: now,
                },
                missing: { ...reviewLog.entries["r-2"], id: "missing", durationMs: null },
                zero: { ...reviewLog.entries["r-3"], id: "zero", durationMs: 0 },
            },
        };
        const scheduled = card("scheduled", "Math", 2);
        const brokenMemory = {
            ...card("broken-memory", "Math", -1),
            schedule: {
                ...scheduled.schedule!,
                scheduleData: {
                    ...scheduled.schedule!.scheduleData,
                    dueDate: new Date(now - DAY).toISOString(),
                    lastReview: "invalid",
                    stability: Number.NaN,
                },
            },
        };
        const inactive = { ...card("inactive", "Math", -1), state: "suspended" as const };
        const future = card("future", "Law", 5);
        const collection = {
            schemaVersion: 12,
            revision: 1,
            updatedAt: now,
            noteTypes: {},
            deckOptions: {},
            decks: {},
            notes: {},
            cards: { scheduled, brokenMemory, inactive, future },
            editHistory: {},
            conflicts: {},
        };

        expect(averageReviewDuration(log)).toBe(120_000);
        expect(cardDueAt({ schedule: null })).toBeNull();
        expect(
            cardDueAt({
                schedule: {
                    ...scheduled.schedule!,
                    scheduleData: { ...scheduled.schedule!.scheduleData, dueDate: "invalid" },
                },
            }),
        ).toBeNull();

        const { plan, cards } = planReviewSession(collection, log, {
            now,
            intelligentBacklog: false,
            aheadDaysForDeck: (path) => (path === "Math" ? 3 : 0),
        });
        expect(cards.map(({ card }) => card.id)).toEqual(["broken-memory", "scheduled"]);
        expect(plan.aheadCards).toBe(1);
        expect(plan.dueCards).toBe(1);
        expect(plan.backlogCards).toBe(0);
        expect(plan.averageResponseMs).toBe(120_000);
    });

    test("uses defaults for an empty review log and counts learning backlog", () => {
        const learning = {
            ...card("learning", "Medicine", -3),
            queue: "learning" as const,
        };
        const fresh = card("fresh", "Medicine", null, "new");
        const secondFresh = card("second-fresh", "Medicine", null, "new");
        const { plan, cards } = planReviewSession(
            {
                schemaVersion: 12,
                revision: 1,
                updatedAt: now,
                noteTypes: {},
                deckOptions: {},
                decks: {},
                notes: {},
                cards: { learning, fresh, secondFresh },
                editHistory: {},
                conflicts: {},
            },
            { schemaVersion: 1, revision: 1, updatedAt: now, entries: {} },
            { now, minutes: 0 },
        );

        expect(cards[0].card.id).toBe("learning");
        expect(plan.selectedCards).toBe(3);
        expect(plan.dueCards).toBe(1);
        expect(plan.newCards).toBe(2);
        expect(plan.backlogCards).toBe(1);
        expect(plan.averageResponseMs).toBe(12_000);
    });

    test("uses the current time when a plan has no explicit options", () => {
        const { plan } = planReviewSession(
            {
                schemaVersion: 12,
                revision: 1,
                updatedAt: now,
                noteTypes: {},
                deckOptions: {},
                decks: {},
                notes: {},
                cards: {},
                editHistory: {},
                conflicts: {},
            },
            { schemaVersion: 1, revision: 1, updatedAt: now, entries: {} },
        );
        expect(plan.finishAt).toBeGreaterThan(0);
        expect(plan.selectedCards).toBe(0);
    });
});
