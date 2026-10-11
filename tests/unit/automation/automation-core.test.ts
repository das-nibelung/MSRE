import {
    calculatePublicStatistics,
    deckPathAllowed,
    findPublicCards,
    requestDeckPaths,
    safeAutomationId,
} from "src/automation/automation-core";
import { CollectionData, ReviewLogData } from "src/data/collection/collection-types";

const collection = {
    notes: {
        n1: { id: "n1", fields: { front: "Heart rhythm", back: "Sinus" }, tags: ["exam"] },
    },
    cards: {
        c1: {
            id: "c1",
            noteId: "n1",
            deckPath: "Medicine/Cardiology",
            state: "active",
            queue: "new",
        },
    },
    decks: { d1: { id: "d1", path: "Medicine/Cardiology" } },
} as unknown as CollectionData;

describe("automation core", () => {
    it("validates request identifiers and deck scopes", () => {
        expect(safeAutomationId("request-1")).toBe("request-1");
        expect(safeAutomationId("../escape")).toBeNull();
        expect(deckPathAllowed("Medicine/Cardiology", ["Medicine"])).toBe(true);
        expect(deckPathAllowed("Law", ["Medicine"])).toBe(false);
    });

    it("extracts every deck from batch imports", () => {
        expect(
            requestDeckPaths({
                version: 1,
                id: "batch",
                operation: "import-cards",
                payload: {
                    source: "test",
                    cards: [
                        { deckPath: "Medicine", front: "A" },
                        { deckPath: "Law", front: "B" },
                    ],
                },
                source: "api",
                requestedAt: 1,
            }),
        ).toEqual(["Medicine", "Law"]);
    });

    it("finds serializable card records and calculates statistics", () => {
        const records = findPublicCards(collection, { query: "rhythm", deckPath: "Medicine" });
        expect(records).toHaveLength(1);
        records[0].note.tags.push("changed");
        expect(collection.notes.n1.tags).toEqual(["exam"]);
        expect(
            calculatePublicStatistics(collection, {
                entries: { r1: { id: "r1" } },
            } as unknown as ReviewLogData),
        ).toMatchObject({ notes: 1, cards: 1, decks: 1, newCards: 1, reviews: 1 });
    });
});
