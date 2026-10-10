import { CardType } from "src/data/data-structures/card/questions/question";
import { ISerializedScheduleEntry } from "src/data/plugin-data";
import { RepetitionPhase } from "src/scheduling/algorithms/base/repetition-item";
import { TextDirection } from "src/utils/strings";

export const CARD_INDEX_SCHEMA_VERSION = 2;

export interface CardIndexFileRevision {
    mtime: number;
    size: number;
}

export interface SerializedTopicPathWithWhitespace {
    path: string[];
    preWhitespace: string;
    postWhitespace: string;
}

export interface SerializedQuestionText {
    original: string;
    topicPathWithWhitespace: SerializedTopicPathWithWhitespace | null;
    actualQuestion: string;
    textDirection: TextDirection;
    obsidianBlockId: string | null;
}

export interface SerializedCard {
    front: string;
    back: string;
    cardIdx: number;
    repetitionPhase: RepetitionPhase;
    schedule: ISerializedScheduleEntry | null;
    storageInfo: {
        notePath: string | null;
        questionHash: string | null;
        questionId: string | null;
    } | null;
}

export interface SerializedQuestion {
    parsedQuestionInfo: {
        cardType: CardType;
        text: string;
        firstLineNum: number;
        lastLineNum: number;
    };
    topicPaths: string[][];
    topicPathLineNum: number | null;
    questionText: SerializedQuestionText;
    questionContext: string[];
    cards: SerializedCard[];
}

export interface SerializedNote {
    questions: SerializedQuestion[];
}

export interface CardIndexRecord {
    path: string;
    schemaVersion: number;
    settingsFingerprint: string;
    mtime: number;
    size: number;
    note: SerializedNote;
    updatedAt: number;
}

export interface CardIndexStorage {
    get(path: string): Promise<CardIndexRecord | undefined>;
    put(record: CardIndexRecord): Promise<void>;
    delete(path: string): Promise<void>;
    getAllPaths(): Promise<string[]>;
    close(): void;
}
