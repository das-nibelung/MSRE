import { ISerializedScheduleEntry } from "src/data/plugin-data";

export const COLLECTION_SCHEMA_VERSION = 4;
export const REVIEW_LOG_SCHEMA_VERSION = 1;

export type NoteTypeKind = "standard" | "cloze" | "image-occlusion";
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
    name: string;
    ordinal: number;
    questionFormat: string;
    answerFormat: string;
    deckOverride: string | null;
    enabled: boolean;
}

export interface NoteTypeDefinition {
    id: string;
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

export interface CollectionData {
    schemaVersion: number;
    revision: number;
    updatedAt: number;
    noteTypes: Record<string, NoteTypeDefinition>;
    deckOptions: Record<string, DeckOptionsDefinition>;
    decks: Record<string, CollectionDeck>;
    notes: Record<string, CollectionNote>;
    cards: Record<string, CollectionCard>;
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
