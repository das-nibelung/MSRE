import { normalizePath, TFile, Vault } from "obsidian";

export const RECOVERY_ROOT = "Spaced Repetition/Recovery";
export const RECOVERY_PENDING_FOLDER = `${RECOVERY_ROOT}/Pending`;
export const RECOVERY_BACKUP_FOLDER = `${RECOVERY_ROOT}/Snapshots`;
export const RECOVERY_CONFLICT_FOLDER = `${RECOVERY_ROOT}/Conflicts`;

const TRANSACTION_VERSION = 1;
const DEFAULT_BACKUP_LIMIT = 12;

interface VaultWriteTransaction {
    version: number;
    id: string;
    targetPath: string;
    tempPath: string;
    transactionPath: string;
    beforeHash: string | null;
    afterHash: string;
    createdAt: number;
}

export interface AtomicWriteOptions {
    /** Keep a recoverable copy of the previous contents. */
    backup?: boolean;
}

export interface VaultRecoveryReport {
    recovered: number;
    completed: number;
    conflicts: number;
    failed: number;
}

export class VaultWriteConflictError extends Error {
    constructor(
        public readonly targetPath: string,
        public readonly conflictPath: string,
    ) {
        super(`The file changed while it was being saved: ${targetPath}`);
        this.name = "VaultWriteConflictError";
    }
}

/**
 * Journaled, compare-before-write persistence for synced vault text files.
 *
 * Obsidian's Vault API does not expose a portable atomic replace operation. This class therefore
 * writes the intended contents and a small write-ahead record first, verifies the final write, and
 * can replay an interrupted transaction on the next startup. A third, externally changed version
 * is never overwritten: the local candidate is preserved in Recovery/Conflicts instead.
 */
export class AtomicVaultWriter {
    private readonly queues = new Map<string, Promise<unknown>>();

    constructor(
        private readonly vault: Vault,
        private readonly backupLimit = DEFAULT_BACKUP_LIMIT,
    ) {}

    writeText(path: string, content: string, options: AtomicWriteOptions = {}): Promise<TFile> {
        const targetPath = normalizePath(path);
        return this.enqueue(targetPath, () => this.commit(targetPath, content, options));
    }

    async recover(): Promise<VaultRecoveryReport> {
        const report: VaultRecoveryReport = {
            recovered: 0,
            completed: 0,
            conflicts: 0,
            failed: 0,
        };
        const journals = this.vault
            .getFiles()
            .filter(
                (file) =>
                    file.path.startsWith(`${RECOVERY_PENDING_FOLDER}/`) &&
                    file.path.endsWith(".transaction.json"),
            )
            .sort((left, right) => left.path.localeCompare(right.path));

        for (const journal of journals) {
            try {
                const transaction = this.parseTransaction(await this.vault.read(journal));
                if (!transaction) {
                    report.failed++;
                    continue;
                }
                const temp = this.fileAt(transaction.tempPath);
                const candidate = temp ? await this.vault.read(temp) : null;
                const target = this.fileAt(transaction.targetPath);
                const current = target ? await this.vault.read(target) : null;

                if (current !== null && hashVaultText(current) === transaction.afterHash) {
                    await this.cleanup(transaction);
                    report.completed++;
                    continue;
                }
                if (candidate === null || hashVaultText(candidate) !== transaction.afterHash) {
                    report.failed++;
                    continue;
                }
                if (hashNullable(current) !== transaction.beforeHash) {
                    await this.preserveConflict(transaction, candidate);
                    await this.cleanup(transaction);
                    report.conflicts++;
                    continue;
                }

                await this.writeDirect(transaction.targetPath, candidate);
                await this.verify(transaction.targetPath, transaction.afterHash);
                await this.cleanup(transaction);
                report.recovered++;
            } catch (error) {
                console.error("SR: Unable to recover an interrupted vault write", error);
                report.failed++;
            }
        }
        return report;
    }

    private enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(path) ?? Promise.resolve();
        const next = previous.catch((): void => undefined).then(operation);
        this.queues.set(path, next);
        const cleanup = (): void => {
            if (this.queues.get(path) === next) this.queues.delete(path);
        };
        void next.then(cleanup, cleanup);
        return next;
    }

    private async commit(
        targetPath: string,
        content: string,
        options: AtomicWriteOptions,
    ): Promise<TFile> {
        const existing = this.fileAt(targetPath);
        const before = existing ? await this.vault.read(existing) : null;
        if (before === content && existing) return existing;

        const transaction = this.createTransaction(targetPath, before, content);
        await this.ensureFolder(RECOVERY_PENDING_FOLDER);
        await this.writeDirect(transaction.tempPath, content);
        await this.writeDirect(transaction.transactionPath, JSON.stringify(transaction, null, 2));

        if (options.backup !== false && before !== null) {
            await this.createBackup(targetPath, before, transaction.id);
        }

        const latestFile = this.fileAt(targetPath);
        const latest = latestFile ? await this.vault.read(latestFile) : null;
        if (hashNullable(latest) !== transaction.beforeHash) {
            const conflictPath = await this.preserveConflict(transaction, content);
            await this.cleanup(transaction);
            throw new VaultWriteConflictError(targetPath, conflictPath);
        }

        const file = await this.writeDirect(targetPath, content);
        await this.verify(targetPath, transaction.afterHash);
        await this.cleanup(transaction);
        if (options.backup !== false) await this.pruneBackups(targetPath);
        return file;
    }

    private createTransaction(
        targetPath: string,
        before: string | null,
        content: string,
    ): VaultWriteTransaction {
        const createdAt = Date.now();
        const nonce = Math.random().toString(36).slice(2, 9);
        const id = `${createdAt}-${nonce}`;
        const key = pathKey(targetPath);
        return {
            version: TRANSACTION_VERSION,
            id,
            targetPath,
            tempPath: `${RECOVERY_PENDING_FOLDER}/${key}-${id}.candidate.data`,
            transactionPath: `${RECOVERY_PENDING_FOLDER}/${key}-${id}.transaction.json`,
            beforeHash: hashNullable(before),
            afterHash: hashVaultText(content),
            createdAt,
        };
    }

    private parseTransaction(content: string): VaultWriteTransaction | null {
        try {
            const value = JSON.parse(content) as Partial<VaultWriteTransaction>;
            if (
                value.version !== TRANSACTION_VERSION ||
                typeof value.id !== "string" ||
                typeof value.targetPath !== "string" ||
                typeof value.tempPath !== "string" ||
                typeof value.transactionPath !== "string" ||
                (value.beforeHash !== null && typeof value.beforeHash !== "string") ||
                typeof value.afterHash !== "string" ||
                typeof value.createdAt !== "number"
            ) {
                return null;
            }
            return value as VaultWriteTransaction;
        } catch {
            return null;
        }
    }

    private async createBackup(targetPath: string, content: string, id: string): Promise<void> {
        await this.ensureFolder(RECOVERY_BACKUP_FOLDER);
        const path = `${RECOVERY_BACKUP_FOLDER}/${pathKey(targetPath)}-${id}.backup.data`;
        if (!this.fileAt(path)) await this.vault.create(path, content);
    }

    private async preserveConflict(
        transaction: VaultWriteTransaction,
        candidate: string,
    ): Promise<string> {
        await this.ensureFolder(RECOVERY_CONFLICT_FOLDER);
        // Keep the exact candidate in a non-Markdown file so it cannot accidentally be indexed as
        // another flashcard note. The content remains plain UTF-8 and can be renamed to .md.
        const path = `${RECOVERY_CONFLICT_FOLDER}/${pathKey(transaction.targetPath)}-${transaction.id}.conflict.data`;
        const contents = `MSRE unapplied change\nTarget: ${transaction.targetPath}\nCandidate hash: ${transaction.afterHash}\nCreated: ${new Date(transaction.createdAt).toISOString()}\n\n${candidate}`;
        await this.writeDirect(path, contents);
        return path;
    }

    private async verify(path: string, expectedHash: string): Promise<void> {
        const file = this.fileAt(path);
        if (!file || hashVaultText(await this.vault.read(file)) !== expectedHash) {
            throw new Error(`Unable to verify the completed vault write: ${path}`);
        }
    }

    private async cleanup(transaction: VaultWriteTransaction): Promise<void> {
        await this.deleteIfPresent(transaction.tempPath);
        await this.deleteIfPresent(transaction.transactionPath);
    }

    private async pruneBackups(targetPath: string): Promise<void> {
        const prefix = `${RECOVERY_BACKUP_FOLDER}/${pathKey(targetPath)}-`;
        const backups = this.vault
            .getFiles()
            .filter((file) => file.path.startsWith(prefix) && file.path.endsWith(".backup.data"))
            .sort((left, right) => right.path.localeCompare(left.path));
        for (const backup of backups.slice(this.backupLimit)) await this.vault.delete(backup);
    }

    private async deleteIfPresent(path: string): Promise<void> {
        const file = this.fileAt(path);
        if (file) await this.vault.delete(file);
    }

    private async writeDirect(path: string, content: string): Promise<TFile> {
        await this.ensureFolder(path.split("/").slice(0, -1).join("/"));
        const file = this.fileAt(path);
        if (file) {
            await this.vault.modify(file, content);
            return file;
        }
        return await this.vault.create(path, content);
    }

    private fileAt(path: string): TFile | null {
        const file = this.vault.getAbstractFileByPath(normalizePath(path));
        return file instanceof TFile ? file : null;
    }

    private async ensureFolder(path: string): Promise<void> {
        let current = "";
        for (const part of normalizePath(path).split("/").filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!this.vault.getAbstractFileByPath(current)) await this.vault.createFolder(current);
        }
    }
}

export function hashVaultText(content: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < content.length; index++) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function hashNullable(content: string | null): string | null {
    return content === null ? null : hashVaultText(content);
}

function pathKey(path: string): string {
    const readable = path
        .normalize("NFKD")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 72);
    return `${readable || "vault-file"}-${hashVaultText(path)}`;
}
