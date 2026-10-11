import {
    FILE_NATIVE_SCHEMA_VERSION,
    FileNativeCatalog,
    FileNativeNoteRecord,
    formatFileNativeCatalog,
    hashVisibleMarkdown,
    parseFileNativeCatalog,
    readFileNativeDocument,
    visibleMarkdown,
    writeFileNativeDocument,
} from "src/data/file-native/file-native-format";

describe("file-native Markdown format", () => {
    const note: FileNativeNoteRecord = {
        id: "note-stable",
        noteTypeId: "builtin-basic",
        fields: { front: "Question", back: "Answer -- including punctuation" },
        answerMode: "reveal",
        tags: ["exam"],
        deckPath: "Medicine/Cardiology",
        questionId: "^sr-data-id-note-stable",
        bodyHash: hashVisibleMarkdown("#flashcards\n\nQuestion :: Answer"),
        createdAt: 1,
        updatedAt: 2,
    };

    it("round-trips editable note metadata without changing visible Markdown", () => {
        const visible = "#flashcards/Medicine\n\nQuestion :: Answer";
        const contents = writeFileNativeDocument(visible, [note]);

        expect(visibleMarkdown(contents)).toBe(visible);
        expect(readFileNativeDocument(contents)).toEqual({
            schemaVersion: FILE_NATIVE_SCHEMA_VERSION,
            notes: [note],
        });
        expect(contents).not.toContain("Answer -- including punctuation");
        expect(contents).toContain("Answer \\u002d\\u002d including punctuation");
    });

    it("detects manual changes to the visible source independently of the manifest", () => {
        const original = writeFileNativeDocument("Question :: Answer", [note]);
        const edited = original.replace("Question :: Answer", "Edited :: Answer");

        expect(hashVisibleMarkdown(original)).not.toBe(hashVisibleMarkdown(edited));
        expect(readFileNativeDocument(edited)?.notes[0].bodyHash).toBe(note.bodyHash);
    });

    it("round-trips the portable library catalog", () => {
        const catalog: FileNativeCatalog = {
            schemaVersion: FILE_NATIVE_SCHEMA_VERSION,
            updatedAt: 10,
            noteTypes: [],
            deckOptions: [],
            decks: [],
            managedDecks: ["Medicine"],
            knowledgeAreas: [
                { id: "area-1", name: "Medicine", deckPaths: ["Medicine"], pinned: true },
            ],
        };

        expect(parseFileNativeCatalog(formatFileNativeCatalog(catalog))).toEqual(catalog);
    });

    it("ignores malformed or unsupported embedded metadata safely", () => {
        expect(readFileNativeDocument("ordinary Markdown")).toBeNull();
        expect(
            readFileNativeDocument(
                "Body\n<!-- msre-file-native-v1\nnot-json\nmsre-file-native-end -->",
            ),
        ).toBeNull();
        expect(
            readFileNativeDocument(
                'Body\n<!-- msre-file-native-v1\n{"schemaVersion":2,"notes":[]}\nmsre-file-native-end -->',
            ),
        ).toBeNull();
        expect(
            readFileNativeDocument(
                'Body\n<!-- msre-file-native-v1\n{"schemaVersion":1,"notes":[null,{"id":"incomplete"}]}\nmsre-file-native-end -->',
            ),
        ).toEqual({ schemaVersion: 1, notes: [] });

        expect(parseFileNativeCatalog(null)).toBeNull();
        expect(parseFileNativeCatalog("```json\nnot-json\n```")).toBeNull();
        expect(parseFileNativeCatalog('```json\n{"schemaVersion":2}\n```')).toBeNull();
        expect(
            parseFileNativeCatalog(
                '```json\n{"schemaVersion":1,"noteTypes":[],"deckOptions":[],"decks":[],"managedDecks":[]}\n```',
            ),
        ).toBeNull();
    });
});
