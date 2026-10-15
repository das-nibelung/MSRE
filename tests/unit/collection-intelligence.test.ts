import { ReviewLogEntry } from "src/data/collection/collection-types";
import {
    analyzeCollectionIntelligence,
    CollectionIntelligenceInput,
} from "src/intelligence/collection-intelligence";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";

function record(
    id: string,
    noteId: string,
    front: string,
    back: string,
    extra: Partial<CardBrowserRecord> = {},
): CardBrowserRecord {
    return {
        card: {} as CardBrowserRecord["card"],
        id,
        front,
        back,
        notePath: `${noteId}.md`,
        deckNames: ["Test"],
        state: "scheduled",
        dueDate: null,
        interval: 3,
        ease: 250,
        lifecycleState: "active",
        flag: 0,
        tags: [],
        cardType: "basic",
        noteId,
        collectionCardId: id,
        ...extra,
    };
}

function input(records: CardBrowserRecord[]): CollectionIntelligenceInput {
    return {
        records,
        reviewLog: [],
        duplicateGroups: [],
        relatedByNoteId: {},
        relations: [],
    };
}

describe("collection intelligence", () => {
    test("reports semantic duplicate groups", () => {
        const data = input([
            record("a", "note-a", "What is ATP?", "Cell energy currency"),
            record("b", "note-b", "Define ATP", "Cell energy currency"),
        ]);
        data.duplicateGroups = [["note-a", "note-b"]];
        const report = analyzeCollectionIntelligence(data);
        expect(report.counts.duplicate).toBe(1);
        expect(report.findings.find((item) => item.kind === "duplicate")?.cardIds).toEqual([
            "a",
            "b",
        ]);
    });

    test("finds conflicting answers to similar questions", () => {
        const data = input([
            record("a", "note-a", "Can this medicine be used during pregnancy?", "It is allowed"),
            record(
                "b",
                "note-b",
                "Can this medicine be used during pregnancy?",
                "It is not allowed",
            ),
        ]);
        data.relatedByNoteId = {
            "note-a": [{ id: "note-b", score: 0.9 }],
            "note-b": [{ id: "note-a", score: 0.9 }],
        };
        expect(analyzeCollectionIntelligence(data).counts.contradiction).toBe(1);
    });

    test("finds conflicting numeric facts even when the rest of the answer matches", () => {
        const data = input([
            record("a", "note-a", "What is the daily dose of medicine?", "The daily dose is 5 mg"),
            record("b", "note-b", "What is the daily dose of medicine?", "The daily dose is 10 mg"),
        ]);
        data.relatedByNoteId = {
            "note-a": [{ id: "note-b", score: 0.88 }],
            "note-b": [{ id: "note-a", score: 0.88 }],
        };
        expect(analyzeCollectionIntelligence(data).counts.contradiction).toBe(1);
    });

    test("proposes atomic drafts for list answers", () => {
        const report = analyzeCollectionIntelligence(
            input([
                record(
                    "a",
                    "note-a",
                    "What are the warning signs?",
                    "- Persistent fever\n- Sudden weakness\n- Severe shortness of breath",
                ),
            ]),
        );
        const split = report.findings.find((item) => item.kind === "split");
        expect(split?.drafts).toHaveLength(3);
        expect(split?.drafts[0].back).toBe("Persistent fever");
    });

    test("uses graph and review history to explain gaps and repeated errors", () => {
        const weak = record("card-a", "note-a", "What is the mechanism?", "A short answer", {
            lapses: 5,
            retention: 0.5,
        });
        const data = input([weak]);
        data.reviewLog = [1, 1, 3, 1].map(
            (rating, index) =>
                ({
                    id: `review-${index}`,
                    cardId: "card-a",
                    noteId: "note-a",
                    rating,
                    reviewedAt: index,
                    durationMs: null,
                    mode: "review",
                    previousSchedule: null,
                    nextSchedule: null,
                }) as ReviewLogEntry,
        );
        const report = analyzeCollectionIntelligence(data);
        expect(report.counts.gap).toBe(1);
        expect(report.counts.error).toBe(1);

        data.relations = [
            {
                fromPath: "prerequisite.md",
                toPath: "note-a.md",
                type: "prerequisite",
                source: "manual",
            },
        ];
        expect(analyzeCollectionIntelligence(data).counts.gap).toBe(0);
    });

    test("ignores inactive cards and explains blocking quality defects", () => {
        const report = analyzeCollectionIntelligence(
            input([
                record("empty", "note-empty", "", ""),
                record("inactive", "note-inactive", "Two questions? Really?", "Answer", {
                    lifecycleState: "suspended",
                }),
            ]),
        );
        expect(report.cards).toBe(1);
        const quality = report.findings.find((item) => item.cardIds.includes("empty"));
        expect(quality?.kind).toBe("atomicity");
        expect(quality?.severity).toBe("high");
        expect(quality?.summary).toContain("empty question");
    });

    test("splits prose facts but declines implausibly large batches", () => {
        const prose = record(
            "prose",
            "note-prose",
            "Recall the facts",
            "First independent statement. Second independent statement. Third independent statement.",
        );
        const huge = record(
            "huge",
            "note-huge",
            "Recall every item",
            Array.from({ length: 13 }, (_, index) => `- Independent item ${index + 1}`).join("\n"),
        );
        const report = analyzeCollectionIntelligence(input([prose, huge]));
        expect(
            report.findings.find((item) => item.cardIds.includes("prose") && item.kind === "split")
                ?.drafts,
        ).toHaveLength(3);
        expect(
            report.findings.some((item) => item.cardIds.includes("huge") && item.kind === "split"),
        ).toBe(false);
    });

    test("handles sparse metadata and filters irrelevant semantic and review candidates", () => {
        const sparse = record("sparse", "note-sparse", "Capital of France?", "Paris", {
            noteId: null,
            notePath: "",
            collectionCardId: null,
            lapses: 6,
            retention: 0.4,
            history: [1, 1, 3].map(
                (rating, index) =>
                    ({
                        id: `embedded-${index}`,
                        cardId: "sparse",
                        noteId: "",
                        rating,
                        reviewedAt: index,
                        durationMs: null,
                        mode: "review",
                        previousSchedule: null,
                        nextSchedule: null,
                    }) as ReviewLogEntry,
            ),
        });
        const data = input([
            sparse,
            record("one", "note-one", "Largest ocean?", "Pacific Ocean"),
            record("two", "note-two", "Largest ocean?", "Pacific Ocean"),
            record("three", "note-three", "Largest ocean?", "Pacific Ocean"),
            record("four", "note-four", "Largest ocean?", "Pacific Ocean"),
        ]);
        data.duplicateGroups = [
            ["missing-a", "missing-b"],
            ["note-one", "note-two", "note-three", "note-four"],
        ];
        data.relatedByNoteId = {
            "note-one": [
                { id: "missing", score: 0.8 },
                { id: "note-two", score: 0.2 },
            ],
        };
        data.reviewLog = [
            {
                id: "deleted",
                cardId: "one",
                noteId: "note-one",
                rating: 1,
                reviewedAt: 1,
                durationMs: null,
                mode: "review",
                previousSchedule: null,
                nextSchedule: null,
                deletedAt: 2,
            },
            {
                id: "cram",
                cardId: "one",
                noteId: "note-one",
                rating: 1,
                reviewedAt: 2,
                durationMs: null,
                mode: "cram",
                previousSchedule: null,
                nextSchedule: null,
            },
        ];
        const report = analyzeCollectionIntelligence(data);
        expect(report.counts.duplicate).toBe(1);
        expect(report.findings.find((item) => item.kind === "duplicate")?.severity).toBe("high");
        expect(report.counts.contradiction).toBe(0);
        expect(report.counts.gap).toBe(0);
        expect(report.counts.error).toBe(1);
    });

    test("keeps low-evidence review noise out while retaining an explainable gap", () => {
        const history = (ratings: number[]) =>
            ratings.map(
                (rating, index) =>
                    ({
                        id: `history-${ratings.join("")}-${index}`,
                        cardId: "history",
                        noteId: "history",
                        rating,
                        reviewedAt: index,
                        durationMs: null,
                        mode: "review",
                        previousSchedule: null,
                        nextSchedule: null,
                    }) as ReviewLogEntry,
            );
        const data = input([
            record("gap", "note-gap", "Why is the pathway important?", "It controls flow", {
                lapses: 3,
                retention: null,
            }),
            record("short", "note-short", "Short history?", "Yes", { history: history([1, 1]) }),
            record("rare", "note-rare", "Rare error?", "Yes", { history: history([1, 3, 3]) }),
            record("ratio", "note-ratio", "Low error ratio?", "Yes", {
                history: history([1, 1, 3, 3, 3, 3]),
            }),
            record("fallback", "note-fallback", "Name the items", "- Alpha item\n- Beta item", {
                notePath: "",
            }),
        ]);
        data.relatedByNoteId["note-gap"] = [{ id: "related", score: 0.6 }];
        const report = analyzeCollectionIntelligence(data);
        const gap = report.findings.find((item) => item.kind === "gap");
        expect(gap?.evidence).toContain("Retention unavailable");
        expect(report.counts.error).toBe(0);
        expect(
            report.findings.find(
                (item) => item.kind === "split" && item.cardIds.includes("fallback"),
            )?.drafts[0].sourceLabel,
        ).toBe("Split from card");
    });
});
