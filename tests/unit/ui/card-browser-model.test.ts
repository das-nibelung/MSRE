import { Card } from "src/data/data-structures/card/card";
import {
    annotateCardBrowserDiagnostics,
    CardBrowserRecord,
    extractCardMediaPaths,
    filterCardBrowserRecords,
    getCardBrowserDeckNames,
    getCardBrowserTags,
    sortCardBrowserRecords,
    validateCardBrowserQuery,
} from "src/ui/card-browser/card-browser-model";

function record(overrides: Partial<CardBrowserRecord>): CardBrowserRecord {
    return {
        card: {} as Card,
        id: "card-1",
        front: "What is habeas corpus?",
        back: "Judicial review of detention",
        notePath: "Law/Procedure.md",
        deckNames: ["Law/Procedure"],
        state: "new",
        dueDate: null,
        interval: null,
        ease: null,
        lifecycleState: "active",
        flag: 0,
        tags: [],
        cardType: "basic",
        ...overrides,
    };
}

describe("card browser filtering", () => {
    const records = [
        record({}),
        record({
            id: "card-2",
            front: "Insulin",
            back: "Lowers blood glucose",
            notePath: "Medicine/Endocrinology.md",
            deckNames: ["Medicine"],
            state: "due",
            dueDate: "2026-10-10",
            interval: 4,
            ease: 250,
        }),
        record({
            id: "card-3",
            front: "<strong>Derivative</strong>",
            back: "Rate of change",
            notePath: "Math/Calculus.md",
            deckNames: ["Math"],
            state: "scheduled",
            dueDate: "2026-10-20",
            interval: 12,
            ease: 220,
        }),
    ];

    it("searches front, back, note path and deck names case-insensitively", () => {
        expect(filterCardBrowserRecords(records, "HABEAS", "all")).toEqual([records[0]]);
        expect(filterCardBrowserRecords(records, "blood glucose", "all")).toEqual([records[1]]);
        expect(filterCardBrowserRecords(records, "calculus", "all")).toEqual([records[2]]);
        const tagged = record({ id: "tagged", tags: ["high-yield"] });
        expect(filterCardBrowserRecords([...records, tagged], "high-yield", "all")).toEqual([
            tagged,
        ]);
    });

    it("ignores HTML tags when searching", () => {
        expect(filterCardBrowserRecords(records, "derivative", "all")).toEqual([records[2]]);
        expect(filterCardBrowserRecords(records, "strong", "all")).toEqual([]);
    });

    it("filters by scheduling state", () => {
        expect(filterCardBrowserRecords(records, "", "new")).toEqual([records[0]]);
        expect(filterCardBrowserRecords(records, "", "due")).toEqual([records[1]]);
        expect(filterCardBrowserRecords(records, "", "scheduled")).toEqual([records[2]]);
    });

    it("filters persistent suspended and buried states separately", () => {
        const suspended = record({ id: "suspended", lifecycleState: "suspended", state: "due" });
        const buried = record({ id: "buried", lifecycleState: "buried", state: "new" });
        const lifecycleRecords = [...records, suspended, buried];

        expect(filterCardBrowserRecords(lifecycleRecords, "", "suspended")).toEqual([suspended]);
        expect(filterCardBrowserRecords(lifecycleRecords, "", "buried")).toEqual([buried]);
        expect(filterCardBrowserRecords(lifecycleRecords, "", "due")).toEqual([records[1]]);
    });

    it("combines deck and note filters", () => {
        expect(filterCardBrowserRecords(records, "", "all", "Medicine")).toEqual([records[1]]);
        expect(filterCardBrowserRecords(records, "", "all", "all", "Math/Calculus.md")).toEqual([
            records[2],
        ]);
    });

    it("filters by note tag and card flag", () => {
        const marked = record({ id: "marked", tags: ["medicine"], flag: 1 });
        const candidates = [...records, marked];
        expect(filterCardBrowserRecords(candidates, "", "all", "all", null, "medicine")).toEqual([
            marked,
        ]);
        expect(filterCardBrowserRecords(candidates, "", "all", "all", null, "all", "1")).toEqual([
            marked,
        ]);
    });

    it("filters by card type after the other browser filters", () => {
        const cloze = record({ id: "cloze", cardType: "cloze" });
        expect(
            filterCardBrowserRecords(
                [...records, cloze],
                "",
                "all",
                "all",
                null,
                "all",
                "all",
                "cloze",
            ),
        ).toEqual([cloze]);
    });

    it("returns a unique alphabetical deck list", () => {
        expect(
            getCardBrowserDeckNames([
                ...records,
                record({ id: "card-4", deckNames: ["Medicine", "Biology"] }),
            ]),
        ).toEqual(["Biology", "Law/Procedure", "Math", "Medicine"]);
    });

    it("returns a unique alphabetical tag list", () => {
        expect(
            getCardBrowserTags([
                record({ id: "a", tags: ["zeta", "alpha"] }),
                record({ id: "b", tags: ["alpha", "medicine"] }),
            ]),
        ).toEqual(["alpha", "medicine", "zeta"]);
    });

    it("sorts cards without mutating the loaded index order", () => {
        expect(sortCardBrowserRecords(records, "due").map(({ id }) => id)).toEqual([
            "card-2",
            "card-1",
            "card-3",
        ]);
        expect(sortCardBrowserRecords(records, "front").map(({ id }) => id)).toEqual([
            "card-3",
            "card-2",
            "card-1",
        ]);
        expect(sortCardBrowserRecords(records, "interval").map(({ id }) => id)).toEqual([
            "card-1",
            "card-2",
            "card-3",
        ]);
        expect(records.map(({ id }) => id)).toEqual(["card-1", "card-2", "card-3"]);
    });

    it("supports Anki-style structured search terms", () => {
        const clinical = record({
            id: "clinical",
            deckNames: ["Medicine/Cardiology"],
            areaNames: ["Medicine"],
            noteTypeName: "Cloze",
            state: "due",
            flag: 1,
            reps: 14,
            lapses: 4,
            retention: 0.81,
            hasMedia: true,
            tags: ["exam"],
            fields: { diagnosis: "Acute myocardial infarction" },
            fieldNames: { diagnosis: "Diagnosis" },
        });
        const candidates = [...records, clinical];

        for (const query of [
            "deck:Cardiology",
            "area:Medicine",
            "type:Cloze",
            "is:due reps:>10 lapses:>3",
            "retention:<0.85 has:media",
            "flag:red tag:exam",
            'field:Diagnosis="myocardial infarction"',
        ]) {
            expect(filterCardBrowserRecords(candidates, query, "all"), query).toEqual([clinical]);
        }
    });

    it("supports boolean groups, negation and parentheses", () => {
        const medicine = record({
            id: "medicine",
            deckNames: ["Medicine"],
            tags: ["exam"],
            state: "due",
        });
        const law = record({ id: "law", deckNames: ["Law"], tags: ["archive"] });
        const candidates = [medicine, law];

        expect(filterCardBrowserRecords(candidates, "deck:Medicine OR deck:Law", "all")).toEqual(
            candidates,
        );
        expect(
            filterCardBrowserRecords(candidates, "(deck:Medicine OR deck:Law) -tag:archive", "all"),
        ).toEqual([medicine]);
        expect(filterCardBrowserRecords(candidates, "NOT is:due", "all")).toEqual([law]);
    });

    it("filters by dates, rating and FSRS memory state", () => {
        const advanced = record({
            id: "advanced",
            createdAt: Date.parse("2026-10-01T12:00:00Z"),
            updatedAt: Date.parse("2026-10-08T12:00:00Z"),
            lastReviewAt: Date.parse("2026-10-10T12:00:00Z"),
            dueDate: "2026-10-12",
            lastRating: 3,
            difficulty: 6.2,
            stability: 28,
        });
        for (const query of [
            "created:2026-10-01",
            "updated:>=2026-10-08",
            "reviewed:2026-10-10",
            "due:2026-10-12",
            "rating:good",
            "difficulty:>6 stability:>=28",
        ]) {
            expect(filterCardBrowserRecords([advanced], query, "all"), query).toEqual([advanced]);
        }
    });

    it("finds orphan cards and missing local media", () => {
        const broken = record({
            id: "broken",
            hasSource: false,
            hasMedia: true,
            missingMediaPaths: ["media/missing.png"],
        });
        const [annotated] = annotateCardBrowserDiagnostics([broken]);
        expect(filterCardBrowserRecords([annotated], "is:orphan", "all")).toEqual([annotated]);
        expect(filterCardBrowserRecords([annotated], "has:missing-media", "all")).toEqual([
            annotated,
        ]);
        expect(filterCardBrowserRecords([annotated], "-has:source", "all")).toEqual([annotated]);
    });

    it("extracts Obsidian, Markdown and HTML media paths", () => {
        expect(
            extractCardMediaPaths(
                '![[diagram.png|300]] ![x](audio/term.mp3) <video src="clips/demo.mp4">',
            ),
        ).toEqual(["diagram.png", "audio/term.mp3", "clips/demo.mp4"]);
    });

    it("validates incomplete queries without throwing", () => {
        expect(validateCardBrowserQuery('(deck:"Medicine')).toBe("Unclosed quote");
        expect(validateCardBrowserQuery("deck:Medicine)")).toBe("Unexpected closing parenthesis");
        expect(validateCardBrowserQuery("(deck:Medicine OR deck:Law)")).toBeNull();
    });

    it("marks duplicate and empty cards for diagnostics and query filtering", () => {
        const duplicateA = record({ id: "duplicate-a", front: "Same", back: "Answer" });
        const duplicateB = record({ id: "duplicate-b", front: " same ", back: "answer" });
        const empty = record({ id: "empty", front: "<br>", back: "" });
        const annotated = annotateCardBrowserDiagnostics([duplicateA, duplicateB, empty]);

        expect(
            filterCardBrowserRecords(annotated, "is:duplicate", "all").map(({ id }) => id),
        ).toEqual(["duplicate-a", "duplicate-b"]);
        expect(filterCardBrowserRecords(annotated, "is:empty", "all").map(({ id }) => id)).toEqual([
            "empty",
        ]);
    });

    it("sorts advanced scheduling columns in both directions", () => {
        const candidates = [
            record({ id: "low", reps: 2, lapses: 0, retention: 0.72 }),
            record({ id: "high", reps: 12, lapses: 3, retention: 0.94 }),
        ];
        expect(sortCardBrowserRecords(candidates, "reps").map(({ id }) => id)).toEqual([
            "low",
            "high",
        ]);
        expect(sortCardBrowserRecords(candidates, "retention", "desc").map(({ id }) => id)).toEqual(
            ["high", "low"],
        );
    });

    it("filters a 100,000-card collection without recursive evaluation", () => {
        const large = Array.from({ length: 100_000 }, (_, index) =>
            record({
                id: `large-${index}`,
                deckNames: [index % 2 === 0 ? "Medicine" : "Law"],
                tags: index % 100 === 0 ? ["exam"] : [],
                reps: index % 30,
            }),
        );
        const result = filterCardBrowserRecords(large, "deck:Medicine tag:exam reps:>=10", "all");
        expect(result.length).toBeGreaterThan(0);
        expect(
            result.every(
                (candidate) =>
                    candidate.deckNames[0] === "Medicine" &&
                    candidate.tags.includes("exam") &&
                    (candidate.reps ?? 0) >= 10,
            ),
        ).toBe(true);
    });
});
