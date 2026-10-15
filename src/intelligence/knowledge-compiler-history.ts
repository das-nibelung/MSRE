import { normalizePath, TFile, Vault } from "obsidian";

import { AtomicVaultWriter } from "src/data/reliability/atomic-vault-writer";

export const COMPILER_HISTORY_FOLDER = "Spaced Repetition/Compiler History";
const HISTORY_VERSION = 1;

export interface CompilerHistoryFile {
    path: string;
    before: string | null;
    after: string | null;
}

export interface CompilerHistoryEntry {
    version: 1;
    id: string;
    createdAt: number;
    sourcePaths: string[];
    summary: string;
    files: CompilerHistoryFile[];
    rolledBackAt?: number;
}

export interface CompilerRollbackResult {
    restored: number;
    removed: number;
    conflicts: string[];
}

function historyFileName(entry: CompilerHistoryEntry): string {
    const stamp = new Date(entry.createdAt).toISOString().replace(/[:.]/g, "-");
    return normalizePath(`${COMPILER_HISTORY_FOLDER}/${stamp}-${entry.id}.json`);
}

function parseHistory(value: string): CompilerHistoryEntry | null {
    try {
        const entry = JSON.parse(value) as Partial<CompilerHistoryEntry>;
        if (
            entry.version !== HISTORY_VERSION ||
            typeof entry.id !== "string" ||
            typeof entry.createdAt !== "number" ||
            !Array.isArray(entry.sourcePaths) ||
            !Array.isArray(entry.files)
        ) {
            return null;
        }
        return entry as CompilerHistoryEntry;
    } catch {
        return null;
    }
}

export class KnowledgeCompilerHistoryStore {
    constructor(
        private readonly vault: Vault,
        private readonly writer: AtomicVaultWriter,
    ) {}

    async record(
        sourcePaths: string[],
        summary: string,
        before: Map<string, string | null>,
    ): Promise<CompilerHistoryEntry> {
        const createdAt = Date.now();
        const entry: CompilerHistoryEntry = {
            version: HISTORY_VERSION,
            id: `${createdAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt,
            sourcePaths: [...new Set(sourcePaths)],
            summary,
            files: [],
        };
        for (const [path, previous] of before) {
            const current = this.vault.getFileByPath(path);
            entry.files.push({
                path,
                before: previous,
                after: current instanceof TFile ? await this.vault.read(current) : null,
            });
        }
        await this.writer.writeText(historyFileName(entry), JSON.stringify(entry, null, 2), {
            backup: false,
        });
        return entry;
    }

    async list(): Promise<Array<{ path: string; entry: CompilerHistoryEntry }>> {
        const result: Array<{ path: string; entry: CompilerHistoryEntry }> = [];
        const files = this.vault
            .getFiles()
            .filter(
                (file) =>
                    file.path.startsWith(`${COMPILER_HISTORY_FOLDER}/`) &&
                    file.extension === "json",
            )
            .sort((left, right) => right.name.localeCompare(left.name));
        for (const file of files) {
            const entry = parseHistory(await this.vault.read(file));
            if (entry) result.push({ path: file.path, entry });
        }
        return result;
    }

    async rollback(
        historyPath: string,
        entry: CompilerHistoryEntry,
    ): Promise<CompilerRollbackResult> {
        const result: CompilerRollbackResult = { restored: 0, removed: 0, conflicts: [] };
        for (const change of entry.files) {
            const current = this.vault.getFileByPath(change.path);
            const currentText = current instanceof TFile ? await this.vault.read(current) : null;
            if (currentText !== change.after) result.conflicts.push(change.path);
        }
        if (result.conflicts.length) return result;

        for (const change of [...entry.files].reverse()) {
            const current = this.vault.getFileByPath(change.path);
            if (change.before === null) {
                if (current instanceof TFile) {
                    await this.vault.trash(current, true);
                    result.removed++;
                }
                continue;
            }
            await this.writer.writeText(change.path, change.before);
            result.restored++;
        }
        entry.rolledBackAt = Date.now();
        await this.writer.writeText(historyPath, JSON.stringify(entry, null, 2), {
            backup: false,
        });
        return result;
    }
}
