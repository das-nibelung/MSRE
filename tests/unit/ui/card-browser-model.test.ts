import { Card } from "src/data/data-structures/card/card";
import {
    CardBrowserRecord,
    filterCardBrowserRecords,
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
        }),
        record({
            id: "card-3",
            front: "<strong>Derivative</strong>",
            back: "Rate of change",
            notePath: "Math/Calculus.md",
            deckNames: ["Math"],
            state: "scheduled",
            dueDate: "2026-10-20",
        }),
    ];

    it("searches front, back, note path and deck names case-insensitively", () => {
        expect(filterCardBrowserRecords(records, "HABEAS", "all")).toEqual([records[0]]);
        expect(filterCardBrowserRecords(records, "blood glucose", "all")).toEqual([records[1]]);
        expect(filterCardBrowserRecords(records, "calculus", "all")).toEqual([records[2]]);
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
});
