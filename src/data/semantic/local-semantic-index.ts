import { CollectionData } from "src/data/collection/collection-types";
import { KnowledgeArea } from "src/data/plugin-data";

const SEMANTIC_INDEX_SCHEMA_VERSION = 1;
const VECTOR_SIZE = 384;

export interface SemanticDocument {
    id: string;
    text: string;
    title: string;
    sourcePath: string;
    deckPaths: string[];
    tags: string[];
    areaIds: string[];
    updatedAt: number;
}

export interface SemanticIndexRecord extends SemanticDocument {
    schemaVersion: number;
    fingerprint: string;
    vector: number[];
}

export interface SemanticMatch {
    item: SemanticDocument;
    score: number;
}

export interface RankedSemanticValue {
    value: string;
    score: number;
}

export interface SemanticSuggestions {
    decks: RankedSemanticValue[];
    tags: RankedSemanticValue[];
    areas: RankedSemanticValue[];
    related: SemanticMatch[];
}

export interface SemanticSyncResult {
    added: string[];
    updated: string[];
    removed: string[];
    unchanged: number;
}

export interface SemanticIndexStorage {
    getAll(): Promise<SemanticIndexRecord[]>;
    put(record: SemanticIndexRecord): Promise<void>;
    delete(id: string): Promise<void>;
    clear(): Promise<void>;
    close(): void;
}

function normalizeText(value: string): string {
    return value
        .replace(/<!--SR:[\s\S]*?-->/g, " ")
        .replace(/!\[\[[^\]]+\]\]/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\{\{c\d+::([^}:]+)(?:::[^}]+)?\}\}/gi, "$1")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function fingerprint(value: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.codePointAt(index) ?? 0;
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0).toString(36);
}

function featureIndex(value: string): number {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0) % VECTOR_SIZE;
}

function addFeature(vector: number[], feature: string, weight: number): void {
    vector[featureIndex(feature)] += weight;
}

/**
 * Builds a compact, deterministic local embedding. Word, word-pair and character features make
 * it useful for fuzzy multilingual retrieval without sending vault text to a network service.
 */
export function embedSemanticText(value: string): number[] {
    const normalized = normalizeText(value);
    const vector = Array.from({ length: VECTOR_SIZE }, () => 0);
    if (!normalized) return vector;
    const words = normalized.split(" ").filter(Boolean);
    for (let index = 0; index < words.length; index++) {
        const word = words[index];
        addFeature(vector, `w:${word}`, 2);
        if (index + 1 < words.length) addFeature(vector, `b:${word} ${words[index + 1]}`, 1.15);
        const padded = `^${word}$`;
        for (let offset = 0; offset <= padded.length - 3; offset++) {
            addFeature(vector, `c:${padded.slice(offset, offset + 3)}`, 0.34);
        }
    }
    const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
    if (magnitude > 0) {
        for (let index = 0; index < vector.length; index++) vector[index] /= magnitude;
    }
    return vector;
}

function similarity(left: number[], right: number[]): number {
    let score = 0;
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index++) score += left[index] * right[index];
    return Math.max(0, Math.min(1, score));
}

function toRecord(item: SemanticDocument): SemanticIndexRecord {
    const identity = JSON.stringify({
        text: item.text,
        title: item.title,
        sourcePath: item.sourcePath,
        deckPaths: item.deckPaths,
        tags: item.tags,
        areaIds: item.areaIds,
        updatedAt: item.updatedAt,
    });
    return {
        ...item,
        schemaVersion: SEMANTIC_INDEX_SCHEMA_VERSION,
        fingerprint: fingerprint(identity),
        vector: embedSemanticText(
            `${item.title}\n${item.text}\n${item.tags.join(" ")}\n${item.deckPaths.join(" ")}`,
        ),
    };
}

function publicDocument(record: SemanticIndexRecord): SemanticDocument {
    const {
        schemaVersion: _schemaVersion,
        fingerprint: _fingerprint,
        vector: _vector,
        ...item
    } = record;
    return item;
}

function rankValues(
    matches: SemanticMatch[],
    selector: (item: SemanticDocument) => string[],
    limit: number,
): RankedSemanticValue[] {
    const scores = new Map<string, number>();
    for (const match of matches) {
        for (const value of selector(match.item)) {
            if (!value) continue;
            scores.set(value, (scores.get(value) ?? 0) + match.score * match.score);
        }
    }
    return [...scores.entries()]
        .map(([value, score]) => ({ value, score }))
        .sort((left, right) => right.score - left.score || left.value.localeCompare(right.value))
        .slice(0, limit);
}

export class LocalSemanticIndex {
    private readonly records = new Map<string, SemanticIndexRecord>();

    load(records: SemanticIndexRecord[]): void {
        this.records.clear();
        for (const record of records) {
            if (
                record.schemaVersion === SEMANTIC_INDEX_SCHEMA_VERSION &&
                record.vector.length === VECTOR_SIZE
            ) {
                this.records.set(record.id, record);
            }
        }
    }

    sync(documents: SemanticDocument[]): SemanticSyncResult {
        const activeIds = new Set(documents.map((item) => item.id));
        const result: SemanticSyncResult = { added: [], updated: [], removed: [], unchanged: 0 };
        for (const item of documents) {
            const next = toRecord(item);
            const current = this.records.get(item.id);
            if (current?.fingerprint === next.fingerprint) {
                result.unchanged++;
                continue;
            }
            this.records.set(item.id, next);
            (current ? result.updated : result.added).push(item.id);
        }
        for (const id of this.records.keys()) {
            if (activeIds.has(id)) continue;
            this.records.delete(id);
            result.removed.push(id);
        }
        return result;
    }

    getRecord(id: string): SemanticIndexRecord | undefined {
        const record = this.records.get(id);
        return record ? { ...record, vector: [...record.vector] } : undefined;
    }

    getRecords(): SemanticIndexRecord[] {
        return [...this.records.values()].map((record) => ({
            ...record,
            vector: [...record.vector],
        }));
    }

    search(
        query: string,
        options: { limit?: number; minScore?: number; excludeId?: string } = {},
    ): SemanticMatch[] {
        if (!normalizeText(query)) return [];
        const queryVector = embedSemanticText(query);
        return [...this.records.values()]
            .filter((record) => record.id !== options.excludeId)
            .map((record) => ({
                item: publicDocument(record),
                score: similarity(queryVector, record.vector),
            }))
            .filter((match) => match.score >= (options.minScore ?? 0.08))
            .sort((left, right) => right.score - left.score)
            .slice(0, options.limit ?? 20);
    }

    related(id: string, limit = 6): SemanticMatch[] {
        const source = this.records.get(id);
        if (!source) return [];
        return [...this.records.values()]
            .filter((record) => record.id !== id)
            .map((record) => ({
                item: publicDocument(record),
                score: similarity(source.vector, record.vector),
            }))
            .filter((match) => match.score >= 0.08)
            .sort((left, right) => right.score - left.score)
            .slice(0, limit);
    }

    findNearDuplicateGroups(threshold = 0.82): string[][] {
        const records = [...this.records.values()];
        const parent = records.map((_record, index) => index);
        const find = (index: number): number => {
            while (parent[index] !== index) {
                parent[index] = parent[parent[index]];
                index = parent[index];
            }
            return index;
        };
        const union = (left: number, right: number): void => {
            const leftRoot = find(left);
            const rightRoot = find(right);
            if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
        };
        const candidatePairs = new Set<string>();
        if (records.length < 200) {
            for (let left = 0; left < records.length; left++) {
                for (let right = left + 1; right < records.length; right++) {
                    candidatePairs.add(`${left}:${right}`);
                }
            }
        } else {
            const buckets = new Map<string, number[]>();
            records.forEach((record, recordIndex) => {
                const dimensions = record.vector
                    .map((weight, index) => ({ index, weight }))
                    .sort((left, right) => right.weight - left.weight)
                    .slice(0, 6)
                    .map((item) => item.index)
                    .sort((left, right) => left - right);
                for (let left = 0; left < dimensions.length; left++) {
                    for (let right = left + 1; right < dimensions.length; right++) {
                        const key = `${dimensions[left]}:${dimensions[right]}`;
                        buckets.set(key, [...(buckets.get(key) ?? []), recordIndex]);
                    }
                }
            });
            for (const bucket of buckets.values()) {
                for (let left = 0; left < bucket.length; left++) {
                    for (let right = left + 1; right < bucket.length; right++) {
                        const first = Math.min(bucket[left], bucket[right]);
                        const second = Math.max(bucket[left], bucket[right]);
                        candidatePairs.add(`${first}:${second}`);
                    }
                }
            }
        }
        for (const pair of candidatePairs) {
            const [left, right] = pair.split(":").map(Number);
            if (similarity(records[left].vector, records[right].vector) >= threshold) {
                union(left, right);
            }
        }
        const groups = new Map<number, string[]>();
        for (let index = 0; index < records.length; index++) {
            const root = find(index);
            groups.set(root, [...(groups.get(root) ?? []), records[index].id]);
        }
        return [...groups.values()].filter((group) => group.length > 1);
    }

    clusterConcepts(threshold = 0.48): string[][] {
        return this.findNearDuplicateGroups(threshold);
    }

    suggest(query: string, excludeId?: string): SemanticSuggestions {
        const related = this.search(query, { limit: 12, minScore: 0.1, excludeId });
        return {
            decks: rankValues(related, (item) => item.deckPaths, 3),
            tags: rankValues(related, (item) => item.tags, 5),
            areas: rankValues(related, (item) => item.areaIds, 3),
            related: related.slice(0, 4),
        };
    }

    clear(): void {
        this.records.clear();
    }

    get size(): number {
        return this.records.size;
    }
}

export function createSemanticDocuments(
    collection: CollectionData,
    areas: KnowledgeArea[],
): SemanticDocument[] {
    const deckPathsByNote = new Map<string, Set<string>>();
    for (const card of Object.values(collection.cards)) {
        if (card.deletedAt) continue;
        const paths = deckPathsByNote.get(card.noteId) ?? new Set<string>();
        if (card.deckPath) paths.add(card.deckPath);
        deckPathsByNote.set(card.noteId, paths);
    }
    return Object.values(collection.notes)
        .filter((note) => !note.deletedAt)
        .map((note) => {
            const values = Object.values(note.fields).filter(Boolean);
            const text = values.join("\n");
            const deckPaths = [...(deckPathsByNote.get(note.id) ?? [])].sort();
            const areaIds = areas
                .filter(
                    (area) =>
                        !area.archivedAt &&
                        area.deckPaths.some((areaDeck) =>
                            deckPaths.some(
                                (deck) => deck === areaDeck || deck.startsWith(`${areaDeck}/`),
                            ),
                        ),
                )
                .map((area) => area.id)
                .sort();
            const title = normalizeText(values[0] ?? note.source.path).slice(0, 120);
            return {
                id: note.id,
                text,
                title: title || note.source.path,
                sourcePath: note.source.path,
                deckPaths,
                tags: [...note.tags].sort(),
                areaIds,
                updatedAt: note.updatedAt,
            };
        });
}

export class MemorySemanticIndexStorage implements SemanticIndexStorage {
    private readonly records = new Map<string, SemanticIndexRecord>();

    getAll(): Promise<SemanticIndexRecord[]> {
        return Promise.resolve([...this.records.values()]);
    }

    put(record: SemanticIndexRecord): Promise<void> {
        this.records.set(record.id, record);
        return Promise.resolve();
    }

    delete(id: string): Promise<void> {
        this.records.delete(id);
        return Promise.resolve();
    }

    clear(): Promise<void> {
        this.records.clear();
        return Promise.resolve();
    }

    close(): void {
        this.records.clear();
    }
}

class IndexedDbSemanticIndexStorage implements SemanticIndexStorage {
    private databasePromise: Promise<IDBDatabase> | null = null;

    constructor(private readonly databaseName: string) {}

    private getDatabase(): Promise<IDBDatabase> {
        if (this.databasePromise !== null) return this.databasePromise;
        this.databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(this.databaseName, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains("documents")) {
                    request.result.createObjectStore("documents", { keyPath: "id" });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
                reject(request.error ?? new Error("Semantic index unavailable"));
            request.onblocked = () => reject(new Error("Semantic index upgrade is blocked"));
        });
        return this.databasePromise;
    }

    private async request<T>(
        mode: IDBTransactionMode,
        action: (store: IDBObjectStore) => IDBRequest<T>,
    ): Promise<T> {
        const database = await this.getDatabase();
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction("documents", mode);
            const request = action(transaction.objectStore("documents"));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
                reject(request.error ?? new Error("Semantic index request failed"));
            transaction.onabort = () =>
                reject(transaction.error ?? new Error("Semantic index transaction aborted"));
        });
    }

    async getAll(): Promise<SemanticIndexRecord[]> {
        return (await this.request("readonly", (store) => store.getAll())) as SemanticIndexRecord[];
    }

    async put(record: SemanticIndexRecord): Promise<void> {
        await this.request("readwrite", (store) => store.put(record));
    }

    async delete(id: string): Promise<void> {
        await this.request("readwrite", (store) => store.delete(id));
    }

    async clear(): Promise<void> {
        await this.request("readwrite", (store) => store.clear());
    }

    close(): void {
        if (this.databasePromise === null) return;
        void this.databasePromise
            .then((database) => database.close())
            .catch((_error: unknown): void => undefined);
        this.databasePromise = null;
    }
}

class ResilientSemanticIndexStorage implements SemanticIndexStorage {
    private readonly fallback = new MemorySemanticIndexStorage();
    private failed = false;

    constructor(private readonly persistent: SemanticIndexStorage) {}

    private async run<T>(persistent: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
        if (this.failed) return await fallback();
        try {
            return await persistent();
        } catch (error) {
            this.failed = true;
            this.persistent.close();
            console.warn("SR: IndexedDB is unavailable; semantic search is temporary", error);
            return await fallback();
        }
    }

    getAll(): Promise<SemanticIndexRecord[]> {
        return this.run(
            () => this.persistent.getAll(),
            () => this.fallback.getAll(),
        );
    }

    put(record: SemanticIndexRecord): Promise<void> {
        return this.run(
            () => this.persistent.put(record),
            () => this.fallback.put(record),
        );
    }

    delete(id: string): Promise<void> {
        return this.run(
            () => this.persistent.delete(id),
            () => this.fallback.delete(id),
        );
    }

    clear(): Promise<void> {
        return this.run(
            () => this.persistent.clear(),
            () => this.fallback.clear(),
        );
    }

    close(): void {
        this.persistent.close();
        this.fallback.close();
    }
}

export function createSemanticIndexStorage(databaseName: string): SemanticIndexStorage {
    if (typeof indexedDB === "undefined") return new MemorySemanticIndexStorage();
    return new ResilientSemanticIndexStorage(new IndexedDbSemanticIndexStorage(databaseName));
}

export class SemanticIndexService {
    private readonly index = new LocalSemanticIndex();
    private ready = false;

    constructor(private readonly storage: SemanticIndexStorage) {}

    async initialize(collection: CollectionData, areas: KnowledgeArea[]): Promise<void> {
        this.index.load(await this.storage.getAll());
        await this.refresh(collection, areas);
        this.ready = true;
    }

    async refresh(collection: CollectionData, areas: KnowledgeArea[]): Promise<SemanticSyncResult> {
        const result = this.index.sync(createSemanticDocuments(collection, areas));
        await Promise.all([
            ...[...result.added, ...result.updated].map((id) => {
                const record = this.index.getRecord(id);
                return record ? this.storage.put(record) : Promise.resolve();
            }),
            ...result.removed.map((id) => this.storage.delete(id)),
        ]);
        return result;
    }

    search(query: string, limit = 30): SemanticMatch[] {
        return this.index.search(query, { limit });
    }

    related(id: string, limit = 8): SemanticMatch[] {
        return this.index.related(id, limit);
    }

    documents(): SemanticDocument[] {
        return this.index.getRecords().map(publicDocument);
    }

    suggest(query: string, excludeId?: string): SemanticSuggestions {
        return this.index.suggest(query, excludeId);
    }

    findNearDuplicateGroups(threshold = 0.82): string[][] {
        return this.index.findNearDuplicateGroups(threshold);
    }

    clusterConcepts(threshold = 0.48): string[][] {
        return this.index.clusterConcepts(threshold);
    }

    async clear(): Promise<void> {
        this.index.clear();
        await this.storage.clear();
        this.ready = false;
    }

    get status(): { ready: boolean; documents: number } {
        return { ready: this.ready, documents: this.index.size };
    }

    close(): void {
        this.storage.close();
    }
}
