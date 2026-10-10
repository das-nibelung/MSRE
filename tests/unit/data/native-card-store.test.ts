import { TFile } from "obsidian";

import { getBuiltinNoteTypes } from "src/data/collection/builtin-note-types";
import { Card } from "src/data/data-structures/card/card";
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
        updateNativeNote: jest.fn().mockResolvedValue(undefined),
        ensureDeckPath: jest.fn().mockResolvedValue(undefined),
        moveNotesBySource: jest.fn().mockResolvedValue(undefined),
        setNotesTagsBySource: jest.fn().mockResolvedValue(undefined),
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
        read: jest.fn((file: TFile) =>
            Promise.resolve(
                createdContents.get(file.path) ?? "#flashcards/Inbox\n\nQuestion\n?\nAnswer",
            ),
        ),
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

    it("supports conditional fields and FrontSide in visual card templates", () => {
        const basic = getBuiltinNoteTypes()[0];
        expect(
            renderNoteTypeTemplate(
                "{{#Back}}Extra: {{Back}}{{/Back}}{{^Back}}No answer{{/Back}}",
                basic,
                { front: "Question", back: "Answer" },
            ),
        ).toBe("Extra: Answer");
        expect(
            renderNoteTypeTemplate(
                "{{FrontSide}}<hr>{{Back}}",
                basic,
                { front: "Question", back: "Answer" },
                "Rendered question",
            ),
        ).toBe("Rendered question<hr>Answer");
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
        expect(clozeBody.body).toContain("<br>Pharmacology");
    });

    it("serializes mixed generators and per-template typed answers from one note", () => {
        const noteType = {
            id: "mixed",
            version: 1,
            name: "Mixed",
            kind: "standard" as const,
            fields: [
                { id: "term", name: "Term", ordinal: 0, kind: "text" as const, required: true },
                { id: "answer", name: "Answer", ordinal: 1, kind: "text" as const, required: true },
                {
                    id: "case",
                    name: "Case",
                    ordinal: 2,
                    kind: "rich-text" as const,
                    required: false,
                },
            ],
            templates: [
                {
                    id: "typed-basic",
                    version: 1,
                    name: "Typed",
                    ordinal: 0,
                    questionFormat: "{{Term}}",
                    answerFormat: "{{Answer}}",
                    deckOverride: null as string | null,
                    enabled: true,
                    generator: "standard" as const,
                    answerMode: "type" as const,
                    answerFieldId: "answer",
                    condition: {
                        operator: "always" as const,
                        fieldId: null as string | null,
                        value: "",
                    },
                },
                {
                    id: "case-cloze",
                    version: 1,
                    name: "Case",
                    ordinal: 1,
                    questionFormat: "{{cloze:Case}}",
                    answerFormat: "{{Case}}",
                    deckOverride: null as string | null,
                    enabled: true,
                    generator: "cloze" as const,
                    answerMode: "reveal" as const,
                    sourceFieldId: "case",
                    condition: { operator: "not-empty" as const, fieldId: "case", value: "" },
                },
            ],
            css: "",
            createdAt: 0,
            updatedAt: 0,
        };
        const result = serializeStructuredNoteBody(
            noteType,
            { term: "Diagnosis", answer: "Migraine", case: "{{c1::Aura}} precedes pain." },
            DEFAULT_SETTINGS,
            "^mixed",
        );

        expect(parse(`#flashcards\n\n${result.body}\n`, DEFAULT_SETTINGS)).toHaveLength(2);
        expect(result.body).toContain("sr-answer-mode: type");
        expect(result.body).toContain("sr-typed-answer: Migraine");
        expect(result.body).toContain("==Aura== precedes pain.");
        expect(result.legacyStableIds).toEqual({
            0: "^mixed-1:0",
            1: "^mixed-2:0",
        });
    });

    it("applies conditional and image-occlusion templates without emitting empty cards", () => {
        const baseTemplate = (
            id: string,
            ordinal: number,
            operator: "always" | "not-empty" | "empty" | "equals" | "not-equals",
            fieldId: string | null,
            value = "",
        ) => ({
            id,
            version: 1,
            name: id,
            ordinal,
            questionFormat: "{{Question}}",
            answerFormat: "{{Answer}}",
            deckOverride: null as string | null,
            enabled: true,
            generator: "standard" as const,
            answerMode: "reveal" as const,
            condition: { operator, fieldId, value },
        });
        const noteType = {
            id: "conditional",
            version: 1,
            name: "Conditional",
            kind: "standard" as const,
            fields: [
                {
                    id: "question",
                    name: "Question",
                    ordinal: 0,
                    kind: "text" as const,
                    required: true,
                },
                { id: "answer", name: "Answer", ordinal: 1, kind: "text" as const, required: true },
                { id: "blank", name: "Blank", ordinal: 2, kind: "text" as const, required: false },
                {
                    id: "assets",
                    name: "Assets",
                    ordinal: 3,
                    kind: "text" as const,
                    required: false,
                },
            ],
            templates: [
                baseTemplate("present", 0, "not-empty", "answer"),
                baseTemplate("empty", 1, "empty", "blank"),
                baseTemplate("equals", 2, "equals", "answer", "A"),
                baseTemplate("different", 3, "not-equals", "answer", "B"),
                baseTemplate("skip", 4, "equals", "answer", "B"),
                {
                    ...baseTemplate("image", 5, "always", null),
                    generator: "image-occlusion" as const,
                    answerMode: "type" as const,
                },
                {
                    ...baseTemplate("empty-card", 6, "always", null),
                    questionFormat: "{{Blank}}",
                },
            ],
            css: "",
            createdAt: 0,
            updatedAt: 0,
        };
        const result = serializeStructuredNoteBody(
            noteType,
            {
                question: "Q",
                answer: "A",
                blank: "",
                assets: JSON.stringify([
                    {
                        maskId: "m1",
                        questionPath: "Media/q.png",
                        answerPath: "Media/a.png",
                        label: "Heart",
                    },
                ]),
            },
            DEFAULT_SETTINGS,
            "^conditional",
        );
        expect(parse(`#flashcards\n\n${result.body}\n`, DEFAULT_SETTINGS)).toHaveLength(5);
        expect(result.body).toContain("![[Media/q.png]]");
        expect(result.body).toContain("sr-typed-answer: Heart");
        expect(result.body).not.toContain("empty-card");
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

        const braceCloze = serializeNativeCard(
            {
                deckPath: "Biology",
                type: "cloze",
                front: "The cell has a membrane.",
                back: "membrane",
            },
            { ...DEFAULT_SETTINGS, clozePatterns: ["{{"] },
        );
        expect(braceCloze).toContain("{{membrane}}");
        expect(() =>
            serializeNativeCard(
                { deckPath: "", type: "cloze", front: "Question", back: "Question" },
                { ...DEFAULT_SETTINGS, clozePatterns: [] },
            ),
        ).toThrow("cloze-pattern-unavailable");
        expect(() =>
            serializeNativeCard(
                { deckPath: "", type: "cloze", front: "Question", back: "missing" },
                DEFAULT_SETTINGS,
            ),
        ).toThrow("cloze-answer-not-found");
    });

    it("rejects structured generators that cannot produce a safe card", () => {
        const imageType = getBuiltinNoteTypes()[3];
        expect(() =>
            serializeStructuredNoteBody(
                imageType,
                { source: "image.png", masks: "[]", assets: "not-json", mode: "hide-all" },
                DEFAULT_SETTINGS,
                "^broken-image",
            ),
        ).toThrow("empty-generated-card");

        const clozeType = getBuiltinNoteTypes()[2];
        expect(() =>
            serializeStructuredNoteBody(
                clozeType,
                { text: "No cloze here", extra: "" },
                DEFAULT_SETTINGS,
                "^broken-cloze",
            ),
        ).toThrow("empty-generated-card");
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

    it("moves managed card sources and updates collection-only tags", async () => {
        const harness = createStoreHarness();
        const sourcePath = "Spaced Repetition/Cards/Inbox/question.md";
        const taggedSourcePath = "Spaced Repetition/Cards/Inbox/tagged.md";
        const alreadyMovedPath = "Spaced Repetition/Cards/Medicine/already.md";
        harness.files.set(sourcePath, createTestFile(sourcePath));
        harness.files.set(taggedSourcePath, createTestFile(taggedSourcePath));
        harness.files.set(alreadyMovedPath, createTestFile(alreadyMovedPath));
        harness.createdContents.set(sourcePath, "Question\n?\nAnswer");
        harness.createdContents.set(
            taggedSourcePath,
            "#flashcards/Inbox\n\nTagged question\n?\nTagged answer",
        );
        harness.createdContents.set(
            alreadyMovedPath,
            "#flashcards/Medicine/Cardiology\n\nAlready moved\n?\nAnswer",
        );

        await harness.store.moveCards(
            [
                { sourcePath, questionId: "^question" },
                { sourcePath: taggedSourcePath, questionId: "^tagged" },
                { sourcePath: alreadyMovedPath, questionId: "^moved" },
                { sourcePath: "Cards/missing.md", questionId: "^missing" },
            ],
            "Medicine / Cardiology",
        );
        await harness.store.setCardTags(
            [{ sourcePath, questionId: "^question" }],
            ["medicine", "exam"],
        );

        expect(harness.modifiedContents.get(sourcePath)).toContain(
            "#flashcards/Medicine/Cardiology",
        );
        expect(harness.modifiedContents.get(taggedSourcePath)).toContain(
            "#flashcards/Medicine/Cardiology",
        );
        expect(harness.collectionStore.moveNotesBySource).toHaveBeenCalledWith(
            [
                { sourcePath, questionId: "^question" },
                { sourcePath: taggedSourcePath, questionId: "^tagged" },
                { sourcePath: alreadyMovedPath, questionId: "^moved" },
                { sourcePath: "Cards/missing.md", questionId: "^missing" },
            ],
            "Medicine/Cardiology",
        );
        expect(harness.collectionStore.setNotesTagsBySource).toHaveBeenCalledWith(
            [{ sourcePath, questionId: "^question" }],
            ["medicine", "exam"],
        );

        await harness.store.moveCards([], "");
        expect(harness.collectionStore.moveNotesBySource).toHaveBeenLastCalledWith([], "");
    });

    it("updates a native card without replacing its source note", async () => {
        const harness = createStoreHarness();
        const writeQuestion = jest.fn().mockResolvedValue(undefined);
        const card = {
            question: {
                questionType: CardType.MultiLineBasic,
                questionText: { actualQuestion: "Old\n?\nAnswer" },
                cards: [{ front: "Old", back: "Answer" }],
                note: { filePath: "Cards/question.md" },
                ensureStableId: jest.fn(() => "^question"),
                writeQuestion,
            },
        } as unknown as Card;

        await harness.store.updateCard(card, {
            deckPath: "Medicine",
            type: "basic",
            front: "New question",
            back: "New answer",
            answerMode: "type",
            tags: ["exam"],
        });

        expect(writeQuestion).toHaveBeenCalled();
        expect(harness.collectionStore.updateNativeNote).toHaveBeenCalledWith(
            expect.objectContaining({
                sourcePath: "Cards/question.md",
                questionId: "^question",
                answerMode: "type",
                tags: ["exam"],
            }),
        );
        expect(harness.sync).toHaveBeenCalled();

        (card.question as unknown as { questionType: CardType }).questionType =
            CardType.SingleLineBasic;
        card.question.questionText.actualQuestion = "Old::Answer";
        await harness.store.updateCard(card, {
            deckPath: "Medicine",
            type: "basic",
            front: "Short",
            back: "Answer",
            answerMode: "reveal",
        });
        expect(card.question.questionText.actualQuestion).toContain(
            DEFAULT_SETTINGS.singleLineCardSeparator,
        );

        (card.question as unknown as { questionType: CardType }).questionType =
            CardType.SingleLineReversed;
        card.question.cards.push({ front: "", back: "" } as Card);
        await harness.store.updateCard(card, {
            deckPath: "Languages",
            type: "reversed",
            front: "bonjour",
            back: "hello",
        });
        expect(card.question.questionText.actualQuestion).toContain(
            DEFAULT_SETTINGS.singleLineReversedCardSeparator,
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
