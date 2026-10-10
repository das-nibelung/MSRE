import { TFile, Vault } from "obsidian";

import {
    BACK_FIELD_ID,
    BASIC_NOTE_TYPE_ID,
    EXTRA_FIELD_ID,
    FRONT_FIELD_ID,
    getBuiltinNoteTypes,
    noteTypeIdForNativeType,
    TEXT_FIELD_ID,
} from "src/data/collection/builtin-note-types";
import {
    CardFlag,
    CardLifecycleState,
    COLLECTION_SCHEMA_VERSION,
    CollectionCard,
    CollectionData,
    CollectionDeck,
    CollectionNote,
    CollectionNoteInput,
    DeckOptionsDefinition,
    LegacyCardInput,
    NativeNoteInput,
    NoteTypeDefinition,
    RecordReviewInput,
    REVIEW_LOG_SCHEMA_VERSION,
    ReviewLogData,
    ReviewLogEntry,
} from "src/data/collection/collection-types";

export const COLLECTION_FOLDER = "Spaced Repetition";
export const COLLECTION_PATH = `${COLLECTION_FOLDER}/collection-data.sr.md`;
export const REVIEW_LOG_PATH = `${COLLECTION_FOLDER}/review-history.sr.md`;

const JSON_BLOCK = /```json\s*([\s\S]*?)\s*```/i;
export const DEFAULT_DECK_ID = "builtin-default-deck";
export const DEFAULT_DECK_OPTIONS_ID = "builtin-default-options";

export interface CollectionStorage {
    readCollection(): Promise<string | null>;
    writeCollection(content: string): Promise<void>;
    readReviewLog(): Promise<string | null>;
    writeReviewLog(content: string): Promise<void>;
}

export class VaultCollectionStorage implements CollectionStorage {
    constructor(private readonly vault: Vault) {}

    readCollection(): Promise<string | null> {
        return this.read(COLLECTION_PATH);
    }

    writeCollection(content: string): Promise<void> {
        return this.write(COLLECTION_PATH, content);
    }

    readReviewLog(): Promise<string | null> {
        return this.read(REVIEW_LOG_PATH);
    }

    writeReviewLog(content: string): Promise<void> {
        return this.write(REVIEW_LOG_PATH, content);
    }

    private async read(path: string): Promise<string | null> {
        const file = this.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? await this.vault.read(file) : null;
    }

    private async write(path: string, content: string): Promise<void> {
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.vault.modify(file, content);
            return;
        }
        if (!this.vault.getAbstractFileByPath(COLLECTION_FOLDER)) {
            await this.vault.createFolder(COLLECTION_FOLDER);
        }
        await this.vault.create(path, content);
    }
}

function emptyCollection(): CollectionData {
    const defaultOptions: DeckOptionsDefinition = {
        id: DEFAULT_DECK_OPTIONS_ID,
        name: "Default",
        newCardsPerDay: 20,
        reviewsPerDay: 200,
        desiredRetention: 0.9,
        newCardOrder: "sequential",
        createdAt: 0,
        updatedAt: 0,
    };
    const defaultDeck: CollectionDeck = {
        id: DEFAULT_DECK_ID,
        name: "",
        parentId: null,
        optionsId: DEFAULT_DECK_OPTIONS_ID,
        description: "",
        createdAt: 0,
        updatedAt: 0,
    };
    return {
        schemaVersion: COLLECTION_SCHEMA_VERSION,
        revision: 0,
        updatedAt: 0,
        noteTypes: Object.fromEntries(getBuiltinNoteTypes().map((type) => [type.id, type])),
        deckOptions: { [defaultOptions.id]: defaultOptions },
        decks: { [defaultDeck.id]: defaultDeck },
        notes: {},
        cards: {},
    };
}

function emptyReviewLog(): ReviewLogData {
    return {
        schemaVersion: REVIEW_LOG_SCHEMA_VERSION,
        revision: 0,
        updatedAt: 0,
        entries: {},
    };
}

function parseJsonBlock(content: string | null): unknown {
    if (!content) return null;
    const json = content.match(JSON_BLOCK)?.[1];
    if (!json) return null;
    return JSON.parse(json);
}

function asRecord<T>(value: unknown): Record<string, T> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, T>;
}

/** Sequential migrations keep vault data readable when the collection schema evolves. */
export function migrateCollection(value: unknown): CollectionData {
    const base = emptyCollection();
    if (!value || typeof value !== "object") return base;
    const raw = value as Partial<CollectionData> & { version?: number };
    const version = raw.schemaVersion ?? raw.version ?? 0;
    if (version > COLLECTION_SCHEMA_VERSION) {
        throw new Error(`Unsupported collection schema ${version}`);
    }

    // Version 0 was the development preview. It used the same entities without revision metadata.
    const migrated: CollectionData = {
        schemaVersion: COLLECTION_SCHEMA_VERSION,
        revision: typeof raw.revision === "number" ? raw.revision : 0,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        noteTypes: {
            ...base.noteTypes,
            ...asRecord<NoteTypeDefinition>(raw.noteTypes),
        },
        deckOptions: {
            ...base.deckOptions,
            ...asRecord<DeckOptionsDefinition>(raw.deckOptions),
        },
        decks: { ...base.decks, ...asRecord<CollectionDeck>(raw.decks) },
        notes: asRecord<CollectionNote>(raw.notes),
        cards: Object.fromEntries(
            Object.entries(asRecord<CollectionCard>(raw.cards)).map(([id, card]) => [
                id,
                { ...card, buriedUntil: card.buriedUntil ?? null, flag: card.flag ?? 0 },
            ]),
        ),
    };
    return migrated;
}

export function parseCollection(content: string | null): CollectionData {
    try {
        return migrateCollection(parseJsonBlock(content));
    } catch (error) {
        console.warn("MSRE: Unable to parse collection data", error);
        return emptyCollection();
    }
}

export function parseReviewLog(content: string | null): ReviewLogData {
    try {
        const raw = parseJsonBlock(content) as Partial<ReviewLogData> | null;
        if (!raw) return emptyReviewLog();
        const version = raw.schemaVersion ?? 0;
        if (version > REVIEW_LOG_SCHEMA_VERSION) {
            throw new Error(`Unsupported review log schema ${version}`);
        }
        return {
            schemaVersion: REVIEW_LOG_SCHEMA_VERSION,
            revision: typeof raw.revision === "number" ? raw.revision : 0,
            updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
            entries: asRecord<ReviewLogEntry>(raw.entries),
        };
    } catch (error) {
        console.warn("MSRE: Unable to parse review history", error);
        return emptyReviewLog();
    }
}

function entityTimestamp(entity: { updatedAt: number; deletedAt?: number }): number {
    return Math.max(entity.updatedAt, entity.deletedAt ?? 0);
}

function mergeEntityRecords<T extends { updatedAt: number; deletedAt?: number }>(
    left: Record<string, T>,
    right: Record<string, T>,
): Record<string, T> {
    const merged: Record<string, T> = {};
    for (const id of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const leftEntity = left[id];
        const rightEntity = right[id];
        if (!leftEntity) merged[id] = rightEntity;
        else if (!rightEntity) merged[id] = leftEntity;
        else
            merged[id] =
                entityTimestamp(leftEntity) >= entityTimestamp(rightEntity)
                    ? leftEntity
                    : rightEntity;
    }
    return merged;
}

export function mergeCollections(left: CollectionData, right: CollectionData): CollectionData {
    return {
        schemaVersion: COLLECTION_SCHEMA_VERSION,
        revision: Math.max(left.revision, right.revision),
        updatedAt: Math.max(left.updatedAt, right.updatedAt),
        noteTypes: mergeEntityRecords(left.noteTypes, right.noteTypes),
        deckOptions: mergeEntityRecords(left.deckOptions, right.deckOptions),
        decks: mergeEntityRecords(left.decks, right.decks),
        notes: mergeEntityRecords(left.notes, right.notes),
        cards: mergeEntityRecords(left.cards, right.cards),
    };
}

function reviewTimestamp(entry: ReviewLogEntry): number {
    return Math.max(entry.reviewedAt, entry.deletedAt ?? 0);
}

export function mergeReviewLogs(left: ReviewLogData, right: ReviewLogData): ReviewLogData {
    const entries: Record<string, ReviewLogEntry> = {};
    for (const id of new Set([...Object.keys(left.entries), ...Object.keys(right.entries)])) {
        const leftEntry = left.entries[id];
        const rightEntry = right.entries[id];
        if (!leftEntry) entries[id] = rightEntry;
        else if (!rightEntry) entries[id] = leftEntry;
        else
            entries[id] =
                reviewTimestamp(leftEntry) >= reviewTimestamp(rightEntry) ? leftEntry : rightEntry;
    }
    return {
        schemaVersion: REVIEW_LOG_SCHEMA_VERSION,
        revision: Math.max(left.revision, right.revision),
        updatedAt: Math.max(left.updatedAt, right.updatedAt),
        entries,
    };
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(
        Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
    );
}

function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeTags(tags: string[]): string[] {
    return [...new Set(tags.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right),
    );
}

export function formatCollection(data: CollectionData): string {
    const stable = {
        ...data,
        noteTypes: sortRecord(data.noteTypes),
        deckOptions: sortRecord(data.deckOptions),
        decks: sortRecord(data.decks),
        notes: sortRecord(data.notes),
        cards: sortRecord(data.cards),
    };
    return `# MSRE collection data

This file is managed automatically. It contains note types, notes, and generated cards.

\`\`\`json
${JSON.stringify(stable, null, 2)}
\`\`\`
`;
}

export function formatReviewLog(data: ReviewLogData): string {
    return `# MSRE review history

This file is managed automatically. It contains the immutable review history used for statistics.

\`\`\`json
${JSON.stringify({ ...data, entries: sortRecord(data.entries) }, null, 2)}
\`\`\`
`;
}

function randomId(prefix: string): string {
    const uuid =
        globalThis.crypto?.randomUUID?.() ??
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${uuid}`;
}

function fieldsForNativeInput(input: Pick<NativeNoteInput, "type" | "front" | "back">) {
    if (input.type !== "cloze") {
        return { [FRONT_FIELD_ID]: input.front, [BACK_FIELD_ID]: input.back };
    }
    const answerIndex = input.front.indexOf(input.back);
    const text =
        answerIndex < 0
            ? input.front
            : `${input.front.slice(0, answerIndex)}{{c1::${input.back}}}${input.front.slice(
                  answerIndex + input.back.length,
              )}`;
    return { [TEXT_FIELD_ID]: text, [EXTRA_FIELD_ID]: "" };
}

export class CollectionStore {
    private collection: CollectionData = emptyCollection();
    private reviewLog: ReviewLogData = emptyReviewLog();
    private initialized = false;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly storage: CollectionStorage,
        private readonly now: () => number = () => Date.now(),
        private readonly idFactory: (prefix: string) => string = randomId,
    ) {}

    createId(prefix: string): string {
        return this.idFactory(prefix);
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        const [collectionText, reviewText] = await Promise.all([
            this.storage.readCollection(),
            this.storage.readReviewLog(),
        ]);
        this.collection = parseCollection(collectionText);
        this.reviewLog = parseReviewLog(reviewText);
        this.initialized = true;
    }

    async reload(): Promise<void> {
        await this.initialize();
        const [collectionText, reviewText] = await Promise.all([
            this.storage.readCollection(),
            this.storage.readReviewLog(),
        ]);
        this.collection = mergeCollections(this.collection, parseCollection(collectionText));
        this.reviewLog = mergeReviewLogs(this.reviewLog, parseReviewLog(reviewText));
    }

    reset(): void {
        this.collection = emptyCollection();
        this.reviewLog = emptyReviewLog();
        this.initialized = true;
    }

    getCollectionSnapshot(): CollectionData {
        return cloneJson(this.collection);
    }

    getReviewLogSnapshot(): ReviewLogData {
        return cloneJson(this.reviewLog);
    }

    getNoteTypes(): NoteTypeDefinition[] {
        return Object.values(this.collection.noteTypes)
            .filter((noteType) => !noteType.deletedAt)
            .map((noteType) => cloneJson(noteType))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    getNoteType(noteTypeId: string): NoteTypeDefinition | null {
        const noteType = this.collection.noteTypes[noteTypeId];
        return noteType && !noteType.deletedAt ? cloneJson(noteType) : null;
    }

    countNotesForType(noteTypeId: string): number {
        return Object.values(this.collection.notes).filter(
            (note) => !note.deletedAt && note.noteTypeId === noteTypeId,
        ).length;
    }

    getDecks(): CollectionDeck[] {
        return Object.values(this.collection.decks)
            .filter((deck) => !deck.deletedAt && deck.id !== DEFAULT_DECK_ID)
            .map((deck) => cloneJson(deck))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    getDeck(deckPath: string): CollectionDeck | null {
        const normalized = this.normalizeDeckPath(deckPath);
        const deck = Object.values(this.collection.decks).find(
            (candidate) => !candidate.deletedAt && candidate.name === normalized,
        );
        return deck ? cloneJson(deck) : null;
    }

    getDeckOptions(): DeckOptionsDefinition[] {
        return Object.values(this.collection.deckOptions)
            .filter((options) => !options.deletedAt)
            .map((options) => cloneJson(options))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    getDeckOptionsById(optionsId: string): DeckOptionsDefinition | null {
        const options = this.collection.deckOptions[optionsId];
        return options && !options.deletedAt ? cloneJson(options) : null;
    }

    getDeckOptionsForPath(deckPath: string): DeckOptionsDefinition {
        const deck = this.getDeck(deckPath);
        const options = deck ? this.collection.deckOptions[deck.optionsId] : null;
        return cloneJson(
            options && !options.deletedAt
                ? options
                : this.collection.deckOptions[DEFAULT_DECK_OPTIONS_ID],
        );
    }

    countDecksForOptions(optionsId: string): number {
        return Object.values(this.collection.decks).filter(
            (deck) =>
                !deck.deletedAt && deck.id !== DEFAULT_DECK_ID && deck.optionsId === optionsId,
        ).length;
    }

    findNoteBySource(sourcePath: string, questionId?: string | null): CollectionNote | null {
        const notes = Object.values(this.collection.notes).filter((note) => !note.deletedAt);
        if (questionId) {
            const exact = notes.find((note) => note.source.questionId === questionId);
            if (exact) return exact;
        }
        return notes.find((note) => note.source.path === sourcePath) ?? null;
    }

    getCardByLegacyStableId(legacyStableId: string | null): CollectionCard | null {
        if (!legacyStableId) return null;
        const card = Object.values(this.collection.cards).find(
            (candidate) => !candidate.deletedAt && candidate.legacyStableId === legacyStableId,
        );
        return card ? cloneJson(card) : null;
    }

    isLegacyCardReviewable(legacyStableId: string | null, timestamp = this.now()): boolean {
        const card = this.getCardByLegacyStableId(legacyStableId);
        if (!card || card.state === "active") return true;
        if (card.state === "suspended") return false;
        return card.buriedUntil !== null && card.buriedUntil <= timestamp;
    }

    async setLegacyCardsState(
        inputs: LegacyCardInput[],
        state: CardLifecycleState,
        buriedUntil: number | null = null,
    ): Promise<CollectionCard[]> {
        await this.initialize();
        const timestamp = this.now();
        const changedCards = new Map<string, CollectionCard>();
        for (const input of inputs) {
            const { card } = this.ensureLegacyCard(input);
            card.state = state;
            card.buriedUntil = state === "buried" ? buriedUntil : null;
            card.updatedAt = timestamp;
            changedCards.set(card.id, card);
        }
        if (changedCards.size > 0) await this.persistCollection();
        return [...changedCards.values()].map((card) => cloneJson(card));
    }

    async setLegacyCardsFlag(inputs: LegacyCardInput[], flag: CardFlag): Promise<CollectionCard[]> {
        await this.initialize();
        const timestamp = this.now();
        const changedCards = new Map<string, CollectionCard>();
        for (const input of inputs) {
            const { card } = this.ensureLegacyCard(input);
            card.flag = flag;
            card.updatedAt = timestamp;
            changedCards.set(card.id, card);
        }
        if (changedCards.size > 0) await this.persistCollection();
        return [...changedCards.values()].map((card) => cloneJson(card));
    }

    async restoreExpiredBuriedCards(timestamp = this.now()): Promise<number> {
        await this.initialize();
        const expired = Object.values(this.collection.cards).filter(
            (card) =>
                !card.deletedAt &&
                card.state === "buried" &&
                card.buriedUntil !== null &&
                card.buriedUntil <= timestamp,
        );
        for (const card of expired) {
            card.state = "active";
            card.buriedUntil = null;
            card.updatedAt = timestamp;
        }
        if (expired.length > 0) await this.persistCollection();
        return expired.length;
    }

    async createNativeNote(input: NativeNoteInput): Promise<CollectionNote> {
        await this.initialize();
        const timestamp = this.now();
        const noteTypeId = noteTypeIdForNativeType(input.type);
        const noteType = this.collection.noteTypes[noteTypeId];
        const id = input.id ?? this.createId("note");
        const fields = fieldsForNativeInput(input);
        const note: CollectionNote = {
            id,
            noteTypeId,
            fields,
            tags: normalizeTags(input.tags ?? []),
            source: { kind: "managed", path: input.sourcePath, questionId: input.questionId },
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.collection.notes[id] = note;
        const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
        this.replaceGeneratedCards(note, noteType, deck, input.questionId, timestamp);
        await this.persistCollection();
        return note;
    }

    async saveNoteType(
        definition: Omit<NoteTypeDefinition, "createdAt" | "updatedAt"> &
            Partial<Pick<NoteTypeDefinition, "createdAt">>,
    ): Promise<NoteTypeDefinition> {
        await this.initialize();
        const timestamp = this.now();
        const existing = this.collection.noteTypes[definition.id];
        const noteType: NoteTypeDefinition = {
            ...definition,
            fields: definition.fields.map((field) => ({ ...field })),
            templates: definition.templates.map((template) => ({ ...template })),
            createdAt: existing?.createdAt ?? definition.createdAt ?? timestamp,
            updatedAt: timestamp,
        };
        this.collection.noteTypes[noteType.id] = noteType;
        await this.persistCollection();
        return noteType;
    }

    async deleteNoteType(noteTypeId: string): Promise<void> {
        await this.initialize();
        if (noteTypeId.startsWith("builtin-")) throw new Error("builtin-note-type");
        const noteType = this.collection.noteTypes[noteTypeId];
        if (!noteType || noteType.deletedAt) return;
        if (this.countNotesForType(noteTypeId) > 0) throw new Error("note-type-in-use");
        const timestamp = this.now();
        noteType.deletedAt = timestamp;
        noteType.updatedAt = timestamp;
        await this.persistCollection();
    }

    async saveDeckOptions(
        definition: Omit<DeckOptionsDefinition, "createdAt" | "updatedAt"> &
            Partial<Pick<DeckOptionsDefinition, "createdAt">>,
    ): Promise<DeckOptionsDefinition> {
        await this.initialize();
        if (!definition.name.trim()) throw new Error("deck-options-name-required");
        if (!Number.isInteger(definition.newCardsPerDay) || definition.newCardsPerDay < 0) {
            throw new Error("invalid-new-card-limit");
        }
        if (!Number.isInteger(definition.reviewsPerDay) || definition.reviewsPerDay < 0) {
            throw new Error("invalid-review-limit");
        }
        if (definition.desiredRetention < 0.7 || definition.desiredRetention > 0.99) {
            throw new Error("invalid-desired-retention");
        }
        const timestamp = this.now();
        const existing = this.collection.deckOptions[definition.id];
        const options: DeckOptionsDefinition = {
            ...definition,
            name: definition.name.trim(),
            createdAt: existing?.createdAt ?? definition.createdAt ?? timestamp,
            updatedAt: timestamp,
        };
        this.collection.deckOptions[options.id] = options;
        await this.persistCollection();
        return cloneJson(options);
    }

    async updateDeck(
        deckPath: string,
        changes: { description?: string; optionsId?: string },
    ): Promise<CollectionDeck> {
        await this.initialize();
        const deck = this.ensureDeckPathInMemory(deckPath, this.now());
        if (changes.optionsId) {
            const options = this.collection.deckOptions[changes.optionsId];
            if (!options || options.deletedAt) throw new Error("deck-options-not-found");
            deck.optionsId = options.id;
        }
        if (changes.description !== undefined) deck.description = changes.description.trim();
        deck.updatedAt = this.now();
        await this.persistCollection();
        return cloneJson(deck);
    }

    async deleteDeckOptions(optionsId: string): Promise<void> {
        await this.initialize();
        if (optionsId === DEFAULT_DECK_OPTIONS_ID) throw new Error("builtin-deck-options");
        const options = this.collection.deckOptions[optionsId];
        if (!options || options.deletedAt) return;
        if (this.countDecksForOptions(optionsId) > 0) throw new Error("deck-options-in-use");
        const timestamp = this.now();
        options.deletedAt = timestamp;
        options.updatedAt = timestamp;
        await this.persistCollection();
    }

    async createNote(input: CollectionNoteInput): Promise<CollectionNote> {
        await this.initialize();
        const noteType = this.collection.noteTypes[input.noteTypeId];
        if (!noteType || noteType.deletedAt) throw new Error("note-type-not-found");
        for (const field of noteType.fields) {
            if (field.required && !input.fields[field.id]?.trim()) {
                throw new Error(`required-field-empty:${field.id}`);
            }
        }
        const timestamp = this.now();
        const id = input.id ?? this.createId("note");
        const note: CollectionNote = {
            id,
            noteTypeId: input.noteTypeId,
            fields: { ...input.fields },
            tags: normalizeTags(input.tags ?? []),
            source: { ...input.source },
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.collection.notes[id] = note;
        const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
        this.replaceGeneratedCards(
            note,
            noteType,
            deck,
            input.source.questionId ?? `^sr-data-id-${id}`,
            timestamp,
            input.legacyQuestionIds,
        );
        await this.persistCollection();
        return note;
    }

    async updateNote(
        noteId: string,
        input: Omit<CollectionNoteInput, "id" | "noteTypeId">,
    ): Promise<CollectionNote> {
        await this.initialize();
        const note = this.collection.notes[noteId];
        if (!note || note.deletedAt) throw new Error("note-not-found");
        const noteType = this.collection.noteTypes[note.noteTypeId];
        if (!noteType || noteType.deletedAt) throw new Error("note-type-not-found");
        for (const field of noteType.fields) {
            if (field.required && !input.fields[field.id]?.trim()) {
                throw new Error(`required-field-empty:${field.id}`);
            }
        }
        const timestamp = this.now();
        note.fields = { ...input.fields };
        note.tags = normalizeTags(input.tags ?? note.tags);
        note.source = { ...input.source };
        note.updatedAt = timestamp;
        const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
        this.replaceGeneratedCards(
            note,
            noteType,
            deck,
            input.source.questionId ?? `^sr-data-id-${note.id}`,
            timestamp,
            input.legacyQuestionIds,
        );
        await this.persistCollection();
        return note;
    }

    async deleteNote(noteId: string): Promise<void> {
        await this.initialize();
        const note = this.collection.notes[noteId];
        if (!note || note.deletedAt) return;
        const timestamp = this.now();
        note.deletedAt = timestamp;
        note.updatedAt = timestamp;
        for (const card of Object.values(this.collection.cards)) {
            if (card.noteId === noteId && !card.deletedAt) {
                card.deletedAt = timestamp;
                card.updatedAt = timestamp;
            }
        }
        await this.persistCollection();
    }

    async deleteNoteBySource(sourcePath: string, questionId?: string | null): Promise<void> {
        await this.initialize();
        const notes = Object.values(this.collection.notes).filter(
            (note) =>
                !note.deletedAt &&
                (questionId
                    ? note.source.questionId === questionId
                    : note.source.path === sourcePath),
        );
        if (notes.length === 0) return;
        const timestamp = this.now();
        const noteIds = new Set(notes.map((note) => note.id));
        for (const note of notes) {
            note.deletedAt = timestamp;
            note.updatedAt = timestamp;
        }
        for (const card of Object.values(this.collection.cards)) {
            if (noteIds.has(card.noteId) && !card.deletedAt) {
                card.deletedAt = timestamp;
                card.updatedAt = timestamp;
            }
        }
        await this.persistCollection();
    }

    async renameSourcePath(oldPath: string, newPath: string): Promise<void> {
        await this.initialize();
        const notes = Object.values(this.collection.notes).filter(
            (note) => !note.deletedAt && note.source.path === oldPath,
        );
        if (notes.length === 0) return;
        const timestamp = this.now();
        for (const note of notes) {
            note.source.path = newPath;
            note.updatedAt = timestamp;
        }
        await this.persistCollection();
    }

    async updateNativeNote(input: NativeNoteInput): Promise<CollectionNote> {
        await this.initialize();
        const existing = this.findNoteBySource(input.sourcePath, input.questionId);
        if (!existing) return await this.createNativeNote(input);
        const timestamp = this.now();
        existing.noteTypeId = noteTypeIdForNativeType(input.type);
        existing.fields = fieldsForNativeInput(input);
        existing.tags = normalizeTags(input.tags ?? existing.tags);
        existing.source.questionId = input.questionId;
        existing.updatedAt = timestamp;
        const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
        this.replaceGeneratedCards(
            existing,
            this.collection.noteTypes[existing.noteTypeId],
            deck,
            input.questionId,
            timestamp,
        );
        await this.persistCollection();
        return existing;
    }

    async ensureDeckPath(deckPath: string): Promise<CollectionDeck> {
        await this.initialize();
        const before = Object.keys(this.collection.decks).length;
        const deck = this.ensureDeckPathInMemory(deckPath, this.now());
        if (Object.keys(this.collection.decks).length !== before) await this.persistCollection();
        return deck;
    }

    async recordReview(input: RecordReviewInput): Promise<string> {
        await this.initialize();
        const { note, card, changed } = this.ensureLegacyCard(input);
        const reviewedAt = input.reviewedAt ?? this.now();
        const id = this.createId("review");
        this.reviewLog.entries[id] = {
            id,
            cardId: card.id,
            noteId: note.id,
            rating: input.rating,
            reviewedAt,
            durationMs: input.durationMs ?? null,
            mode: input.mode ?? "review",
            previousSchedule: input.previousSchedule,
            nextSchedule: input.nextSchedule,
        };
        card.schedule = input.nextSchedule;
        card.queue = input.nextSchedule ? "review" : "new";
        card.reps++;
        if (input.rating === 1 && input.previousSchedule) card.lapses++;
        card.lastReviewAt = reviewedAt;
        card.updatedAt = reviewedAt;
        if (changed) note.updatedAt = reviewedAt;
        await this.persistCollection();
        await this.persistReviewLog();
        return id;
    }

    async removeReview(reviewId: string): Promise<void> {
        await this.initialize();
        const entry = this.reviewLog.entries[reviewId];
        if (!entry || entry.deletedAt) return;
        entry.deletedAt = this.now();
        await this.persistReviewLog();
    }

    private ensureLegacyCard(input: LegacyCardInput): {
        note: CollectionNote;
        card: CollectionCard;
        changed: boolean;
    } {
        let changed = false;
        let note = this.findNoteBySource(input.sourcePath, input.questionId);
        const timestamp = this.now();
        if (!note) {
            const noteId = this.createId("note");
            note = {
                id: noteId,
                noteTypeId: BASIC_NOTE_TYPE_ID,
                fields: { [FRONT_FIELD_ID]: input.front, [BACK_FIELD_ID]: input.back },
                tags: [],
                source: {
                    kind: "markdown",
                    path: input.sourcePath,
                    questionId: input.questionId,
                },
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.collection.notes[noteId] = note;
            changed = true;
        }
        const legacyStableId = input.questionId ? `${input.questionId}:${input.ordinal}` : null;
        const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
        let card = Object.values(this.collection.cards).find(
            (candidate) =>
                !candidate.deletedAt &&
                candidate.noteId === note.id &&
                (candidate.legacyStableId === legacyStableId ||
                    candidate.ordinal === input.ordinal),
        );
        if (!card) {
            card = {
                id: this.createId("card"),
                noteId: note.id,
                templateId: "builtin-basic-card",
                ordinal: input.ordinal,
                deckId: deck.id,
                deckPath: input.deckPath,
                state: "active",
                buriedUntil: null,
                flag: 0,
                queue: "new",
                schedule: null,
                reps: 0,
                lapses: 0,
                lastReviewAt: null,
                legacyStableId,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.collection.cards[card.id] = card;
            changed = true;
        }
        return { note, card, changed };
    }

    private replaceGeneratedCards(
        note: CollectionNote,
        noteType: NoteTypeDefinition,
        deck: CollectionDeck,
        questionId: string,
        timestamp: number,
        legacyQuestionIds?: Record<number, string>,
    ): void {
        const existing = Object.values(this.collection.cards).filter(
            (card) => card.noteId === note.id && !card.deletedAt,
        );
        const templates = noteType.templates.filter((template) => template.enabled);
        const specs =
            noteType.kind === "cloze"
                ? this.getClozeOrdinals(note).flatMap((ordinal) =>
                      templates.map((template) => ({ template, ordinal })),
                  )
                : noteType.kind === "image-occlusion"
                  ? this.getImageOcclusionOrdinals(note).flatMap((ordinal) =>
                        templates.map((template) => ({ template, ordinal })),
                    )
                  : templates.map((template) => ({ template, ordinal: template.ordinal }));
        for (const card of existing) {
            if (
                !specs.some(
                    ({ template, ordinal }) =>
                        template.id === card.templateId && ordinal === card.ordinal,
                )
            ) {
                card.deletedAt = timestamp;
                card.updatedAt = timestamp;
            }
        }
        for (const { template, ordinal } of specs) {
            const targetDeck = template.deckOverride
                ? this.ensureDeckPathInMemory(template.deckOverride, timestamp)
                : deck;
            const current = existing.find(
                (card) => card.templateId === template.id && card.ordinal === ordinal,
            );
            if (current) {
                current.deckId = targetDeck.id;
                current.deckPath = targetDeck.name;
                current.ordinal = ordinal;
                current.legacyStableId = legacyQuestionIds?.[ordinal]
                    ? `${legacyQuestionIds[ordinal]}:0`
                    : `${questionId}:${ordinal}`;
                current.updatedAt = timestamp;
                continue;
            }
            const card: CollectionCard = {
                id: this.createId("card"),
                noteId: note.id,
                templateId: template.id,
                ordinal,
                deckId: targetDeck.id,
                deckPath: targetDeck.name,
                state: "active",
                buriedUntil: null,
                flag: 0,
                queue: "new",
                schedule: null,
                reps: 0,
                lapses: 0,
                lastReviewAt: null,
                legacyStableId: legacyQuestionIds?.[ordinal]
                    ? `${legacyQuestionIds[ordinal]}:0`
                    : `${questionId}:${ordinal}`,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.collection.cards[card.id] = card;
        }
    }

    private getImageOcclusionOrdinals(note: CollectionNote): number[] {
        try {
            const masks = JSON.parse(note.fields.masks ?? "[]") as unknown[];
            return masks.map((_mask, index) => index);
        } catch {
            return [];
        }
    }

    private getClozeOrdinals(note: CollectionNote): number[] {
        const numbers = new Set<number>();
        for (const value of Object.values(note.fields)) {
            for (const match of value.matchAll(/{{c(\d+)::/gi)) {
                const number = Number(match[1]);
                if (number > 0) numbers.add(number - 1);
            }
        }
        return numbers.size > 0 ? [...numbers].sort((left, right) => left - right) : [0];
    }

    private ensureDeckPathInMemory(deckPath: string, timestamp: number): CollectionDeck {
        const normalized = this.normalizeDeckPath(deckPath);
        if (!normalized) return this.collection.decks[DEFAULT_DECK_ID];

        let parent = this.collection.decks[DEFAULT_DECK_ID];
        const segments = normalized.split("/");
        for (let index = 0; index < segments.length; index++) {
            const name = segments.slice(0, index + 1).join("/");
            let deck = Object.values(this.collection.decks).find(
                (candidate) => !candidate.deletedAt && candidate.name === name,
            );
            if (!deck) {
                deck = {
                    id: this.createId("deck"),
                    name,
                    parentId: parent.id === DEFAULT_DECK_ID ? null : parent.id,
                    optionsId: DEFAULT_DECK_OPTIONS_ID,
                    description: "",
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
                this.collection.decks[deck.id] = deck;
            }
            parent = deck;
        }
        return parent;
    }

    private normalizeDeckPath(deckPath: string): string {
        return deckPath
            .split("/")
            .map((segment) => segment.trim())
            .filter(Boolean)
            .join("/");
    }

    private async persistCollection(): Promise<void> {
        const operation = this.writeQueue.then(async () => {
            const onDisk = parseCollection(await this.storage.readCollection());
            this.collection = mergeCollections(this.collection, onDisk);
            this.collection.revision++;
            this.collection.updatedAt = this.now();
            await this.storage.writeCollection(formatCollection(this.collection));
        });
        this.writeQueue = operation.catch((error) =>
            console.warn("MSRE: collection write failed", error),
        );
        await operation;
    }

    private async persistReviewLog(): Promise<void> {
        const operation = this.writeQueue.then(async () => {
            const onDisk = parseReviewLog(await this.storage.readReviewLog());
            this.reviewLog = mergeReviewLogs(this.reviewLog, onDisk);
            this.reviewLog.revision++;
            this.reviewLog.updatedAt = this.now();
            await this.storage.writeReviewLog(formatReviewLog(this.reviewLog));
        });
        this.writeQueue = operation.catch((error) =>
            console.warn("MSRE: review log write failed", error),
        );
        await operation;
    }
}
