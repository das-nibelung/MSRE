import { CardType } from "src/data/data-structures/card/questions/question";
import {
    NativeCardStore,
    normalizeManagedDeckPath,
    serializeNativeCard,
} from "src/data/native-card-store";
import { DEFAULT_DATA, PluginData } from "src/data/plugin-data";
import { DEFAULT_SETTINGS } from "src/data/settings";
import { parse } from "src/parser";

describe("native card storage", () => {
    it("normalizes human-readable nested deck names into valid tag paths", () => {
        expect(normalizeManagedDeckPath("  Medicine / Heart failure  ")).toBe(
            "Medicine/Heart-failure",
        );
        expect(normalizeManagedDeckPath("Law#[Civil]")).toBe("LawCivil");
    });

    it("serializes a basic card in the existing parser format", () => {
        const text = serializeNativeCard(
            {
                deckPath: "Medicine/Cardiology",
                type: "basic",
                front: "What does ECG measure?",
                back: "Electrical activity of the heart",
            },
            DEFAULT_SETTINGS,
        );

        expect(text).toContain("#flashcards/Medicine/Cardiology");
        const cards = parse(text, DEFAULT_SETTINGS);
        expect(cards).toHaveLength(1);
        expect(cards[0].cardType).toBe(CardType.MultiLineBasic);
        expect(cards[0].text).toBe("What does ECG measure?\n?\nElectrical activity of the heart");
    });

    it("embeds the stable collection id as an Obsidian block id", () => {
        const text = serializeNativeCard(
            { deckPath: "Law", type: "basic", front: "Question", back: "Answer" },
            DEFAULT_SETTINGS,
            "^sr-data-id-note-fixed",
        );

        expect(text).toContain("^sr-data-id-note-fixed");
        const parsed = parse(text, DEFAULT_SETTINGS);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].text).toContain("^sr-data-id-note-fixed");
    });

    it("serializes two-way and cloze cards", () => {
        const reversed = serializeNativeCard(
            { deckPath: "Languages", type: "reversed", front: "bonjour", back: "hello" },
            DEFAULT_SETTINGS,
        );
        expect(parse(reversed, DEFAULT_SETTINGS)[0].cardType).toBe(CardType.MultiLineReversed);

        const cloze = serializeNativeCard(
            {
                deckPath: "Biology",
                type: "cloze",
                front: "The mitochondrion is the powerhouse of the cell.",
                back: "powerhouse",
            },
            DEFAULT_SETTINGS,
        );
        expect(cloze).toContain("==powerhouse==");
        expect(parse(cloze, DEFAULT_SETTINGS)[0].cardType).toBe(CardType.Cloze);
    });

    it("manages knowledge areas without changing deck paths", async () => {
        const data: PluginData = { ...DEFAULT_DATA, managedDecks: [], knowledgeAreas: [] };
        const savePluginData = jest.fn().mockResolvedValue(undefined);
        const plugin = {
            dataManager: { data, savePluginData },
        } as never;
        const store = new NativeCardStore(plugin);

        const medicine = await store.createKnowledgeArea("  Medicine  ");
        await store.assignDeckToKnowledgeArea("Medicine/Cardiology", medicine.id);
        await store.setKnowledgeAreaPinned(medicine.id, true);

        expect(store.getKnowledgeAreas()).toEqual([
            expect.objectContaining({
                id: medicine.id,
                name: "Medicine",
                deckPaths: ["Medicine/Cardiology"],
                pinned: true,
            }),
        ]);

        await store.unassignDeckFromKnowledgeAreas("Medicine/Cardiology");
        expect(store.getKnowledgeAreas()[0].deckPaths).toEqual([]);
        await store.removeKnowledgeArea(medicine.id);
        expect(store.getKnowledgeAreas()).toEqual([]);
        expect(savePluginData).toHaveBeenCalledTimes(5);
    });
});
