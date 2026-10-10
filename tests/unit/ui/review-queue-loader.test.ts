import { Card } from "src/data/data-structures/card/card";
import { Deck } from "src/data/data-structures/deck/deck";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { applyDeckOptionsToQueue } from "src/ui/review-queue-loader";

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
