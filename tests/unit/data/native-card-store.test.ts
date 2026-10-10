import { TFile } from "obsidian";

import { getBuiltinNoteTypes } from "src/data/collection/builtin-note-types";
import { CardType } from "src/data/data-structures/card/questions/question";
import {
    convertAnkiClozesToLegacy,
    NativeCardStore,
    normalizeManagedDeckPath,
    renderNoteTypeTemplate,
    serializeImageOcclusionBody,
    serializeNativeCard,
    serializeStructuredNoteBody,
} from "src/data/native-card-store";
import { DEFAULT_DATA, PluginData } from "src/data/plugin-data";
import { DEFAULT_SETTINGS } from "src/data/settings";
import { parse } from "src/parser";

function createTestFile(path: string): TFile {
    const segments = path.split("/");
    return Object.assign(new TFile(), {
        path,
        name: segments[segments.length - 1] ?? "",
    });
}

function createStoreHarness(noteType = getBuiltinNoteTypes()[1]) {
    const files = new Map<string, TFile>();
    const createdContents = new Map<string, string>();
    const modifiedContents = new Map<string, string>();
    const collectionStore = {
        getNoteType: jest.fn((id: string) => (id === noteType.id ? noteType : undefined)),
        createId: jest.fn(() => "note-fixed"),
        createNote: jest.fn().mockResolvedValue(undefined),
        updateNote: jest.fn().mockResolvedValue(undefined),
        ensureDeckPath: jest.fn().mockResolvedValue(undefined),
    };
    const vault = {
        getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
        createFolder: jest.fn().mockResolvedValue(undefined),
        create: jest.fn((path: string, contents: string) => {
            const file = createTestFile(path);
            files.set(path, file);
            createdContents.set(path, contents);
            return Promise.resolve(file);
        }),
        modify: jest.fn((file: TFile, contents: string) => {
            modifiedContents.set(file.path, contents);
            return Promise.resolve();
        }),
    };
    const sync = jest.fn().mockResolvedValue(undefined);
    const refreshCardBrowser = jest.fn();
    const plugin = {
        app: {
            vault,
            metadataCache: { getFileCache: jest.fn(() => ({})) },
        },
        dataManager: {
            data: {
                ...DEFAULT_DATA,
                settings: DEFAULT_SETTINGS,
                managedDecks: [],
                knowledgeAreas: [],
            },
            collectionStore,
            savePluginData: jest.fn().mockResolvedValue(undefined),
            applyManagedDecks: jest.fn(),
            osrCore: { finalizeLoad: jest.fn().mockResolvedValue(undefined) },
            sync,
        },
        uiManager: { tabViewManager: { refreshCardBrowser } },
    } as never;

    return {
        store: new NativeCardStore(plugin),
        collectionStore,
        vault,
        files,
        createdContents,
        modifiedContents,
        sync,
        refreshCardBrowser,
    };
}

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

    it("renders structured fields and converts Anki clozes for the scheduling bridge", () => {
        const basic = getBuiltinNoteTypes()[0];
        expect(
            renderNoteTypeTemplate("{{Front}} → {{back}}", basic, {
                front: "Question",
                back: "Answer",
            }),
        ).toBe("Question → Answer");
        expect(renderNoteTypeTemplate("{{back}}", basic, { front: "Question" })).toBe("");
        expect(convertAnkiClozesToLegacy("{{c1::Aspirin}} blocks {{c2::COX::enzyme}}")).toBe(
            "==Aspirin== blocks ==COX==",
        );
    });

    it("serializes multi-template and multi-cloze notes into reviewable questions", () => {
        const [, reversed, cloze] = getBuiltinNoteTypes();
        const standardBody = serializeStructuredNoteBody(
            reversed,
            { front: "bonjour", back: "hello" },
            DEFAULT_SETTINGS,
            "^structured-note",
        );
        expect(parse(`#flashcards\n\n${standardBody.body}\n`, DEFAULT_SETTINGS)).toHaveLength(2);
        expect(standardBody.legacyQuestionIds).toEqual({
            0: "^structured-note-1",
            1: "^structured-note-2",
        });

        const clozeBody = serializeStructuredNoteBody(
            cloze,
            { text: "{{c1::Aspirin}} blocks {{c2::COX}}", extra: "Pharmacology" },
            DEFAULT_SETTINGS,
            "^cloze-note",
        );
        const clozeQuestions = parse(`#flashcards\n\n${clozeBody.body}\n`, DEFAULT_SETTINGS);
        expect(clozeQuestions).toHaveLength(1);
        expect(clozeQuestions[0].text).toContain("==Aspirin== blocks ==COX==");
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

        const boldCloze = serializeNativeCard(
            {
                deckPath: "Biology",
                type: "cloze",
                front: "The cell has a nucleus.",
                back: "nucleus",
            },
            { ...DEFAULT_SETTINGS, clozePatterns: ["**"] },
        );
        expect(boldCloze).toContain("**nucleus**");
    });

    it("serializes labelled image occlusion siblings with typed-answer metadata", () => {
        const result = serializeImageOcclusionBody(
            [
                {
                    maskId: "heart",
                    questionPath: "Media/heart-question.png",
                    answerPath: "Media/heart-answer.png",
                    label: "Left ventricle",
                },
                {
                    maskId: "lung",
                    questionPath: "Media/lung-question.png",
                    answerPath: "Media/lung-answer.png",
                    label: "",
                },
            ],
            "^occlusion-note",
            DEFAULT_SETTINGS.multilineCardSeparator,
        );

        expect(parse(`#flashcards\n\n${result.body}\n`, DEFAULT_SETTINGS)).toHaveLength(2);
        expect(result.legacyQuestionIds).toEqual({
            0: "^occlusion-note-1",
            1: "^occlusion-note-2",
        });
        expect(result.body).toContain("sr-typed-answer: Left%20ventricle");
        expect(result.body).not.toContain("sr-typed-answer:  -->");
    });

    it("adds typed-answer mode only when the card explicitly requests it", () => {
        const reveal = serializeNativeCard(
            {
                deckPath: "Law",
                type: "basic",
                front: "Question",
                back: "Answer",
                answerMode: "reveal",
            },
            DEFAULT_SETTINGS,
        );
        const typed = serializeNativeCard(
            {
                deckPath: "Law",
                type: "basic",
                front: "Question",
                back: "Answer",
                answerMode: "type",
            },
            DEFAULT_SETTINGS,
        );
        const typedCloze = serializeNativeCard(
            {
                deckPath: "Medicine",
                type: "cloze",
                front: "The heart has four chambers.",
                back: "four",
                answerMode: "type",
            },
            DEFAULT_SETTINGS,
        );

        expect(reveal).not.toContain("sr-answer-mode");
        expect(typed).toContain("<!-- sr-answer-mode: type -->");
        expect(parse(typed, DEFAULT_SETTINGS)[0].cardType).toBe(CardType.MultiLineBasic);
        expect(typedCloze).toContain("==four==");
        expect(typedCloze).toContain("<!-- sr-answer-mode: type -->");
        expect(parse(typedCloze, DEFAULT_SETTINGS)[0].cardType).toBe(CardType.Cloze);
    });

    it("creates and updates grouped image occlusion notes", async () => {
        const harness = createStoreHarness();
        const draft = {
            deckPath: "Medicine/Anatomy",
            sourcePath: "Spaced Repetition/Media/anatomy.png",
            masksJson: JSON.stringify([{ id: "heart", label: "Heart" }]),
            mode: "hide-all" as const,
            assets: [
                {
                    maskId: "heart",
                    questionPath: "Spaced Repetition/Media/heart-q.png",
                    answerPath: "Spaced Repetition/Media/heart-a.png",
                    label: "Heart",
                },
            ],
            tags: ["anatomy"],
        };

        const file = await harness.store.createImageOcclusionNote(draft);
        expect(harness.createdContents.get(file.path)).toContain("sr-typed-answer: Heart");
        expect(harness.collectionStore.createNote).toHaveBeenCalledWith(
            expect.objectContaining({
                noteTypeId: "builtin-image-occlusion",
                legacyQuestionIds: { 0: "^sr-data-id-note-fixed-1" },
            }),
        );
        const inboxFile = await harness.store.createImageOcclusionNote({
            ...draft,
            deckPath: "",
            masksJson: "[]",
            assets: [],
        });
        expect(inboxFile.path).toContain("/Cards/Inbox/");

        await harness.store.updateImageOcclusionNote(
            {
                id: "note-fixed",
                noteTypeId: "builtin-image-occlusion",
                fields: {},
                tags: [],
                source: {
                    kind: "managed",
                    path: file.path,
                    questionId: null,
                },
                createdAt: 1,
                updatedAt: 1,
            },
            { ...draft, mode: "hide-one" },
        );
        expect(harness.modifiedContents.get(file.path)).toContain("Heart");
        expect(harness.collectionStore.updateNote).toHaveBeenCalledWith(
            "note-fixed",
            expect.objectContaining({ legacyQuestionIds: { 0: "^sr-data-id-note-fixed-1" } }),
        );
    });

    it("creates a structured note with stable ids for every template", async () => {
        const harness = createStoreHarness();

        const file = await harness.store.createStructuredNote({
            deckPath: "Languages / French",
            noteTypeId: "builtin-basic-and-reversed",
            fields: { front: "bonjour", back: "hello" },
        });

        expect(file.path).toBe("Spaced Repetition/Cards/Languages/French/bonjour.md");
        expect(harness.createdContents.get(file.path)).toContain("^sr-data-id-note-fixed-1");
        expect(harness.createdContents.get(file.path)).toContain("^sr-data-id-note-fixed-2");
        expect(harness.collectionStore.createNote).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "note-fixed",
                noteTypeId: "builtin-basic-and-reversed",
                deckPath: "Languages/French",
                legacyQuestionIds: {
                    0: "^sr-data-id-note-fixed-1",
                    1: "^sr-data-id-note-fixed-2",
                },
            }),
        );
        expect(harness.sync).toHaveBeenCalledTimes(1);
        expect(harness.refreshCardBrowser).toHaveBeenCalledTimes(1);
    });

    it("updates a structured note without changing its stable source ids", async () => {
        const harness = createStoreHarness();
        const sourcePath = "Spaced Repetition/Cards/Languages/French/bonjour.md";
        const file = createTestFile(sourcePath);
        harness.files.set(sourcePath, file);

        const result = await harness.store.updateStructuredNote(
            {
                id: "note-fixed",
                noteTypeId: "builtin-basic-and-reversed",
                fields: { front: "bonjour", back: "hello" },
                tags: [],
                source: {
                    kind: "managed",
                    path: sourcePath,
                    questionId: "^sr-data-id-note-fixed",
                },
                createdAt: 1,
                updatedAt: 1,
            },
            {
                deckPath: "Languages/French",
                noteTypeId: "builtin-basic-and-reversed",
                fields: { front: "salut", back: "hi" },
            },
        );

        expect(result).toBe(file);
        expect(harness.modifiedContents.get(sourcePath)).toContain("salut");
        expect(harness.modifiedContents.get(sourcePath)).toContain("^sr-data-id-note-fixed-1");
        expect(harness.collectionStore.updateNote).toHaveBeenCalledWith(
            "note-fixed",
            expect.objectContaining({
                fields: { front: "salut", back: "hi" },
                legacyQuestionIds: {
                    0: "^sr-data-id-note-fixed-1",
                    1: "^sr-data-id-note-fixed-2",
                },
            }),
        );
    });

    it("rejects invalid structured notes before writing files", async () => {
        const harness = createStoreHarness();

        await expect(
            harness.store.createStructuredNote({
                deckPath: "Languages",
                noteTypeId: "builtin-basic-and-reversed",
                fields: { front: "", back: "hello" },
            }),
        ).rejects.toThrow("required-field-empty:front");
        await expect(
            harness.store.createStructuredNote({
                deckPath: "Languages",
                noteTypeId: "missing",
                fields: {},
            }),
        ).rejects.toThrow("note-type-not-found");
        expect(harness.vault.create).not.toHaveBeenCalled();
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
