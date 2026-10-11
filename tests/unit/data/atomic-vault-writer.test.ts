import { TFile } from "obsidian";

import {
    AtomicVaultWriter,
    hashVaultText,
    RECOVERY_CONFLICT_FOLDER,
    RECOVERY_PENDING_FOLDER,
    VaultWriteConflictError,
} from "src/data/reliability/atomic-vault-writer";

function testFile(path: string): TFile {
    const segments = path.split("/");
    const name = segments[segments.length - 1] ?? "";
    return Object.assign(new TFile(), {
        path,
        name,
        extension: name.split(".").pop() ?? "",
    });
}

function createVault(initial: Record<string, string> = {}) {
    const files = new Map<string, TFile>();
    const contents = new Map<string, string>();
    const folders = new Set<string>();
    for (const [path, content] of Object.entries(initial)) {
        files.set(path, testFile(path));
        contents.set(path, content);
    }
    const vault = {
        getAbstractFileByPath: jest.fn(
            (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
        ),
        getFiles: jest.fn(() => [...files.values()]),
        read: jest.fn((file: TFile) => Promise.resolve(contents.get(file.path) ?? "")),
        createFolder: jest.fn((path: string) => {
            folders.add(path);
            return Promise.resolve();
        }),
        create: jest.fn((path: string, content: string) => {
            const file = testFile(path);
            files.set(path, file);
            contents.set(path, content);
            return Promise.resolve(file);
        }),
        modify: jest.fn((file: TFile, content: string) => {
            contents.set(file.path, content);
            return Promise.resolve();
        }),
        delete: jest.fn((file: TFile) => {
            files.delete(file.path);
            contents.delete(file.path);
            return Promise.resolve();
        }),
    };
    return { vault, files, contents };
}

describe("atomic vault writer", () => {
    it("creates a new file without a snapshot when backups are disabled", async () => {
        const { vault, files, contents } = createVault();
        const writer = new AtomicVaultWriter(vault as never);

        await writer.writeText("Cards/new.md", "new", { backup: false });

        expect(contents.get("Cards/new.md")).toBe("new");
        expect([...files.keys()].some((path) => path.endsWith(".backup.data"))).toBe(false);
    });

    it("skips an unchanged file", async () => {
        const { vault } = createVault({ "Cards/a.md": "same" });
        const writer = new AtomicVaultWriter(vault as never);

        await writer.writeText("Cards/a.md", "same");

        expect(vault.modify).not.toHaveBeenCalled();
        expect(vault.create).not.toHaveBeenCalled();
    });

    it("commits and verifies a write while cleaning its write-ahead journal", async () => {
        const { vault, files, contents } = createVault({ "Cards/a.md": "old" });
        const writer = new AtomicVaultWriter(vault as never);

        const file = await writer.writeText("Cards/a.md", "new");

        expect(file.path).toBe("Cards/a.md");
        expect(contents.get("Cards/a.md")).toBe("new");
        expect(
            [...files.keys()].some((path) => path.startsWith(`${RECOVERY_PENDING_FOLDER}/`)),
        ).toBe(false);
        expect([...files.keys()].some((path) => path.endsWith(".backup.data"))).toBe(true);
    });

    it("replays an interrupted write when the target still has the expected version", async () => {
        const targetPath = "Spaced Repetition/library.sr.md";
        const tempPath = `${RECOVERY_PENDING_FOLDER}/library-1.candidate.data`;
        const transactionPath = `${RECOVERY_PENDING_FOLDER}/library-1.transaction.json`;
        const transaction = {
            version: 1,
            id: "1-test",
            targetPath,
            tempPath,
            transactionPath,
            beforeHash: hashVaultText("old"),
            afterHash: hashVaultText("new"),
            createdAt: 1,
        };
        const { vault, files, contents } = createVault({
            [targetPath]: "old",
            [tempPath]: "new",
            [transactionPath]: JSON.stringify(transaction),
        });
        const writer = new AtomicVaultWriter(vault as never);

        const report = await writer.recover();

        expect(report).toEqual({ recovered: 1, completed: 0, conflicts: 0, failed: 0 });
        expect(contents.get(targetPath)).toBe("new");
        expect(files.has(tempPath)).toBe(false);
        expect(files.has(transactionPath)).toBe(false);
    });

    it("does not overwrite a newer sync version during recovery", async () => {
        const targetPath = "Spaced Repetition/library.sr.md";
        const tempPath = `${RECOVERY_PENDING_FOLDER}/library-2.candidate.data`;
        const transactionPath = `${RECOVERY_PENDING_FOLDER}/library-2.transaction.json`;
        const transaction = {
            version: 1,
            id: "2-test",
            targetPath,
            tempPath,
            transactionPath,
            beforeHash: hashVaultText("old"),
            afterHash: hashVaultText("local candidate"),
            createdAt: 2,
        };
        const { vault, files, contents } = createVault({
            [targetPath]: "newer remote version",
            [tempPath]: "local candidate",
            [transactionPath]: JSON.stringify(transaction),
        });
        const writer = new AtomicVaultWriter(vault as never);

        const report = await writer.recover();

        expect(report.conflicts).toBe(1);
        expect(contents.get(targetPath)).toBe("newer remote version");
        const conflict = [...files.keys()].find((path) =>
            path.startsWith(`${RECOVERY_CONFLICT_FOLDER}/`),
        );
        expect(conflict).toBeDefined();
        expect(contents.get(conflict ?? "")).toContain("local candidate");
    });

    it("cleans a transaction whose target was already committed", async () => {
        const targetPath = "Cards/a.md";
        const tempPath = `${RECOVERY_PENDING_FOLDER}/a.candidate.data`;
        const transactionPath = `${RECOVERY_PENDING_FOLDER}/a.transaction.json`;
        const transaction = {
            version: 1,
            id: "3-test",
            targetPath,
            tempPath,
            transactionPath,
            beforeHash: hashVaultText("old"),
            afterHash: hashVaultText("new"),
            createdAt: 3,
        };
        const { vault, files } = createVault({
            [targetPath]: "new",
            [tempPath]: "new",
            [transactionPath]: JSON.stringify(transaction),
        });
        const writer = new AtomicVaultWriter(vault as never);

        const report = await writer.recover();

        expect(report.completed).toBe(1);
        expect(files.has(tempPath)).toBe(false);
        expect(files.has(transactionPath)).toBe(false);
    });

    it("keeps malformed and incomplete recovery records for inspection", async () => {
        const invalidJson = `${RECOVERY_PENDING_FOLDER}/invalid.transaction.json`;
        const incomplete = `${RECOVERY_PENDING_FOLDER}/incomplete.transaction.json`;
        const { vault, files } = createVault({
            [invalidJson]: "not json",
            [incomplete]: JSON.stringify({ version: 1, id: "missing-fields" }),
        });
        const writer = new AtomicVaultWriter(vault as never);

        const report = await writer.recover();

        expect(report.failed).toBe(2);
        expect(files.has(invalidJson)).toBe(true);
        expect(files.has(incomplete)).toBe(true);
    });

    it("keeps a recovery record when its candidate is missing", async () => {
        const transactionPath = `${RECOVERY_PENDING_FOLDER}/missing.transaction.json`;
        const transaction = {
            version: 1,
            id: "4-test",
            targetPath: "Cards/a.md",
            tempPath: `${RECOVERY_PENDING_FOLDER}/missing.candidate.data`,
            transactionPath,
            beforeHash: hashVaultText("old"),
            afterHash: hashVaultText("candidate"),
            createdAt: 4,
        };
        const { vault, files } = createVault({
            "Cards/a.md": "old",
            [transactionPath]: JSON.stringify(transaction),
        });
        const writer = new AtomicVaultWriter(vault as never);

        const report = await writer.recover();

        expect(report.failed).toBe(1);
        expect(files.has(transactionPath)).toBe(true);
    });

    it("detects a concurrent edit between prepare and commit", async () => {
        const { vault, contents } = createVault({ "Cards/a.md": "old" });
        let targetReads = 0;
        vault.read.mockImplementation((file: TFile) => {
            if (file.path === "Cards/a.md") {
                targetReads++;
                if (targetReads === 2) contents.set(file.path, "synced change");
            }
            return Promise.resolve(contents.get(file.path) ?? "");
        });
        const writer = new AtomicVaultWriter(vault as never);

        await expect(writer.writeText("Cards/a.md", "local change")).rejects.toBeInstanceOf(
            VaultWriteConflictError,
        );
        expect(contents.get("Cards/a.md")).toBe("synced change");
        expect([...contents.values()].some((content) => content.includes("local change"))).toBe(
            true,
        );
    });
});
