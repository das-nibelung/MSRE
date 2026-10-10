import { Card } from "src/data/data-structures/card/card";
import {
    CardBrowserRecord,
    filterCardBrowserRecords,
    getCardBrowserDeckNames,
    getCardBrowserTags,
    sortCardBrowserRecords,
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
});
