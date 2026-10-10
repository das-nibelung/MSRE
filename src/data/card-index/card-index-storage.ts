import { CardIndexRecord, CardIndexStorage } from "src/data/card-index/card-index-types";

const STORE_NAME = "notes";

export class MemoryCardIndexStorage implements CardIndexStorage {
    private readonly records = new Map<string, CardIndexRecord>();

    get(path: string): Promise<CardIndexRecord | undefined> {
        return Promise.resolve(this.records.get(path));
    }

    put(record: CardIndexRecord): Promise<void> {
        this.records.set(record.path, record);
        return Promise.resolve();
    }

    delete(path: string): Promise<void> {
        this.records.delete(path);
        return Promise.resolve();
    }

    getAllPaths(): Promise<string[]> {
        return Promise.resolve([...this.records.keys()]);
    }

    close(): void {
        this.records.clear();
    }
}

export class IndexedDbCardIndexStorage implements CardIndexStorage {
    private databasePromise: Promise<IDBDatabase> | null = null;

    constructor(private readonly databaseName: string) {}

    private getDatabase(): Promise<IDBDatabase> {
        if (this.databasePromise !== null) return this.databasePromise;

        this.databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.databaseName, 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: "path" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("Unable to open card index"));
            request.onblocked = () => reject(new Error("Card index database upgrade is blocked"));
        });
        return this.databasePromise;
    }

    private async runRequest<T>(
        mode: IDBTransactionMode,
        operation: (store: IDBObjectStore) => IDBRequest<T>,
    ): Promise<T> {
        const database = await this.getDatabase();
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const request = operation(transaction.objectStore(STORE_NAME));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("Card index request failed"));
            transaction.onabort = () =>
                reject(transaction.error ?? new Error("Card index transaction aborted"));
        });
    }

    async get(path: string): Promise<CardIndexRecord | undefined> {
        return (await this.runRequest("readonly", (store) => store.get(path))) as
            CardIndexRecord | undefined;
    }

    async put(record: CardIndexRecord): Promise<void> {
        await this.runRequest("readwrite", (store) => store.put(record));
    }

    async delete(path: string): Promise<void> {
        await this.runRequest("readwrite", (store) => store.delete(path));
    }

    async getAllPaths(): Promise<string[]> {
        return (await this.runRequest("readonly", (store) => store.getAllKeys())) as string[];
    }

    close(): void {
        if (this.databasePromise === null) return;
        void this.databasePromise
            .then((database) => database.close())
            .catch((_error: unknown): void => undefined);
        this.databasePromise = null;
    }
}

class ResilientCardIndexStorage implements CardIndexStorage {
    private readonly fallback = new MemoryCardIndexStorage();
    private useFallback = false;

    constructor(private readonly persistent: CardIndexStorage) {}

    private async run<T>(
        persistentOperation: () => Promise<T>,
        fallbackOperation: () => Promise<T>,
    ): Promise<T> {
        if (this.useFallback) return await fallbackOperation();
        try {
            return await persistentOperation();
        } catch (error) {
            this.useFallback = true;
            this.persistent.close();
            console.warn(
                "SR: IndexedDB is unavailable; using a temporary in-memory card index",
                error,
            );
            return await fallbackOperation();
        }
    }

    async get(path: string): Promise<CardIndexRecord | undefined> {
        return await this.run(
            () => this.persistent.get(path),
            () => this.fallback.get(path),
        );
    }

    async put(record: CardIndexRecord): Promise<void> {
        await this.run(
            () => this.persistent.put(record),
            () => this.fallback.put(record),
        );
    }

    async delete(path: string): Promise<void> {
        await this.run(
            () => this.persistent.delete(path),
            () => this.fallback.delete(path),
        );
    }

    async getAllPaths(): Promise<string[]> {
        return await this.run(
            () => this.persistent.getAllPaths(),
            () => this.fallback.getAllPaths(),
        );
    }

    close(): void {
        this.persistent.close();
        this.fallback.close();
    }
}

export function createCardIndexStorage(databaseName: string): CardIndexStorage {
    if (typeof indexedDB === "undefined") return new MemoryCardIndexStorage();
    return new ResilientCardIndexStorage(new IndexedDbCardIndexStorage(databaseName));
}
