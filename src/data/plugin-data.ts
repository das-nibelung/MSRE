import { DEFAULT_SETTINGS, SRSettings } from "src/data/settings";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";
import { ISerializedSM2ScheduleData } from "src/scheduling/algorithms/osr/serialized-schedule-data";

export interface ISerializedScheduleEntry {
    algorithm: SRAlgorithmType;
    scheduleData: ISerializedFSRSScheduleData | ISerializedSM2ScheduleData;
}

/**
 * Represents the schedule data stored in the plugin data.
 *
 * @interface ISerializedScheduleData
 */
export interface ISerializedScheduleData {
    version: number;
    noteSchedules: Record<string, ISerializedScheduleEntry | null>;
    cardSchedules: Record<string, (ISerializedScheduleEntry | null)[]>;
}

export interface KnowledgeArea {
    id: string;
    name: string;
    /** Lucide icon name chosen in the native organizer. */
    icon?: string;
    /** Visible deck paths, without the configured root flashcard tag. */
    deckPaths: string[];
    pinned: boolean;
    /** Optional parent turns flat areas into a portable knowledge tree. */
    parentId?: string | null;
    /** Projects are goal-oriented areas and may be archived when completed. */
    kind?: "area" | "project";
    goal?: {
        targetDate?: string;
        cardsPerDay?: number;
        minutesPerDay?: number;
        targetRetention?: number;
    };
    archivedAt?: number | null;
    /** Area-wide overrides applied after the selected deck preset. */
    scheduling?: {
        desiredRetention?: number;
        learningSteps?: number[];
        relearningSteps?: number[];
        leechThreshold?: number;
        leechAction?: "tag" | "suspend";
        loadBalance?: boolean;
        reviewAheadDays?: number;
        priority?: number;
        minutesPerDay?: number;
        burySiblings?: "inherit" | "off" | "new" | "review" | "all";
        fsrsWeights?: number[] | null;
    };
}

export interface SavedCardQuery {
    id: string;
    name: string;
    query: string;
    /** Dynamic queries can be launched as temporary study decks. */
    dynamic: boolean;
    /** Optional browser state makes this a full saved view, not only a text query. */
    view?: {
        filter?: string;
        deck?: string;
        tag?: string;
        flag?: string;
        cardType?: string;
        sort?: string;
        sortDirection?: "asc" | "desc";
        columns?: string[];
    };
    createdAt: number;
    updatedAt: number;
}

/** Persistent controls for the generated Obsidian knowledge Canvas. */
export interface KnowledgeCanvasViewState {
    focusAreaId?: string | null;
    focusDeck?: string | null;
    expandedDecks: string[];
    sourceLimit: number;
    layers: {
        filters: boolean;
        areas: boolean;
        decks: boolean;
        sources: boolean;
        links: boolean;
    };
}

export interface KnowledgeGraphViewState {
    collapsedIds: string[];
    showSources: boolean;
    zoom: number;
    panX: number;
    panY: number;
    positions: Record<string, { x: number; y: number }>;
}

export interface ReminderHistoryEntry {
    id: string;
    createdAt: number;
    ruleId: string;
    title: string;
    message: string;
    scope: "all" | "deck" | "area";
    scopeValue: string;
    due: number;
    newCards: number;
    forecast: number;
    delivery: string[];
    status: "sent" | "snoozed" | "skipped" | "failed";
    deepLink: string;
    readAt?: number;
}

export interface ReminderRuntimeState {
    history: ReminderHistoryEntry[];
    lastSentAt: Record<string, number>;
    snoozedUntil: number;
    skippedUntil: number;
}

export interface PluginData {
    settings: SRSettings;
    buryDate: string;
    // hashes of card texts
    // should work as long as user doesn't modify card's text
    // which covers most of the cases
    buryList: string[];
    historyDeck: string | null;
    /** Decks created in the native UI. Paths omit the configured root flashcard tag. */
    managedDecks: string[];
    /** User-defined containers that group decks without changing card source files. */
    knowledgeAreas: KnowledgeArea[];
    /** Anki-style browser searches, optionally usable as temporary dynamic decks. */
    savedCardQueries: SavedCardQuery[];
    /** Ordered card-browser column identifiers. */
    cardBrowserColumns: string[];
    /** The generated Canvas is a saved workspace, not a one-shot export. */
    knowledgeCanvasView: KnowledgeCanvasViewState;
    /** Layout and visibility preferences for the live interactive knowledge graph. */
    knowledgeGraphView: KnowledgeGraphViewState;
    /** Durable notification history and scheduler state; secrets remain device-local. */
    reminderState: ReminderRuntimeState;
    scheduleData: ISerializedScheduleData;
}

export const DEFAULT_DATA: PluginData = {
    settings: DEFAULT_SETTINGS,
    buryDate: "",
    buryList: [],
    historyDeck: null,
    managedDecks: [],
    knowledgeAreas: [],
    savedCardQueries: [],
    cardBrowserColumns: ["question", "answer", "deck", "state", "due", "interval"],
    knowledgeCanvasView: {
        focusAreaId: null,
        focusDeck: null,
        expandedDecks: [],
        sourceLimit: 6,
        layers: {
            filters: true,
            areas: true,
            decks: true,
            sources: true,
            links: true,
        },
    },
    knowledgeGraphView: {
        collapsedIds: [],
        showSources: true,
        zoom: 1,
        panX: 24,
        panY: 24,
        positions: {},
    },
    reminderState: {
        history: [],
        lastSentAt: {},
        snoozedUntil: 0,
        skippedUntil: 0,
    },
    scheduleData: {
        version: 1,
        noteSchedules: {},
        cardSchedules: {},
    },
};
