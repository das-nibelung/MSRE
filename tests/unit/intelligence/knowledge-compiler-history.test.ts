import { TFile } from "obsidian";

import {
    COMPILER_HISTORY_FOLDER,
    KnowledgeCompilerHistoryStore,
} from "src/intelligence/knowledge-compiler-history";

function testFile(path: string): TFile {
    const name = path.split("/").pop() ?? path;
    return Object.assign(new TFile(), {
        path,
        name,
        extension: name.split(".").pop() ?? "",
    });
}

function fixture(initial: Record<string, string>) {
    const contents = new Map(Object.entries(initial));
    const files = new Map([...contents.keys()].map((path) => [path, testFile(path)]));
    const vault = {
        getFileByPath: jest.fn((path: string) => files.get(path) ?? null),
        getFiles: jest.fn(() => [...files.values()]),
        read: jest.fn((file: TFile) => Promise.resolve(contents.get(file.path) ?? "")),
        trash: jest.fn((file: TFile) => {
            files.delete(file.path);
            contents.delete(file.path);
            return Promise.resolve();
        }),
    };
    const writer = {
        writeText: jest.fn((path: string, content: string) => {
            const file = files.get(path) ?? testFile(path);
            files.set(path, file);
            contents.set(path, content);
            return Promise.resolve(file);
        }),
    };
    return {
        contents,
        files,
        store: new KnowledgeCompilerHistoryStore(vault as never, writer as never),
    };
}

describe("knowledge compiler history", () => {
    test("records exact snapshots and rolls an operation back", async () => {
        const { store, contents, files } = fixture({
            "Cards/updated.md": "after update",
            "Cards/created.md": "new card",
        });
        const entry = await store.record(
            ["Notes/source.md"],
            "one update",
            new Map([
                ["Cards/updated.md", "before update"],
                ["Cards/created.md", null],
            ]),
        );
        const history = await store.list();

        expect(history).toHaveLength(1);
        expect(history[0].path.startsWith(`${COMPILER_HISTORY_FOLDER}/`)).toBe(true);
        expect(history[0].entry.files).toEqual(
            expect.arrayContaining([
                { path: "Cards/updated.md", before: "before update", after: "after update" },
                { path: "Cards/created.md", before: null, after: "new card" },
            ]),
        );

        const result = await store.rollback(history[0].path, entry);
        expect(result).toEqual({ restored: 1, removed: 1, conflicts: [] });
        expect(contents.get("Cards/updated.md")).toBe("before update");
        expect(files.has("Cards/created.md")).toBe(false);
        expect(entry.rolledBackAt).toEqual(expect.any(Number));
    });

    test("refuses to overwrite a file changed after compilation", async () => {
        const { store, contents } = fixture({
            "Cards/a.md": "compiled",
            "Cards/b.md": "compiled b",
        });
        const entry = await store.record(
            ["Notes/source.md"],
            "one update",
            new Map([
                ["Cards/a.md", "before"],
                ["Cards/b.md", "before b"],
            ]),
        );
        const history = await store.list();
        contents.set("Cards/a.md", "newer synced version");

        const result = await store.rollback(history[0].path, entry);
        expect(result.conflicts).toEqual(["Cards/a.md"]);
        expect(contents.get("Cards/a.md")).toBe("newer synced version");
        expect(contents.get("Cards/b.md")).toBe("compiled b");
        expect(entry.rolledBackAt).toBeUndefined();
    });

    test("ignores malformed history files", async () => {
        const { store } = fixture({ [`${COMPILER_HISTORY_FOLDER}/broken.json`]: "not json" });
        await expect(store.list()).resolves.toEqual([]);
    });
});
