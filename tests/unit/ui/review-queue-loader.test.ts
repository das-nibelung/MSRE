import { RepItemStorageInfo } from "src/data/data-store/base/rep-item-storage-info";
import { Card } from "src/data/data-structures/card/card";
import { Deck } from "src/data/data-structures/deck/deck";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { RepItemState } from "src/scheduling/algorithms/base/repetition-item";
import {
    applyCardLifecycleToQueue,
    applyCustomStudyOptionsToQueue,
    applyDeckOptionsToQueue,
} from "src/ui/review-queue-loader";

describe("deck option queue limits", () => {
    it("limits each deck independently without mutating the shared tree", () => {
        const root = new Deck("root", null);
        const medicine = root.getOrCreateDeck(new TopicPath(["flashcards", "Medicine"]));
        medicine.newRepItems = Array.from({ length: 5 }, () => new Card());
        medicine.dueRepItems = Array.from({ length: 6 }, () => new Card());

        const limited = applyDeckOptionsToQueue(root, "#flashcards", (deckPath) => ({
            id: "preset",
            name: deckPath || "Default",
            newCardsPerDay: deckPath === "Medicine" ? 2 : 20,
            reviewsPerDay: deckPath === "Medicine" ? 3 : 200,
            desiredRetention: 0.9,
            newCardOrder: "sequential",
            createdAt: 0,
            updatedAt: 0,
        }));

        const limitedMedicine = limited.getDeck(new TopicPath(["flashcards", "Medicine"]));
        expect(limitedMedicine?.newRepItems).toHaveLength(2);
        expect(limitedMedicine?.dueRepItems).toHaveLength(3);
        expect(medicine.newRepItems).toHaveLength(5);
        expect(medicine.dueRepItems).toHaveLength(6);
    });
});

describe("persistent card lifecycle queue filter", () => {
    it("removes suspended and buried cards without mutating the shared tree", () => {
        const root = new Deck("root", null);
        const deck = root.getOrCreateDeck(new TopicPath(["flashcards"]));
        const active = new Card({
            cardIdx: 0,
            storageInfo: new RepItemStorageInfo("cards.md", "hash", "^active"),
        });
        const suspended = new Card({
            cardIdx: 0,
            storageInfo: new RepItemStorageInfo("cards.md", "hash", "^suspended"),
        });
        deck.newRepItems = [active, suspended];

        const filtered = applyCardLifecycleToQueue(root, (stableId) => stableId !== "^suspended:0");

        expect(filtered.getFlattenedRepItemArray(RepItemState.AnyItem, true)).toEqual([active]);
        expect(root.getFlattenedRepItemArray(RepItemState.AnyItem, true)).toEqual([
            active,
            suspended,
        ]);
    });
});

describe("custom study queue", () => {
    it("scopes a temporary session to one deck, state, and card limit", () => {
        const root = new Deck("root", null);
        const medicine = root.getOrCreateDeck(new TopicPath(["flashcards", "Medicine"]));
        const law = root.getOrCreateDeck(new TopicPath(["flashcards", "Law"]));
        medicine.newRepItems = [new Card(), new Card()];
        medicine.dueRepItems = [new Card(), new Card(), new Card()];
        law.dueRepItems = [new Card(), new Card()];

        const filtered = applyCustomStudyOptionsToQueue(root, {
            targetDeckPath: ["flashcards", "Medicine"],
            scope: "due",
            limit: 2,
            order: "due-first",
        });

        const filteredMedicine = filtered.getDeck(new TopicPath(["flashcards", "Medicine"]));
        expect(filteredMedicine?.dueRepItems).toHaveLength(2);
        expect(filteredMedicine?.newRepItems).toHaveLength(0);
        expect(filtered.getDeck(new TopicPath(["flashcards", "Law"]))).toBeNull();
        expect(medicine.dueRepItems).toHaveLength(3);
        expect(medicine.newRepItems).toHaveLength(2);
    });
});
