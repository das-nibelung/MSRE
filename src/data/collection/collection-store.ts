import { TFile, Vault } from "obsidian";

import { canonicalAnswerMode, normalizeAnswerConfig } from "src/data/collection/answer-evaluator";
import {
    BACK_FIELD_ID,
    BASIC_NOTE_TYPE_ID,
    EXTRA_FIELD_ID,
    FRONT_FIELD_ID,
    getBuiltinNoteTypes,
    IMAGE_OCCLUSION_NOTE_TYPE_ID,
    noteTypeIdForNativeType,
    TEXT_FIELD_ID,
} from "src/data/collection/builtin-note-types";
import {
    CardFlag,
    CardLifecycleState,
    COLLECTION_SCHEMA_VERSION,
    CollectionBackupData,
    CollectionBackupDescriptor,
    CollectionCard,
    CollectionConflict,
    CollectionData,
    CollectionDeck,
    CollectionEditHistoryEntry,
    CollectionEntityKind,
    CollectionIntegrityIssue,
    CollectionIntegrityReport,
    CollectionNote,
    CollectionNoteInput,
    DeckOptionsDefinition,
    EmptyGeneratedCard,
    LegacyCardInput,
    NativeNoteInput,
    NoteConversionPreview,
    NoteTypeChangePreview,
    NoteTypeDefinition,
    RecordReviewInput,
    REVIEW_LOG_SCHEMA_VERSION,
    ReviewLogData,
    ReviewLogEntry,
    ReviewRating,
} from "src/data/collection/collection-types";
import { FileNativeCatalog, FileNativeNoteRecord } from "src/data/file-native/file-native-format";
import { AtomicVaultWriter } from "src/data/reliability/atomic-vault-writer";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";
import { intervalForRetention } from "src/scheduling/fsrs/scheduler-analytics";

export const COLLECTION_FOLDER = "Spaced Repetition";
export const COLLECTION_PATH = `${COLLECTION_FOLDER}/collection-data.sr.md`;
export const REVIEW_LOG_PATH = `${COLLECTION_FOLDER}/review-history.sr.md`;
export const COLLECTION_BACKUP_FOLDER = `${COLLECTION_FOLDER}/Backups`;

const JSON_BLOCK = /```json\s*([\s\S]*?)\s*```/i;
export const DEFAULT_DECK_ID = "builtin-default-deck";
export const DEFAULT_DECK_OPTIONS_ID = "builtin-default-options";

export interface CollectionStorage {
    readCollection(): Promise<string | null>;
    writeCollection(content: string): Promise<void>;
    readReviewLog(): Promise<string | null>;
    writeReviewLog(content: string): Promise<void>;
    writeBackup?(path: string, content: string): Promise<void>;
    readBackup?(path: string): Promise<string | null>;
    listBackups?(): Promise<string[]>;
    pathExists?(path: string): Promise<boolean>;
}

export class VaultCollectionStorage implements CollectionStorage {
    constructor(
        private readonly vault: Vault,
        private readonly writer?: AtomicVaultWriter,
    ) {}

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

    writeBackup(path: string, content: string): Promise<void> {
        return this.write(path, content);
    }

    readBackup(path: string): Promise<string | null> {
        return this.read(path);
    }

    listBackups(): Promise<string[]> {
        return Promise.resolve(
            this.vault
                .getFiles()
                .filter((file) => file.path.startsWith(`${COLLECTION_BACKUP_FOLDER}/`))
                .map((file) => file.path)
                .sort((left, right) => right.localeCompare(left)),
        );
    }

    pathExists(path: string): Promise<boolean> {
        const normalized = path.replace(/^\/+/, "");
        return Promise.resolve(
            this.vault
                .getFiles()
                .some((file) => file.path === normalized || file.name === normalized),
        );
    }

    private async read(path: string): Promise<string | null> {
        const file = this.vault.getAbstractFileByPath(path);
        return file instanceof TFile ? await this.vault.read(file) : null;
    }

    private async write(path: string, content: string): Promise<void> {
        if (this.writer) {
            await this.writer.writeText(path, content, {
                backup: !path.startsWith(`${COLLECTION_BACKUP_FOLDER}/`),
            });
            return;
        }
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.vault.modify(file, content);
            return;
        }
        if (!this.vault.getAbstractFileByPath(COLLECTION_FOLDER)) {
            await this.vault.createFolder(COLLECTION_FOLDER);
        }
        if (
            path.startsWith(`${COLLECTION_BACKUP_FOLDER}/`) &&
            !this.vault.getAbstractFileByPath(COLLECTION_BACKUP_FOLDER)
        ) {
            await this.vault.createFolder(COLLECTION_BACKUP_FOLDER);
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
        fsrsWeights: null,
        learningSteps: [1, 10],
        relearningSteps: [10],
        leechThreshold: 8,
        leechAction: "tag",
        loadBalance: true,
        reviewAheadDays: 0,
        priority: 0,
        minutesPerDay: 0,
        burySiblings: "inherit",
        optimization: null,
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
        editHistory: {},
        conflicts: {},
    };
}

function normalizeDeckOptions(
    options: DeckOptionsDefinition,
    fallback: DeckOptionsDefinition,
): DeckOptionsDefinition {
    const sanitizeSteps = (value: unknown, defaults: number[]): number[] =>
        Array.isArray(value)
            ? value
                  .map(Number)
                  .filter((step) => Number.isFinite(step) && step > 0)
                  .map((step) => Math.round(step))
            : [...defaults];
    return {
        ...fallback,
        ...options,
        fsrsWeights:
            Array.isArray(options.fsrsWeights) && options.fsrsWeights.length > 0
                ? options.fsrsWeights.map(Number).filter(Number.isFinite)
                : null,
        learningSteps: sanitizeSteps(options.learningSteps, fallback.learningSteps ?? [1, 10]),
        relearningSteps: sanitizeSteps(options.relearningSteps, fallback.relearningSteps ?? [10]),
        leechThreshold: Math.max(1, Math.round(Number(options.leechThreshold) || 8)),
        leechAction: options.leechAction === "suspend" ? "suspend" : "tag",
        loadBalance: options.loadBalance !== false,
        reviewAheadDays: Math.max(
            0,
            Math.min(365, Math.round(Number(options.reviewAheadDays) || 0)),
        ),
        priority: Math.max(-100, Math.min(100, Math.round(Number(options.priority) || 0))),
        minutesPerDay: Math.max(0, Math.min(1440, Number(options.minutesPerDay) || 0)),
        burySiblings: ["off", "new", "review", "all"].includes(options.burySiblings ?? "")
            ? options.burySiblings
            : "inherit",
        optimization:
            options.optimization && typeof options.optimization === "object"
                ? options.optimization
                : null,
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

export function createCardStableKey(noteId: string, templateId: string, variantId: string): string {
    return `${noteId}::${templateId}::${variantId}`;
}

function getImageOcclusionVariantIds(note: CollectionNote): string[] {
    try {
        const masks = JSON.parse(note.fields.masks ?? "[]") as Array<{
            id?: string;
            groupId?: string | null;
        }>;
        return [
            ...new Set(
                masks.map(
                    (mask, index) => mask.groupId?.trim() || mask.id?.trim() || `mask-${index + 1}`,
                ),
            ),
        ];
    } catch {
        return [];
    }
}

function normalizeTemplate(
    template: NoteTypeDefinition["templates"][number],
    fallbackKind: NoteTypeDefinition["kind"],
): NoteTypeDefinition["templates"][number] {
    return {
        ...template,
        version: Math.max(1, Number(template.version) || 1),
        generator: template.generator ?? fallbackKind,
        answerMode: canonicalAnswerMode(template.answerMode),
        answerConfig: normalizeAnswerConfig(template.answerConfig),
        answerFieldId: template.answerFieldId ?? null,
        sourceFieldId: template.sourceFieldId ?? null,
        condition: template.condition ?? { operator: "always", fieldId: null, value: "" },
        css: template.css ?? "",
        editorMode: template.editorMode ?? "advanced",
        questionBlocks: (template.questionBlocks ?? []).map((block) => ({
            ...block,
            condition: block.condition ?? {
                operator: "always",
                fieldId: null,
                value: "",
            },
        })),
        answerBlocks: (template.answerBlocks ?? []).map((block) => ({
            ...block,
            condition: block.condition ?? {
                operator: "always",
                fieldId: null,
                value: "",
            },
        })),
        browserBlocks: (template.browserBlocks ?? []).map((block) => ({
            ...block,
            condition: block.condition ?? {
                operator: "always",
                fieldId: null,
                value: "",
            },
        })),
        browserFormat: template.browserFormat ?? template.questionFormat,
        questionCss: template.questionCss ?? "",
        answerCss: template.answerCss ?? "",
        browserCss: template.browserCss ?? "",
    };
}

function templateConditionMatches(
    note: CollectionNote,
    template: NoteTypeDefinition["templates"][number],
): boolean {
    const condition = template.condition;
    if (!condition || condition.operator === "always") return true;
    const value = condition.fieldId ? (note.fields[condition.fieldId] ?? "").trim() : "";
    const expected = condition.value.trim();
    if (condition.operator === "not-empty") return value.length > 0;
    if (condition.operator === "empty") return value.length === 0;
    if (condition.operator === "equals") return value === expected;
    return value !== expected;
}

function renderTemplateText(
    format: string,
    note: CollectionNote,
    noteType: Pick<NoteTypeDefinition, "fields">,
): string {
    let result = format;
    for (const field of noteType.fields) {
        const value = note.fields[field.id] ?? "";
        result = result.split(`{{${field.id}}}`).join(value);
        result = result.split(`{{${field.name}}}`).join(value);
        result = result.split(`{{cloze:${field.id}}}`).join(value);
        result = result.split(`{{cloze:${field.name}}}`).join(value);
    }
    return result
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function deriveLegacyVariantId(
    card: CollectionCard,
    note: CollectionNote | undefined,
    noteType: NoteTypeDefinition | undefined,
): string {
    if (note?.source.kind === "markdown") return `legacy-${card.ordinal}`;
    if (noteType?.kind === "cloze") return `cloze-${card.ordinal + 1}`;
    if (noteType?.kind === "image-occlusion") {
        return getImageOcclusionVariantIds(note)[card.ordinal] ?? `mask-${card.ordinal + 1}`;
    }
    return "base";
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
    const noteTypes = Object.fromEntries(
        Object.entries({
            ...base.noteTypes,
            ...asRecord<NoteTypeDefinition>(raw.noteTypes),
        }).map(([id, noteType]) => {
            const builtin = base.noteTypes[id];
            const isLegacyOcclusion =
                id === IMAGE_OCCLUSION_NOTE_TYPE_ID &&
                Number(noteType.version ?? 1) < Number(builtin?.version ?? 1);
            const fields = (noteType.fields ?? []).map((field) => ({ ...field }));
            if (isLegacyOcclusion && builtin) {
                for (const field of builtin.fields) {
                    if (!fields.some((candidate) => candidate.id === field.id))
                        fields.push({ ...field });
                }
            }
            return [
                id,
                {
                    ...noteType,
                    version: Math.max(
                        1,
                        Number(noteType.version) || 1,
                        isLegacyOcclusion ? Number(builtin?.version ?? 1) : 1,
                    ),
                    fields,
                    templates: (noteType.templates ?? []).map((template) => {
                        const normalized = normalizeTemplate(template, noteType.kind);
                        return isLegacyOcclusion && template.generator === "image-occlusion"
                            ? { ...normalized, answerMode: "image-labels" as const }
                            : normalized;
                    }),
                },
            ];
        }),
    );
    const notes = asRecord<CollectionNote>(raw.notes);
    const migrated: CollectionData = {
        schemaVersion: COLLECTION_SCHEMA_VERSION,
        revision: typeof raw.revision === "number" ? raw.revision : 0,
        updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
        noteTypes,
        deckOptions: Object.fromEntries(
            Object.entries({
                ...base.deckOptions,
                ...asRecord<DeckOptionsDefinition>(raw.deckOptions),
            }).map(([id, options]) => [
                id,
                normalizeDeckOptions(options, base.deckOptions[DEFAULT_DECK_OPTIONS_ID]),
            ]),
        ),
        decks: { ...base.decks, ...asRecord<CollectionDeck>(raw.decks) },
        notes,
        cards: Object.fromEntries(
            Object.entries(asRecord<CollectionCard>(raw.cards)).map(([id, card]) => {
                const note = notes[card.noteId];
                const variantId =
                    card.variantId ||
                    deriveLegacyVariantId(card, note, noteTypes[note?.noteTypeId]);
                return [
                    id,
                    {
                        ...card,
                        variantId,
                        stableKey:
                            card.stableKey ||
                            createCardStableKey(card.noteId, card.templateId, variantId),
                        buriedUntil: card.buriedUntil ?? null,
                        flag: card.flag ?? 0,
                    },
                ];
            }),
        ),
        editHistory: asRecord<CollectionEditHistoryEntry>(raw.editHistory),
        conflicts: asRecord<CollectionConflict>(raw.conflicts),
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
        return migrateReviewLog(parseJsonBlock(content));
    } catch (error) {
        console.warn("MSRE: Unable to parse review history", error);
        return emptyReviewLog();
    }
}

function migrateReviewLog(value: unknown): ReviewLogData {
    const raw = value as Partial<ReviewLogData> | null;
    if (!raw || typeof raw !== "object") return emptyReviewLog();
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
}

function storedCollectionVersion(content: string | null): number | null {
    try {
        const raw = parseJsonBlock(content) as { schemaVersion?: number; version?: number } | null;
        if (!raw) return null;
        return raw.schemaVersion ?? raw.version ?? 0;
    } catch {
        return null;
    }
}

function entityTimestamp(entity: { updatedAt: number; deletedAt?: number }): number {
    return Math.max(entity.updatedAt, entity.deletedAt ?? 0);
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

function shortHash(value: string): string {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

function mergeEntityRecords<T extends { updatedAt: number; deletedAt?: number }>(
    entityKind: CollectionEntityKind,
    left: Record<string, T>,
    right: Record<string, T>,
    equalTimestampWinner: "deterministic" | "left" | "right" = "deterministic",
): { records: Record<string, T>; conflicts: Record<string, CollectionConflict> } {
    const merged: Record<string, T> = {};
    const conflicts: Record<string, CollectionConflict> = {};
    for (const id of new Set([...Object.keys(left), ...Object.keys(right)])) {
        const leftEntity = left[id];
        const rightEntity = right[id];
        if (!leftEntity) merged[id] = rightEntity;
        else if (!rightEntity) merged[id] = leftEntity;
        else {
            const leftTimestamp = entityTimestamp(leftEntity);
            const rightTimestamp = entityTimestamp(rightEntity);
            if (leftTimestamp !== rightTimestamp) {
                merged[id] = leftTimestamp > rightTimestamp ? leftEntity : rightEntity;
                continue;
            }
            const leftJson = canonicalJson(leftEntity);
            const rightJson = canonicalJson(rightEntity);
            if (leftJson === rightJson) {
                merged[id] = leftEntity;
                continue;
            }
            const winner =
                equalTimestampWinner === "deterministic"
                    ? leftJson >= rightJson
                        ? "left"
                        : "right"
                    : equalTimestampWinner;
            const winningValue = winner === "left" ? leftEntity : rightEntity;
            const losingValue = winner === "left" ? rightEntity : leftEntity;
            merged[id] = winningValue;
            const conflictId = `${entityKind}:${id}:${leftTimestamp}:${shortHash(
                `${leftJson}|${rightJson}`,
            )}`;
            conflicts[conflictId] = {
                id: conflictId,
                entityKind,
                entityId: id,
                detectedAt: leftTimestamp,
                winner,
                winningValue: cloneJson(winningValue),
                losingValue: cloneJson(losingValue),
            };
        }
    }
    return { records: merged, conflicts };
}

export function mergeCollections(
    left: CollectionData,
    right: CollectionData,
    equalTimestampWinner: "deterministic" | "left" | "right" = "deterministic",
): CollectionData {
    const noteTypes = mergeEntityRecords(
        "noteType",
        left.noteTypes,
        right.noteTypes,
        equalTimestampWinner,
    );
    const deckOptions = mergeEntityRecords(
        "deckOptions",
        left.deckOptions,
        right.deckOptions,
        equalTimestampWinner,
    );
    const decks = mergeEntityRecords("deck", left.decks, right.decks, equalTimestampWinner);
    const notes = mergeEntityRecords("note", left.notes, right.notes, equalTimestampWinner);
    const cards = mergeEntityRecords("card", left.cards, right.cards, equalTimestampWinner);
    const editHistory: Record<string, CollectionEditHistoryEntry> = {
        ...right.editHistory,
        ...left.editHistory,
    };
    return {
        schemaVersion: COLLECTION_SCHEMA_VERSION,
        revision: Math.max(left.revision, right.revision),
        updatedAt: Math.max(left.updatedAt, right.updatedAt),
        noteTypes: noteTypes.records,
        deckOptions: deckOptions.records,
        decks: decks.records,
        notes: notes.records,
        cards: cards.records,
        editHistory,
        conflicts: {
            ...left.conflicts,
            ...right.conflicts,
            ...noteTypes.conflicts,
            ...deckOptions.conflicts,
            ...decks.conflicts,
            ...notes.conflicts,
            ...cards.conflicts,
        },
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
        editHistory: sortRecord(data.editHistory),
        conflicts: sortRecord(data.conflicts),
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
    private changeListener: (() => Promise<void> | void) | null = null;

    constructor(
        private readonly storage: CollectionStorage,
        private readonly now: () => number = () => Date.now(),
        private readonly idFactory: (prefix: string) => string = randomId,
    ) {}

    createId(prefix: string): string {
        return this.idFactory(prefix);
    }

    setChangeListener(listener: (() => Promise<void> | void) | null): void {
        this.changeListener = listener;
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        const [collectionText, reviewText] = await Promise.all([
            this.storage.readCollection(),
            this.storage.readReviewLog(),
        ]);
        const previousSchemaVersion = storedCollectionVersion(collectionText);
        this.collection = parseCollection(collectionText);
        this.reviewLog = parseReviewLog(reviewText);
        this.initialized = true;
        if (
            collectionText &&
            previousSchemaVersion !== null &&
            previousSchemaVersion < COLLECTION_SCHEMA_VERSION
        ) {
            await this.writeBackupSnapshot(
                `before-schema-${previousSchemaVersion}-to-${COLLECTION_SCHEMA_VERSION}`,
                parseJsonBlock(collectionText),
                parseJsonBlock(reviewText) ?? this.reviewLog,
                previousSchemaVersion,
            );
            this.collection.revision++;
            this.collection.updatedAt = this.now();
            await this.storage.writeCollection(formatCollection(this.collection));
        }
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

    getNoteEditHistory(noteId: string): CollectionEditHistoryEntry[] {
        return Object.values(this.collection.editHistory)
            .reverse()
            .filter((entry) => entry.noteId === noteId)
            .sort((left, right) => right.changedAt - left.changedAt)
            .map(cloneJson);
    }

    /**
     * Hydrates portable definitions before file-native notes are reconciled. The collection file
     * remains a fast materialized view; definitions in library.sr.md survive cache deletion.
     */
    async importFileNativeCatalog(catalog: FileNativeCatalog): Promise<void> {
        await this.initialize();
        const timestamp = catalog.updatedAt || this.now();
        const noteTypeIds = new Set(catalog.noteTypes.map((item) => item.id));
        const optionsIds = new Set(catalog.deckOptions.map((item) => item.id));
        const deckIds = new Set(catalog.decks.map((item) => item.id));
        for (const noteType of Object.values(this.collection.noteTypes)) {
            if (!noteType.id.startsWith("builtin-") && !noteTypeIds.has(noteType.id)) {
                noteType.deletedAt = timestamp;
                noteType.updatedAt = timestamp;
            }
        }
        for (const options of Object.values(this.collection.deckOptions)) {
            if (options.id !== DEFAULT_DECK_OPTIONS_ID && !optionsIds.has(options.id)) {
                options.deletedAt = timestamp;
                options.updatedAt = timestamp;
            }
        }
        for (const deck of Object.values(this.collection.decks)) {
            if (deck.id !== DEFAULT_DECK_ID && !deckIds.has(deck.id)) {
                deck.deletedAt = timestamp;
                deck.updatedAt = timestamp;
            }
        }
        for (const noteType of catalog.noteTypes) {
            if (!noteType?.id) continue;
            this.collection.noteTypes[noteType.id] = cloneJson(noteType);
        }
        for (const options of catalog.deckOptions) {
            if (!options?.id) continue;
            this.collection.deckOptions[options.id] = cloneJson(options);
        }
        for (const deck of catalog.decks) {
            if (!deck?.id) continue;
            this.collection.decks[deck.id] = cloneJson(deck);
        }
        await this.persistCollection();
    }

    /** Rebuilds the editable note/card model from manifests embedded in Markdown files. */
    async reconcileFileNativeNotes(
        records: Array<{ path: string; note: FileNativeNoteRecord }>,
    ): Promise<number> {
        await this.initialize();
        if (records.length === 0) return 0;
        const timestamp = this.now();
        let changed = 0;
        for (const { path, note: input } of records) {
            const noteType = this.collection.noteTypes[input.noteTypeId];
            if (!noteType || noteType.deletedAt) continue;
            const existing = this.collection.notes[input.id];
            const note: CollectionNote = existing ?? {
                id: input.id,
                noteTypeId: input.noteTypeId,
                fields: {},
                tags: [],
                source: { kind: "managed", path, questionId: input.questionId },
                createdAt: input.createdAt || timestamp,
                updatedAt: timestamp,
            };
            note.noteTypeId = input.noteTypeId;
            note.fields = { ...input.fields };
            note.answerMode = input.answerMode;
            note.tags = normalizeTags(input.tags ?? []);
            note.source = { kind: "managed", path, questionId: input.questionId };
            note.externalIds = input.externalIds ? { ...input.externalIds } : undefined;
            note.externalData = input.externalData ? cloneJson(input.externalData) : undefined;
            note.updatedAt = Math.max(input.updatedAt || 0, timestamp);
            delete note.deletedAt;
            this.collection.notes[note.id] = note;
            const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
            this.replaceGeneratedCards(
                note,
                noteType,
                deck,
                input.questionId ?? `^sr-data-id-${note.id}`,
                timestamp,
                input.legacyQuestionIds,
                input.legacyStableIds,
            );
            changed++;
        }
        if (changed > 0) await this.persistCollection();
        return changed;
    }

    getReviewLogSnapshot(): ReviewLogData {
        return cloneJson(this.reviewLog);
    }

    /** Applies scheduling/history carried by an Anki package after Markdown notes are materialized. */
    async applyImportedAnkiState(
        imported: Array<{
            guid: string;
            cards: Array<{
                ordinal: number;
                queue: number;
                due: number;
                interval: number;
                factor: number;
                reps: number;
                lapses: number;
                flags: number;
                reviews: Array<{
                    id: number;
                    ease: number;
                    durationMs: number;
                }>;
            }>;
        }>,
        collectionCreatedAt: number,
    ): Promise<number> {
        await this.initialize();
        let updated = 0;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (const source of imported) {
            const note = Object.values(this.collection.notes).find(
                (candidate) =>
                    !candidate.deletedAt && candidate.externalIds?.ankiGuid === source.guid,
            );
            if (!note) continue;
            const cards = Object.values(this.collection.cards)
                .filter((card) => !card.deletedAt && card.noteId === note.id)
                .sort((left, right) => left.ordinal - right.ordinal);
            for (const [index, importedCard] of source.cards.entries()) {
                const card =
                    cards.find((candidate) => candidate.ordinal === importedCard.ordinal) ??
                    cards[index];
                if (!card) continue;
                card.reps = importedCard.reps;
                card.lapses = importedCard.lapses;
                card.flag = Math.max(0, Math.min(7, importedCard.flags)) as CardFlag;
                card.state =
                    importedCard.queue === -1
                        ? "suspended"
                        : importedCard.queue < -1
                          ? "buried"
                          : "active";
                card.buriedUntil = card.state === "buried" ? today.valueOf() + 86_400_000 : null;
                card.queue =
                    importedCard.queue === 0
                        ? "new"
                        : importedCard.queue === 1
                          ? "learning"
                          : importedCard.queue === 3
                            ? "relearning"
                            : "review";
                if (card.queue === "new") {
                    card.schedule = null;
                } else {
                    const due =
                        importedCard.queue === 1 || importedCard.queue === 3
                            ? importedCard.due * 1000
                            : collectionCreatedAt + importedCard.due * 86_400_000;
                    card.schedule = {
                        algorithm: SRAlgorithmType.SM_2_OSR,
                        scheduleData: {
                            dueDate: new Date(Number.isFinite(due) ? due : today.valueOf())
                                .toISOString()
                                .slice(0, 10),
                            interval: Math.max(0, importedCard.interval),
                            ease: importedCard.factor > 0 ? importedCard.factor / 10 : 250,
                            delayedBeforeReviewTicks: 0,
                        },
                    };
                }
                const lastReview = importedCard.reviews[importedCard.reviews.length - 1];
                card.lastReviewAt = lastReview?.id ?? null;
                card.updatedAt = this.now();
                for (const review of importedCard.reviews) {
                    const id = `anki-review-${review.id}`;
                    this.reviewLog.entries[id] = {
                        id,
                        cardId: card.id,
                        noteId: note.id,
                        rating: Math.max(1, Math.min(4, review.ease)) as ReviewRating,
                        reviewedAt: review.id,
                        durationMs: review.durationMs || null,
                        mode: "review",
                        previousSchedule: null,
                        nextSchedule: card.schedule ? cloneJson(card.schedule) : null,
                    };
                }
                updated++;
            }
        }
        if (updated > 0) {
            await this.persistCollection();
            await this.persistReviewLog();
        }
        return updated;
    }

    /** Recomputes FSRS due dates atomically after creating a recoverable snapshot. */
    /* istanbul ignore next -- exercised through the stateful collection-store integration test. */
    async rescheduleFsrsCards(options: {
        deckPaths?: string[];
        desiredRetention: number;
        stabilityScale?: number;
        loadBalance?: boolean;
    }): Promise<number> {
        await this.initialize();
        await this.writeBackupSnapshot("before-fsrs-reschedule", this.collection, this.reviewLog);
        const now = this.now();
        const scale = Math.max(0.25, Math.min(4, options.stabilityScale ?? 1));
        const load = new Map<string, number>();
        let updated = 0;
        const inScope = (deckPath: string) =>
            !options.deckPaths?.length ||
            options.deckPaths.some((path) => deckPath === path || deckPath.startsWith(`${path}/`));
        for (const card of Object.values(this.collection.cards)) {
            if (card.deletedAt || card.state !== "active" || !inScope(card.deckPath)) continue;
            if (!card.schedule || card.schedule.algorithm !== SRAlgorithmType.FSRS) continue;
            const schedule = card.schedule.scheduleData as ISerializedFSRSScheduleData;
            const lastReview = Date.parse(schedule.lastReview);
            if (!Number.isFinite(lastReview) || !Number.isFinite(schedule.stability)) continue;
            schedule.stability = Math.max(0.001, schedule.stability * scale);
            schedule.interval = intervalForRetention(
                schedule.stability,
                Math.max(0.7, Math.min(0.99, options.desiredRetention)),
            );
            let due = lastReview + schedule.interval * 86_400_000;
            if (options.loadBalance) {
                const candidates = [-2, -1, 0, 1, 2]
                    .map((offset) => Math.max(now, due + offset * 86_400_000))
                    .sort((left, right) => {
                        const leftKey = new Date(left).toISOString().slice(0, 10);
                        const rightKey = new Date(right).toISOString().slice(0, 10);
                        return (load.get(leftKey) ?? 0) - (load.get(rightKey) ?? 0);
                    });
                due = candidates[0];
            }
            const key = new Date(due).toISOString().slice(0, 10);
            load.set(key, (load.get(key) ?? 0) + 1);
            schedule.dueDate = new Date(due).toISOString();
            card.updatedAt = now;
            updated++;
        }
        if (updated > 0) await this.persistCollection();
        return updated;
    }

    async createBackup(reason = "manual"): Promise<CollectionBackupDescriptor | null> {
        await this.initialize();
        return await this.writeBackupSnapshot(reason, this.collection, this.reviewLog);
    }

    async listBackups(): Promise<CollectionBackupDescriptor[]> {
        await this.initialize();
        if (!this.storage.listBackups || !this.storage.readBackup) return [];
        const result: CollectionBackupDescriptor[] = [];
        for (const path of await this.storage.listBackups()) {
            const content = await this.storage.readBackup(path);
            if (!content) continue;
            try {
                const backup = JSON.parse(content) as CollectionBackupData;
                if (
                    backup.formatVersion !== 1 ||
                    typeof backup.createdAt !== "number" ||
                    typeof backup.reason !== "string" ||
                    typeof backup.schemaVersion !== "number" ||
                    !backup.collection ||
                    !backup.reviewLog
                ) {
                    continue;
                }
                result.push({
                    path,
                    createdAt: backup.createdAt,
                    reason: backup.reason,
                    schemaVersion: backup.schemaVersion,
                });
            } catch {
                // A malformed backup is ignored here and reported by the integrity screen.
            }
        }
        return result.sort((left, right) => right.createdAt - left.createdAt);
    }

    async restoreBackup(path: string): Promise<void> {
        await this.initialize();
        if (!this.storage.readBackup) throw new Error("backup-storage-unavailable");
        const content = await this.storage.readBackup(path);
        if (!content) throw new Error("backup-not-found");
        const backup = JSON.parse(content) as CollectionBackupData;
        if (backup.formatVersion !== 1 || !backup.collection || !backup.reviewLog) {
            throw new Error("invalid-backup");
        }
        await this.writeBackupSnapshot("before-restore", this.collection, this.reviewLog);
        const timestamp = this.now();
        const restored = migrateCollection(backup.collection);
        const touchRecord = (record: Record<string, { updatedAt: number }>): void => {
            for (const entity of Object.values(record)) entity.updatedAt = timestamp;
        };
        for (const record of [
            restored.noteTypes,
            restored.deckOptions,
            restored.decks,
            restored.notes,
            restored.cards,
        ]) {
            touchRecord(record);
        }
        restored.revision = Math.max(this.collection.revision, restored.revision) + 1;
        restored.updatedAt = timestamp;
        this.collection = restored;
        this.reviewLog = mergeReviewLogs(this.reviewLog, migrateReviewLog(backup.reviewLog));
        this.reviewLog.revision++;
        this.reviewLog.updatedAt = timestamp;
        await this.storage.writeCollection(formatCollection(this.collection));
        await this.storage.writeReviewLog(formatReviewLog(this.reviewLog));
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

    previewNoteTypeChange(
        definition: Omit<NoteTypeDefinition, "createdAt" | "updatedAt">,
    ): NoteTypeChangePreview {
        const notes = Object.values(this.collection.notes).filter(
            (note) => !note.deletedAt && note.noteTypeId === definition.id,
        );
        const existing = this.collection.noteTypes[definition.id];
        let currentCards = 0;
        let resultingCards = 0;
        let preservedCards = 0;
        for (const note of notes) {
            const cards = Object.values(this.collection.cards).filter(
                (card) => !card.deletedAt && card.noteId === note.id,
            );
            const nextKeys = new Set(
                this.getGeneratedCardSpecs(note, definition).map(({ template, variantId }) =>
                    createCardStableKey(note.id, template.id, variantId),
                ),
            );
            currentCards += cards.length;
            resultingCards += nextKeys.size;
            preservedCards += cards.filter((card) => nextKeys.has(card.stableKey)).length;
        }
        const previousTemplates = new Map(
            (existing?.templates ?? []).map((template) => [template.id, template]),
        );
        const changedTemplates = definition.templates.filter((template) => {
            const previous = previousTemplates.get(template.id);
            return (
                !previous ||
                canonicalJson(this.templateContent(previous)) !==
                    canonicalJson(this.templateContent(template))
            );
        }).length;
        return {
            affectedNotes: notes.length,
            currentCards,
            resultingCards,
            preservedCards,
            createdCards: Math.max(0, resultingCards - preservedCards),
            retiredCards: Math.max(0, currentCards - preservedCards),
            changedTemplates,
        };
    }

    async checkIntegrity(): Promise<CollectionIntegrityReport> {
        await this.initialize();
        const issues: CollectionIntegrityIssue[] = [];
        const activeNoteTypes = this.collection.noteTypes;
        const activeNotes = Object.values(this.collection.notes).filter((note) => !note.deletedAt);
        const activeCards = Object.values(this.collection.cards).filter((card) => !card.deletedAt);
        const stableKeys = new Map<string, string[]>();
        let mediaReferences = 0;
        const checkPath = async (
            code: "missing-source" | "missing-media",
            entityId: string,
            path: string,
        ): Promise<void> => {
            if (!path || !this.storage.pathExists) return;
            if (!(await this.storage.pathExists(path))) {
                issues.push({ code, severity: "warning", entityId, details: path });
            }
        };

        for (const deck of Object.values(this.collection.decks)) {
            if (deck.deletedAt) continue;
            const options = this.collection.deckOptions[deck.optionsId];
            if (!options || options.deletedAt) {
                issues.push({
                    code: "missing-deck-options",
                    severity: "error",
                    entityId: deck.id,
                    details: deck.optionsId,
                });
            }
        }

        for (const note of activeNotes) {
            const noteType = activeNoteTypes[note.noteTypeId];
            if (!noteType || noteType.deletedAt) {
                issues.push({
                    code: "missing-note-type",
                    severity: "error",
                    entityId: note.id,
                    details: note.noteTypeId,
                });
            } else {
                for (const field of noteType.fields) {
                    const value = note.fields[field.id] ?? "";
                    if (field.required && !value.trim()) {
                        issues.push({
                            code: "missing-required-field",
                            severity: "warning",
                            entityId: note.id,
                            details: field.name,
                        });
                    }
                    const paths = this.extractMediaPaths(value, field.kind === "media");
                    mediaReferences += paths.length;
                    for (const path of paths) await checkPath("missing-media", note.id, path);
                }
                for (const spec of this.getGeneratedCardSpecs(note, noteType, true)) {
                    if (!spec.empty) continue;
                    issues.push({
                        code: "empty-generated-card",
                        severity: "warning",
                        entityId: note.id,
                        details: spec.template.name,
                    });
                }
            }
            await checkPath("missing-source", note.id, note.source.path);
        }

        for (const card of activeCards) {
            const note = this.collection.notes[card.noteId];
            if (!note || note.deletedAt) {
                issues.push({
                    code: "orphan-card",
                    severity: "error",
                    entityId: card.id,
                    details: card.noteId,
                });
                continue;
            }
            const noteType = activeNoteTypes[note.noteTypeId];
            if (!noteType?.templates.some((template) => template.id === card.templateId)) {
                issues.push({
                    code: "missing-template",
                    severity: "error",
                    entityId: card.id,
                    details: card.templateId,
                });
            }
            const deck = this.collection.decks[card.deckId];
            if (!deck || deck.deletedAt) {
                issues.push({
                    code: "missing-deck",
                    severity: "error",
                    entityId: card.id,
                    details: card.deckId,
                });
            }
            const expectedKey = createCardStableKey(card.noteId, card.templateId, card.variantId);
            if (card.stableKey !== expectedKey) {
                issues.push({
                    code: "invalid-stable-key",
                    severity: "error",
                    entityId: card.id,
                    details: expectedKey,
                });
            }
            const matches = stableKeys.get(card.stableKey) ?? [];
            matches.push(card.id);
            stableKeys.set(card.stableKey, matches);
            if (card.schedule && !this.isScheduleValid(card.schedule)) {
                issues.push({
                    code: "invalid-schedule",
                    severity: "error",
                    entityId: card.id,
                });
            }
        }
        for (const [stableKey, ids] of stableKeys) {
            if (ids.length > 1) {
                issues.push({
                    code: "duplicate-stable-key",
                    severity: "error",
                    entityId: ids.join(", "),
                    details: stableKey,
                });
            }
        }
        for (const review of Object.values(this.reviewLog.entries)) {
            if (review.deletedAt) continue;
            if (!this.collection.cards[review.cardId] || !this.collection.notes[review.noteId]) {
                issues.push({
                    code: "orphan-review",
                    severity: "warning",
                    entityId: review.id,
                    details: review.cardId,
                });
            }
        }
        for (const conflict of Object.values(this.collection.conflicts)) {
            if (!conflict.resolvedAt) {
                issues.push({
                    code: "sync-conflict",
                    severity: "warning",
                    entityId: conflict.entityId,
                    details: conflict.entityKind,
                });
            }
        }
        return {
            checkedAt: this.now(),
            counts: {
                noteTypes: Object.values(activeNoteTypes).filter((type) => !type.deletedAt).length,
                notes: activeNotes.length,
                cards: activeCards.length,
                reviews: Object.values(this.reviewLog.entries).filter((entry) => !entry.deletedAt)
                    .length,
                mediaReferences,
            },
            issues,
        };
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
            answerMode: input.answerMode ?? "reveal",
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
        const templates = definition.templates.map((template) => {
            const previous = existing?.templates.find((candidate) => candidate.id === template.id);
            const changed =
                !previous ||
                canonicalJson(this.templateContent(previous)) !==
                    canonicalJson(this.templateContent(template));
            return normalizeTemplate(
                {
                    ...template,
                    version: previous ? previous.version + (changed ? 1 : 0) : 1,
                },
                definition.kind,
            );
        });
        const changed =
            !existing ||
            canonicalJson(this.noteTypeContent(existing)) !==
                canonicalJson(this.noteTypeContent({ ...definition, templates }));
        if (existing && changed && this.countNotesForType(definition.id) > 0) {
            await this.writeBackupSnapshot(
                `before-note-type-${this.safeBackupSegment(existing.name)}`,
                this.collection,
                this.reviewLog,
            );
        }
        const noteType: NoteTypeDefinition = {
            ...definition,
            version: existing ? existing.version + (changed ? 1 : 0) : 1,
            fields: definition.fields.map((field) => ({ ...field })),
            templates,
            createdAt: existing?.createdAt ?? definition.createdAt ?? timestamp,
            updatedAt: timestamp,
        };
        this.collection.noteTypes[noteType.id] = noteType;
        if (changed) {
            for (const note of Object.values(this.collection.notes)) {
                if (note.deletedAt || note.noteTypeId !== noteType.id) continue;
                const existingCard = Object.values(this.collection.cards).find(
                    (card) => !card.deletedAt && card.noteId === note.id,
                );
                const deck =
                    (existingCard && this.collection.decks[existingCard.deckId]) ||
                    this.collection.decks[DEFAULT_DECK_ID];
                this.replaceGeneratedCards(
                    note,
                    noteType,
                    deck,
                    note.source.questionId ?? `^sr-data-id-${note.id}`,
                    timestamp,
                );
            }
        }
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
        if (definition.learningSteps?.some((step) => !Number.isFinite(step) || step <= 0)) {
            throw new Error("invalid-learning-steps");
        }
        if (definition.relearningSteps?.some((step) => !Number.isFinite(step) || step <= 0)) {
            throw new Error("invalid-relearning-steps");
        }
        const timestamp = this.now();
        const existing = this.collection.deckOptions[definition.id];
        const options: DeckOptionsDefinition = normalizeDeckOptions(
            {
                ...definition,
                name: definition.name.trim(),
                createdAt: existing?.createdAt ?? definition.createdAt ?? timestamp,
                updatedAt: timestamp,
            },
            this.collection.deckOptions[DEFAULT_DECK_OPTIONS_ID],
        );
        this.collection.deckOptions[options.id] = options;
        await this.persistCollection();
        return cloneJson(options);
    }

    async updateDeck(
        deckPath: string,
        changes: { description?: string; optionsId?: string; icon?: string },
    ): Promise<CollectionDeck> {
        await this.initialize();
        const deck = this.ensureDeckPathInMemory(deckPath, this.now());
        if (changes.optionsId) {
            const options = this.collection.deckOptions[changes.optionsId];
            if (!options || options.deletedAt) throw new Error("deck-options-not-found");
            deck.optionsId = options.id;
        }
        if (changes.description !== undefined) deck.description = changes.description.trim();
        if (changes.icon !== undefined) deck.icon = changes.icon.trim() || undefined;
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
            externalIds: input.externalIds ? { ...input.externalIds } : undefined,
            externalData: input.externalData ? cloneJson(input.externalData) : undefined,
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
            input.legacyStableIds,
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
        const before = cloneJson(note);
        note.fields = { ...input.fields };
        note.tags = normalizeTags(input.tags ?? note.tags);
        note.source = { ...input.source };
        note.externalIds = input.externalIds ? { ...input.externalIds } : note.externalIds;
        note.externalData = input.externalData ? cloneJson(input.externalData) : note.externalData;
        note.updatedAt = timestamp;
        this.recordNoteEdit(before, note, "edit", timestamp);
        const deck = this.ensureDeckPathInMemory(input.deckPath, timestamp);
        this.replaceGeneratedCards(
            note,
            noteType,
            deck,
            input.source.questionId ?? `^sr-data-id-${note.id}`,
            timestamp,
            input.legacyQuestionIds,
            input.legacyStableIds,
        );
        await this.persistCollection();
        return note;
    }

    previewNoteConversion(
        noteId: string,
        toNoteTypeId: string,
        fieldMapping: Record<string, string> = {},
    ): NoteConversionPreview {
        const note = this.collection.notes[noteId];
        const target = this.collection.noteTypes[toNoteTypeId];
        if (!note || note.deletedAt) throw new Error("note-not-found");
        if (!target || target.deletedAt) throw new Error("note-type-not-found");
        const fields = Object.fromEntries(
            target.fields.map((field) => [
                field.id,
                note.fields[fieldMapping[field.id] ?? field.id] ?? "",
            ]),
        );
        const converted = { ...note, noteTypeId: target.id, fields };
        const currentCards = Object.values(this.collection.cards).filter(
            (card) => !card.deletedAt && card.noteId === note.id,
        );
        const nextSpecs = this.getGeneratedCardSpecs(converted, target);
        const nextKeys = new Set(
            nextSpecs.map(({ template, variantId }) =>
                createCardStableKey(note.id, template.id, variantId),
            ),
        );
        const preservedCards = nextSpecs.filter(({ template, variantId, ordinal }) =>
            currentCards.some(
                (card) =>
                    card.stableKey === createCardStableKey(note.id, template.id, variantId) ||
                    card.ordinal === ordinal,
            ),
        ).length;
        return {
            noteId,
            fromNoteTypeId: note.noteTypeId,
            toNoteTypeId,
            preservedCards,
            createdCards: Math.max(0, nextKeys.size - preservedCards),
            retiredCards: Math.max(0, currentCards.length - preservedCards),
            emptyFields: target.fields
                .filter((field) => !fields[field.id]?.trim())
                .map((field) => field.id),
        };
    }

    async convertNoteType(
        noteId: string,
        toNoteTypeId: string,
        fieldMapping: Record<string, string>,
        deckPath: string,
        fieldsOverride?: Record<string, string>,
    ): Promise<CollectionNote> {
        await this.initialize();
        const note = this.collection.notes[noteId];
        const target = this.collection.noteTypes[toNoteTypeId];
        if (!note || note.deletedAt) throw new Error("note-not-found");
        if (!target || target.deletedAt) throw new Error("note-type-not-found");
        const fields = fieldsOverride
            ? { ...fieldsOverride }
            : Object.fromEntries(
                  target.fields.map((field) => [
                      field.id,
                      note.fields[fieldMapping[field.id] ?? field.id] ?? "",
                  ]),
              );
        for (const field of target.fields) {
            if (field.required && !fields[field.id]?.trim()) {
                throw new Error(`required-field-empty:${field.id}`);
            }
        }
        await this.writeBackupSnapshot("before-note-conversion", this.collection, this.reviewLog);
        const timestamp = this.now();
        const before = cloneJson(note);
        note.noteTypeId = target.id;
        note.fields = fields;
        note.updatedAt = timestamp;
        this.recordNoteEdit(before, note, "convert", timestamp);
        const deck = this.ensureDeckPathInMemory(deckPath, timestamp);
        this.replaceGeneratedCards(
            note,
            target,
            deck,
            note.source.questionId ?? `^sr-data-id-${note.id}`,
            timestamp,
            undefined,
            undefined,
            true,
        );
        await this.persistCollection();
        return cloneJson(note);
    }

    findEmptyGeneratedCards(noteTypeId?: string): EmptyGeneratedCard[] {
        const result: EmptyGeneratedCard[] = [];
        for (const note of Object.values(this.collection.notes)) {
            if (note.deletedAt || (noteTypeId && note.noteTypeId !== noteTypeId)) continue;
            const noteType = this.collection.noteTypes[note.noteTypeId];
            if (!noteType || noteType.deletedAt) continue;
            for (const spec of this.getGeneratedCardSpecs(note, noteType, true)) {
                if (!spec.empty) continue;
                result.push({
                    noteId: note.id,
                    templateId: spec.template.id,
                    variantId: spec.variantId,
                });
            }
        }
        return result;
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
        const before = cloneJson(existing);
        existing.noteTypeId = noteTypeIdForNativeType(input.type);
        existing.fields = fieldsForNativeInput(input);
        existing.answerMode = input.answerMode ?? existing.answerMode ?? "reveal";
        existing.tags = normalizeTags(input.tags ?? existing.tags);
        existing.source.questionId = input.questionId;
        existing.updatedAt = timestamp;
        this.recordNoteEdit(before, existing, "edit", timestamp);
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

    async moveNotesBySource(
        inputs: Array<{ sourcePath: string; questionId?: string | null }>,
        deckPath: string,
    ): Promise<void> {
        await this.initialize();
        const timestamp = this.now();
        const deck = this.ensureDeckPathInMemory(deckPath, timestamp);
        const noteIds = new Set<string>();
        for (const input of inputs) {
            const note = this.findNoteBySource(input.sourcePath, input.questionId);
            if (note) noteIds.add(note.id);
        }
        for (const card of Object.values(this.collection.cards)) {
            if (card.deletedAt || !noteIds.has(card.noteId)) continue;
            card.deckId = deck.id;
            card.deckPath = deckPath;
            card.updatedAt = timestamp;
        }
        if (noteIds.size > 0) await this.persistCollection();
    }

    async setNotesTagsBySource(
        inputs: Array<{ sourcePath: string; questionId?: string | null }>,
        tags: string[],
    ): Promise<void> {
        await this.initialize();
        const timestamp = this.now();
        const normalizedTags = normalizeTags(tags);
        const changed = new Set<string>();
        for (const input of inputs) {
            const note = this.findNoteBySource(input.sourcePath, input.questionId);
            if (!note || changed.has(note.id)) continue;
            const before = cloneJson(note);
            note.tags = normalizedTags;
            note.updatedAt = timestamp;
            this.recordNoteEdit(before, note, "tags", timestamp);
            changed.add(note.id);
        }
        if (changed.size > 0) await this.persistCollection();
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
        if (!input.nextSchedule) card.queue = "new";
        else if (input.nextSchedule.algorithm === SRAlgorithmType.FSRS) {
            const state = (input.nextSchedule.scheduleData as ISerializedFSRSScheduleData).state;
            card.queue =
                Number(state) === 1 ? "learning" : Number(state) === 3 ? "relearning" : "review";
        } else card.queue = "review";
        card.reps++;
        if (input.rating === 1 && input.previousSchedule) card.lapses++;
        const deckOptions =
            this.collection.deckOptions[
                this.collection.decks[card.deckId]?.optionsId ?? DEFAULT_DECK_OPTIONS_ID
            ];
        if (card.lapses >= (input.leechThreshold ?? deckOptions?.leechThreshold ?? 8)) {
            if ((input.leechAction ?? deckOptions?.leechAction ?? "tag") === "suspend")
                card.state = "suspended";
            else if (!note.tags.includes("leech")) note.tags.push("leech");
        }
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
            const variantId = `legacy-${input.ordinal}`;
            card = {
                id: this.createId("card"),
                noteId: note.id,
                templateId: "builtin-basic-card",
                variantId,
                stableKey: createCardStableKey(note.id, "builtin-basic-card", variantId),
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
        legacyStableIds?: Record<number, string>,
        preserveByOrdinal = false,
    ): void {
        const existing = Object.values(this.collection.cards).filter(
            (card) => card.noteId === note.id && !card.deletedAt,
        );
        const specs = this.getGeneratedCardSpecs(note, noteType);
        for (const card of existing) {
            if (
                !specs.some(
                    ({ template, variantId }) =>
                        createCardStableKey(note.id, template.id, variantId) === card.stableKey,
                )
            ) {
                card.deletedAt = timestamp;
                card.updatedAt = timestamp;
            }
        }
        for (const { template, ordinal, variantId } of specs) {
            const targetDeck = template.deckOverride
                ? this.ensureDeckPathInMemory(template.deckOverride, timestamp)
                : deck;
            const stableKey = createCardStableKey(note.id, template.id, variantId);
            const current = existing.find(
                (card) =>
                    card.stableKey === stableKey ||
                    (card.templateId === template.id && card.ordinal === ordinal) ||
                    (preserveByOrdinal && card.ordinal === ordinal),
            );
            if (current) {
                delete current.deletedAt;
                current.templateId = template.id;
                current.deckId = targetDeck.id;
                current.deckPath = targetDeck.name;
                current.ordinal = ordinal;
                current.variantId = variantId;
                current.stableKey = stableKey;
                current.legacyStableId =
                    legacyStableIds?.[ordinal] ??
                    (legacyQuestionIds?.[ordinal]
                        ? `${legacyQuestionIds[ordinal]}:0`
                        : `${questionId}:${ordinal}`);
                current.updatedAt = timestamp;
                continue;
            }
            const card: CollectionCard = {
                id: this.createId("card"),
                noteId: note.id,
                templateId: template.id,
                variantId,
                stableKey,
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
                legacyStableId:
                    legacyStableIds?.[ordinal] ??
                    (legacyQuestionIds?.[ordinal]
                        ? `${legacyQuestionIds[ordinal]}:0`
                        : `${questionId}:${ordinal}`),
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.collection.cards[card.id] = card;
        }
    }

    private getGeneratedCardSpecs(
        note: CollectionNote,
        noteType: Pick<NoteTypeDefinition, "kind" | "templates" | "fields">,
        includeEmpty = false,
    ): Array<{
        template: NoteTypeDefinition["templates"][number];
        ordinal: number;
        variantId: string;
        empty?: boolean;
    }> {
        let ordinal = 0;
        const specs: Array<{
            template: NoteTypeDefinition["templates"][number];
            ordinal: number;
            variantId: string;
            empty?: boolean;
        }> = [];
        const selectedTemplateIds = Array.isArray(note.externalData?.msreTemplateIds)
            ? (note.externalData.msreTemplateIds as unknown[]).filter(
                  (id): id is string => typeof id === "string",
              )
            : [];
        for (const rawTemplate of noteType.templates
            .filter(
                (template) =>
                    template.enabled &&
                    (selectedTemplateIds.length === 0 || selectedTemplateIds.includes(template.id)),
            )
            .sort((left, right) => left.ordinal - right.ordinal)) {
            const template = normalizeTemplate(rawTemplate, noteType.kind);
            if (!templateConditionMatches(note, template)) continue;
            const generator = template.generator ?? noteType.kind;
            let variants: string[];
            if (generator === "cloze") {
                const source = template.sourceFieldId
                    ? {
                          ...note,
                          fields: {
                              [template.sourceFieldId]: note.fields[template.sourceFieldId] ?? "",
                          },
                      }
                    : note;
                variants = this.getClozeOrdinals(source).map((index) => `cloze-${index + 1}`);
            } else if (generator === "image-occlusion") {
                variants = getImageOcclusionVariantIds(note);
            } else {
                variants = ["base"];
            }
            for (const variantId of variants) {
                const empty =
                    generator === "standard" &&
                    (!renderTemplateText(template.questionFormat, note, noteType) ||
                        !renderTemplateText(template.answerFormat, note, noteType));
                if (!empty || includeEmpty) specs.push({ template, ordinal, variantId, empty });
                ordinal++;
            }
        }
        return specs;
    }

    private getClozeOrdinals(note: CollectionNote): number[] {
        const numbers = new Set<number>();
        for (const value of Object.values(note.fields)) {
            for (const match of value.matchAll(/{{c(\d+)::/gi)) {
                const number = Number(match[1]);
                if (number > 0) numbers.add(number - 1);
            }
        }
        return [...numbers].sort((left, right) => left - right);
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

    private templateContent(template: NoteTypeDefinition["templates"][number]): unknown {
        return {
            id: template.id,
            name: template.name,
            ordinal: template.ordinal,
            questionFormat: template.questionFormat,
            answerFormat: template.answerFormat,
            deckOverride: template.deckOverride,
            enabled: template.enabled,
            generator: template.generator,
            answerMode: template.answerMode,
            answerConfig: template.answerConfig,
            answerFieldId: template.answerFieldId,
            sourceFieldId: template.sourceFieldId,
            condition: template.condition,
            css: template.css,
            editorMode: template.editorMode,
            questionBlocks: template.questionBlocks,
            answerBlocks: template.answerBlocks,
            browserBlocks: template.browserBlocks,
            browserFormat: template.browserFormat,
            questionCss: template.questionCss,
            answerCss: template.answerCss,
            browserCss: template.browserCss,
        };
    }

    private noteTypeContent(
        noteType: Pick<NoteTypeDefinition, "name" | "kind" | "fields" | "templates" | "css">,
    ): unknown {
        return {
            name: noteType.name,
            kind: noteType.kind,
            fields: noteType.fields,
            templates: noteType.templates.map((template) => this.templateContent(template)),
            css: noteType.css,
        };
    }

    private extractMediaPaths(value: string, includePlainValue: boolean): string[] {
        const paths = new Set<string>();
        for (const match of value.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
            if (match[1]?.trim()) paths.add(match[1].trim());
        }
        for (const match of value.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
            const path = match[1]?.trim();
            if (path && !/^(?:https?:|data:|blob:)/i.test(path)) paths.add(path);
        }
        if (includePlainValue) {
            const trimmed = value.trim();
            if (trimmed && !trimmed.includes("\n") && !/^!\[\[/.test(trimmed)) paths.add(trimmed);
        }
        return [...paths];
    }

    private isScheduleValid(schedule: unknown): boolean {
        if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return false;
        const entry = schedule as Record<string, unknown>;
        if (typeof entry.algorithm !== "string") return false;
        const data = entry.scheduleData;
        if (!data || typeof data !== "object" || Array.isArray(data)) return false;
        const record = data as Record<string, unknown>;
        if (typeof record.interval !== "number" || !Number.isFinite(record.interval)) return false;
        if (record.interval < 0 || typeof record.dueDate !== "string") return false;
        return !Number.isNaN(Date.parse(record.dueDate));
    }

    private safeBackupSegment(value: string): string {
        return (
            value
                .trim()
                .toLocaleLowerCase()
                .replace(/[^a-zа-яё0-9]+/gi, "-")
                .replace(/^-|-$/g, "") || "collection"
        );
    }

    private async writeBackupSnapshot(
        reason: string,
        collection: unknown,
        reviewLog: unknown,
        schemaVersion = COLLECTION_SCHEMA_VERSION,
    ): Promise<CollectionBackupDescriptor | null> {
        if (!this.storage.writeBackup) return null;
        const createdAt = this.now();
        const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
        const path = `${COLLECTION_BACKUP_FOLDER}/${stamp}-${this.safeBackupSegment(reason)}.json`;
        const backup: CollectionBackupData = {
            formatVersion: 1,
            path,
            createdAt,
            reason,
            schemaVersion,
            collection: cloneJson(collection),
            reviewLog: cloneJson(reviewLog),
        };
        await this.storage.writeBackup(path, JSON.stringify(backup, null, 2));
        return { path, createdAt, reason, schemaVersion };
    }

    private recordNoteEdit(
        before: CollectionNote,
        after: CollectionNote,
        action: CollectionEditHistoryEntry["action"],
        changedAt: number,
    ): void {
        const templateIds = (note: CollectionNote): string[] =>
            Array.isArray(note.externalData?.msreTemplateIds)
                ? (note.externalData.msreTemplateIds as unknown[]).filter(
                      (id): id is string => typeof id === "string",
                  )
                : [];
        const beforeTemplateIds = templateIds(before);
        const afterTemplateIds = templateIds(after);
        const templatesChanged =
            canonicalJson(beforeTemplateIds) !== canonicalJson(afterTemplateIds);
        if (
            before.noteTypeId === after.noteTypeId &&
            canonicalJson(before.fields) === canonicalJson(after.fields) &&
            canonicalJson(before.tags) === canonicalJson(after.tags) &&
            !templatesChanged
        ) {
            return;
        }
        const id = this.createId("edit");
        this.collection.editHistory[id] = {
            id,
            noteId: after.id,
            changedAt,
            action: templatesChanged && action === "edit" ? "template" : action,
            beforeNoteTypeId: before.noteTypeId,
            afterNoteTypeId: after.noteTypeId,
            beforeFields: cloneJson(before.fields),
            afterFields: cloneJson(after.fields),
            beforeTags: [...before.tags],
            afterTags: [...after.tags],
            beforeTemplateIds,
            afterTemplateIds,
        };
        const noteEntries = Object.values(this.collection.editHistory)
            .filter((entry) => entry.noteId === after.id)
            .sort((left, right) => right.changedAt - left.changedAt);
        for (const stale of noteEntries.slice(100)) delete this.collection.editHistory[stale.id];
    }

    private async persistCollection(): Promise<void> {
        const operation = this.writeQueue.then(async () => {
            const onDisk = parseCollection(await this.storage.readCollection());
            // This store is the author of the pending mutation. If the filesystem still contains
            // the previous value with the same coarse timestamp, keep the in-memory value while
            // retaining the collision in the conflict journal.
            this.collection = mergeCollections(this.collection, onDisk, "left");
            this.collection.revision++;
            this.collection.updatedAt = this.now();
            await this.storage.writeCollection(formatCollection(this.collection));
            await this.changeListener?.();
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
