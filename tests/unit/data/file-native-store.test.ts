import { TFile } from "obsidian";

import {
    FILE_NATIVE_CATALOG_PATH,
    FILE_NATIVE_SCHEMA_VERSION,
    FileNativeCatalog,
    formatFileNativeCatalog,
    writeFileNativeDocument,
} from "src/data/file-native/file-native-format";
import { FileNativeStore } from "src/data/file-native/file-native-store";

function testFile(path: string): TFile {
    const segments = path.split("/");
    return Object.assign(new TFile(), {
        path,
        name: segments[segments.length - 1] ?? "",
    });
}

describe("file-native vault store", () => {
    it("creates, reads, updates, and scans portable Markdown data", async () => {
        const files = new Map<string, TFile>();
        const contents = new Map<string, string>();
        const folders = new Set<string>();
        const vault = {
            getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
            getMarkdownFiles: jest.fn(() => [...files.values()]),
            read: jest.fn((file: TFile) => Promise.resolve(contents.get(file.path) ?? "")),
            createFolder: jest.fn((path: string) => {
                folders.add(path);
                return Promise.resolve();
            }),
            create: jest.fn((path: string, value: string) => {
                const file = testFile(path);
                files.set(path, file);
                contents.set(path, value);
                return Promise.resolve(file);
            }),
            modify: jest.fn((file: TFile, value: string) => {
                contents.set(file.path, value);
                return Promise.resolve();
            }),
        };
        const store = new FileNativeStore(vault as never);
        const catalog: FileNativeCatalog = {
            schemaVersion: FILE_NATIVE_SCHEMA_VERSION,
            updatedAt: 1,
            noteTypes: [],
            deckOptions: [],
            decks: [],
            managedDecks: ["Medicine"],
            knowledgeAreas: [],
        };

        expect(await store.readCatalog()).toBeNull();
        await store.writeCatalog(catalog);
        expect(folders).toContain("Spaced Repetition");
        expect(await store.readCatalog()).toEqual(catalog);

        await store.writeCatalog(catalog);
        expect(vault.modify).not.toHaveBeenCalled();
        store.resetCatalogCache();
        await store.writeCatalog({ ...catalog, updatedAt: 2 });
        expect(vault.modify).toHaveBeenCalledTimes(1);

        const card = testFile("Cards/question.md");
        files.set(card.path, card);
        contents.set(
            card.path,
            writeFileNativeDocument("Question :: Answer", [
                {
                    id: "note-1",
                    noteTypeId: "builtin-basic",
                    fields: { front: "Question", back: "Answer" },
                    tags: [],
                    deckPath: "Medicine",
                    questionId: "^note-1",
                    bodyHash: "hash",
                    createdAt: 1,
                    updatedAt: 1,
                },
            ]),
        );
        const ordinary = testFile("Notes/ordinary.md");
        files.set(ordinary.path, ordinary);
        contents.set(ordinary.path, "ordinary note");

        const documents = await store.readAllDocuments();
        expect(documents).toHaveLength(1);
        expect(documents[0].path).toBe(card.path);
        expect(documents[0].manifest.notes[0].id).toBe("note-1");
        expect(contents.get(FILE_NATIVE_CATALOG_PATH)).toBe(
            formatFileNativeCatalog({ ...catalog, updatedAt: 2 }),
        );
    });
});
