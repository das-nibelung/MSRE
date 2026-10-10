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
    /** Visible deck paths, without the configured root flashcard tag. */
    deckPaths: string[];
    pinned: boolean;
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
    scheduleData: ISerializedScheduleData;
}

export const DEFAULT_DATA: PluginData = {
    settings: DEFAULT_SETTINGS,
    buryDate: "",
    buryList: [],
    historyDeck: null,
    managedDecks: [],
    knowledgeAreas: [],
    scheduleData: {
        version: 1,
        noteSchedules: {},
        cardSchedules: {},
    },
};
