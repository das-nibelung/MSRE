import { ISerializedScheduleEntry } from "src/data/plugin-data";

export const COLLECTION_SCHEMA_VERSION = 6;
export const REVIEW_LOG_SCHEMA_VERSION = 1;

export type NoteTypeKind = "standard" | "cloze" | "image-occlusion";
export type CardTemplateGenerator = NoteTypeKind;
export type CardAnswerMode = "reveal" | "type";
export type TemplateConditionOperator = "always" | "not-empty" | "empty" | "equals" | "not-equals";
export type FieldKind = "text" | "rich-text" | "media" | "number" | "formula";
export type CardLifecycleState = "active" | "suspended" | "buried";
export type CardFlag = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type CardQueue = "new" | "learning" | "review" | "relearning";

export interface NoteFieldDefinition {
    id: string;
    name: string;
    ordinal: number;
    kind: FieldKind;
    required: boolean;
}

export interface CardTemplateDefinition {
    id: string;
    /** Incremented whenever generation or presentation rules change. */
    version: number;
    name: string;
    ordinal: number;
    questionFormat: string;
    answerFormat: string;
    deckOverride: string | null;
    enabled: boolean;
    /** Generation is a property of a card template, so one note can mix card families. */
    generator?: CardTemplateGenerator;
    /** Review interaction for cards emitted by this template. */
    answerMode?: CardAnswerMode;
    /** Field whose value is checked for typed answers. Null falls back to the rendered answer. */
    answerFieldId?: string | null;
    /** For cloze templates, limits cloze discovery to one field. */
    sourceFieldId?: string | null;
    /** Optional card creation rule. */
    condition?: {
        operator: TemplateConditionOperator;
        fieldId: string | null;
        value: string;
    };
    /** Template-only presentation overrides applied after the note type style. */
    css?: string;
}

export interface NoteTypeDefinition {
    id: string;
    /** Incremented whenever fields, templates, kind, or styling change. */
    version: number;
    name: string;
    kind: NoteTypeKind;
    fields: NoteFieldDefinition[];
    templates: CardTemplateDefinition[];
    css: string;
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
}

export interface NoteSource {
    kind: "managed" | "markdown";
    path: string;
    questionId: string | null;
}

export interface DeckOptionsDefinition {
    id: string;
    name: string;
    newCardsPerDay: number;
    reviewsPerDay: number;
    desiredRetention: number;
    newCardOrder: "sequential" | "random";
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
}

export interface CollectionDeck {
    id: string;
    name: string;
    parentId: string | null;
    optionsId: string;
    description: string;
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
}

export interface CollectionNote {
    id: string;
    noteTypeId: string;
    fields: Record<string, string>;
    answerMode?: "reveal" | "type";
    tags: string[];
    source: NoteSource;
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
}

export interface CollectionCard {
    id: string;
    noteId: string;
    templateId: string;
    /** Stable template-specific variant, e.g. base, cloze-2, or an occlusion mask id. */
    variantId: string;
    /** Deterministic identity that survives template reordering and content edits. */
    stableKey: string;
    ordinal: number;
    deckId: string;
    deckPath: string;
    state: CardLifecycleState;
    /** Unix timestamp when a temporarily buried card becomes active again. */
    buriedUntil: number | null;
    flag: CardFlag;
    queue: CardQueue;
    schedule: ISerializedScheduleEntry | null;
    reps: number;
    lapses: number;
    lastReviewAt: number | null;
    /** Stable identifier used by the current Markdown scheduler during the transition. */
    legacyStableId: string | null;
    createdAt: number;
    updatedAt: number;
    deletedAt?: number;
}

export type CollectionEntityKind = "noteType" | "deckOptions" | "deck" | "note" | "card";

/** Preserves both sides of a same-revision sync collision instead of silently dropping one. */
export interface CollectionConflict {
    id: string;
    entityKind: CollectionEntityKind;
    entityId: string;
    detectedAt: number;
    winner: "left" | "right";
    winningValue: unknown;
    losingValue: unknown;
    resolvedAt?: number;
}

export interface CollectionData {
    schemaVersion: number;
    revision: number;
    updatedAt: number;
    noteTypes: Record<string, NoteTypeDefinition>;
    deckOptions: Record<string, DeckOptionsDefinition>;
    decks: Record<string, CollectionDeck>;
    notes: Record<string, CollectionNote>;
    cards: Record<string, CollectionCard>;
    conflicts: Record<string, CollectionConflict>;
}

export type IntegritySeverity = "error" | "warning";

export type IntegrityIssueCode =
    | "missing-note-type"
    | "missing-required-field"
    | "orphan-card"
    | "missing-template"
    | "missing-deck"
    | "missing-deck-options"
    | "duplicate-stable-key"
    | "invalid-stable-key"
    | "invalid-schedule"
    | "missing-source"
    | "missing-media"
    | "empty-generated-card"
    | "orphan-review"
    | "sync-conflict";

export interface CollectionIntegrityIssue {
    code: IntegrityIssueCode;
    severity: IntegritySeverity;
    entityId: string;
    details?: string;
}

export interface CollectionIntegrityReport {
    checkedAt: number;
    counts: {
        noteTypes: number;
        notes: number;
        cards: number;
        reviews: number;
        mediaReferences: number;
    };
    issues: CollectionIntegrityIssue[];
}

export interface CollectionBackupDescriptor {
    path: string;
    createdAt: number;
    reason: string;
    schemaVersion: number;
}

export interface CollectionBackupData extends CollectionBackupDescriptor {
    formatVersion: 1;
    /** Raw snapshot; restore always runs it through the current sequential migrator. */
    collection: unknown;
    reviewLog: unknown;
}

export interface NoteTypeChangePreview {
    affectedNotes: number;
    currentCards: number;
    resultingCards: number;
    preservedCards: number;
    createdCards: number;
    retiredCards: number;
    changedTemplates: number;
}

export interface NoteConversionPreview {
    noteId: string;
    fromNoteTypeId: string;
    toNoteTypeId: string;
    preservedCards: number;
    createdCards: number;
    retiredCards: number;
    emptyFields: string[];
}

export interface EmptyGeneratedCard {
    noteId: string;
    templateId: string;
    variantId: string;
}

export type ReviewRating = 1 | 2 | 3 | 4;

export interface ReviewLogEntry {
    id: string;
    cardId: string;
    noteId: string;
    rating: ReviewRating;
    reviewedAt: number;
    durationMs: number | null;
    mode: "review" | "cram";
    previousSchedule: ISerializedScheduleEntry | null;
    nextSchedule: ISerializedScheduleEntry | null;
    deletedAt?: number;
}

export interface ReviewLogData {
    schemaVersion: number;
    revision: number;
    updatedAt: number;
    entries: Record<string, ReviewLogEntry>;
}

export interface NativeNoteInput {
    id?: string;
    type: "basic" | "reversed" | "cloze";
    front: string;
    back: string;
    answerMode?: "reveal" | "type";
    deckPath: string;
    sourcePath: string;
    questionId: string;
    tags?: string[];
}

export interface CollectionNoteInput {
    id?: string;
    noteTypeId: string;
    fields: Record<string, string>;
    tags?: string[];
    deckPath: string;
    source: NoteSource;
    /** Per-card block IDs used by the temporary Markdown scheduling bridge. */
    legacyQuestionIds?: Record<number, string>;
    /** Exact question/card identities for generators that emit sibling cards. */
    legacyStableIds?: Record<number, string>;
}

export interface LegacyCardInput {
    sourcePath: string;
    questionId: string | null;
    ordinal: number;
    deckPath: string;
    front: string;
    back: string;
}

export interface RecordReviewInput extends LegacyCardInput {
    rating: ReviewRating;
    reviewedAt?: number;
    durationMs?: number | null;
    mode?: "review" | "cram";
    previousSchedule: ISerializedScheduleEntry | null;
    nextSchedule: ISerializedScheduleEntry | null;
}
