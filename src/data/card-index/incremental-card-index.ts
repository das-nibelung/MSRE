import {
    CARD_INDEX_SCHEMA_VERSION,
    CardIndexFileRevision,
    CardIndexRecord,
    CardIndexStorage,
} from "src/data/card-index/card-index-types";
import { deserializeNote, serializeNote } from "src/data/card-index/note-serializer";
import { ISRNoteTFile } from "src/data/data-structures/file/note-file";
import { SRSettings } from "src/data/settings";
import { Note } from "src/note/note";
import { TextDirection } from "src/utils/strings";

export interface CardIndexStats {
    hits: number;
    misses: number;
    writes: number;
}

export function getCardIndexSettingsFingerprint(
    settings: SRSettings,
    defaultTextDirection: TextDirection = TextDirection.Unspecified,
): string {
    return JSON.stringify({
        flashcardTags: settings.flashcardTags,
        convertFoldersToDecks: settings.convertFoldersToDecks,
        convertClozePatternsToInputs: settings.convertClozePatternsToInputs,
        convertHighlightsToClozes: settings.convertHighlightsToClozes,
        convertBoldTextToClozes: settings.convertBoldTextToClozes,
        convertCurlyBracketsToClozes: settings.convertCurlyBracketsToClozes,
        clozePatterns: settings.clozePatterns,
        singleLineCardSeparator: settings.singleLineCardSeparator,
        singleLineReversedCardSeparator: settings.singleLineReversedCardSeparator,
        multilineCardSeparator: settings.multilineCardSeparator,
        multilineReversedCardSeparator: settings.multilineReversedCardSeparator,
        multilineCardEndMarker: settings.multilineCardEndMarker,
        algorithm: settings.algorithm,
        dataStore: settings.dataStore,
        defaultTextDirection,
    });
}

export class IncrementalCardIndex {
    private fingerprint: string;
    private readonly stats: CardIndexStats = { hits: 0, misses: 0, writes: 0 };
    private hasPruned = false;

    constructor(
        settings: SRSettings,
        private readonly storage: CardIndexStorage,
        defaultTextDirection: TextDirection = TextDirection.Unspecified,
    ) {
        this.fingerprint = getCardIndexSettingsFingerprint(settings, defaultTextDirection);
    }

    setContext(settings: SRSettings, defaultTextDirection: TextDirection): void {
        this.fingerprint = getCardIndexSettingsFingerprint(settings, defaultTextDirection);
    }

    async get(noteFile: ISRNoteTFile, revision: CardIndexFileRevision): Promise<Note | undefined> {
        try {
            const record = await this.storage.get(noteFile.path);
            if (
                !record ||
                record.schemaVersion !== CARD_INDEX_SCHEMA_VERSION ||
                record.settingsFingerprint !== this.fingerprint ||
                record.mtime !== revision.mtime ||
                record.size !== revision.size
            ) {
                this.stats.misses++;
                return undefined;
            }

            this.stats.hits++;
            return deserializeNote(record.note, noteFile);
        } catch (error) {
            this.stats.misses++;
            console.warn("SR: Unable to read the incremental card index", error);
            return undefined;
        }
    }

    async put(noteFile: ISRNoteTFile, revision: CardIndexFileRevision, note: Note): Promise<void> {
        const record: CardIndexRecord = {
            path: noteFile.path,
            schemaVersion: CARD_INDEX_SCHEMA_VERSION,
            settingsFingerprint: this.fingerprint,
            mtime: revision.mtime,
            size: revision.size,
            note: serializeNote(note),
            updatedAt: Date.now(),
        };
        try {
            await this.storage.put(record);
            this.stats.writes++;
        } catch (error) {
            console.warn("SR: Unable to update the incremental card index", error);
        }
    }

    async invalidate(path: string): Promise<void> {
        try {
            await this.storage.delete(path);
        } catch (error) {
            console.warn(`SR: Unable to invalidate the card index entry for ${path}`, error);
        }
    }

    async prune(existingPaths: Set<string>): Promise<void> {
        if (this.hasPruned) return;
        try {
            const indexedPaths = await this.storage.getAllPaths();
            await Promise.all(
                indexedPaths
                    .filter((path) => !existingPaths.has(path))
                    .map((path) => this.storage.delete(path)),
            );
            this.hasPruned = true;
        } catch (error) {
            console.warn("SR: Unable to prune the incremental card index", error);
        }
    }

    getStats(): CardIndexStats {
        return { ...this.stats };
    }

    resetStats(): void {
        this.stats.hits = 0;
        this.stats.misses = 0;
        this.stats.writes = 0;
    }

    close(): void {
        this.storage.close();
    }
}
