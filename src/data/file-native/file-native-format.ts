import {
    CardAnswerMode,
    CollectionDeck,
    DeckOptionsDefinition,
    NoteTypeDefinition,
} from "src/data/collection/collection-types";
import { KnowledgeArea } from "src/data/plugin-data";

export const FILE_NATIVE_SCHEMA_VERSION = 1;
export const FILE_NATIVE_CATALOG_PATH = "Spaced Repetition/library.sr.md";

const DOCUMENT_MARKER = "msre-file-native-v1";
const DOCUMENT_PATTERN =
    /\n?<!--\s*msre-file-native-v1\s*\n([\s\S]*?)\nmsre-file-native-end\s*-->\s*$/i;
const CATALOG_JSON_BLOCK = /```json\s*([\s\S]*?)\s*```/i;

export interface FileNativeNoteRecord {
    id: string;
    noteTypeId: string;
    fields: Record<string, string>;
    answerMode?: CardAnswerMode;
    tags: string[];
    deckPath: string;
    questionId: string | null;
    legacyQuestionIds?: Record<number, string>;
    legacyStableIds?: Record<number, string>;
    /** Portable external identity makes repeated imports idempotent without relying on the cache. */
    externalIds?: Record<string, string>;
    /** Original scheduler/card metadata retained for a lossless round trip. */
    externalData?: Record<string, unknown>;
    /** Hash of the visible Markdown body when the native editor last wrote it. */
    bodyHash: string;
    createdAt: number;
    updatedAt: number;
}

export interface FileNativeDocument {
    schemaVersion: typeof FILE_NATIVE_SCHEMA_VERSION;
    notes: FileNativeNoteRecord[];
}

export interface FileNativeCatalog {
    schemaVersion: typeof FILE_NATIVE_SCHEMA_VERSION;
    updatedAt: number;
    noteTypes: NoteTypeDefinition[];
    deckOptions: DeckOptionsDefinition[];
    decks: CollectionDeck[];
    managedDecks: string[];
    knowledgeAreas: KnowledgeArea[];
}

function safeJson(value: unknown): string {
    // An HTML comment is ignored by Obsidian's card parser. Escaping double hyphens keeps
    // arbitrary field content from terminating the comment while remaining valid JSON.
    return JSON.stringify(value, null, 2).replaceAll("--", "\\u002d\\u002d");
}

export function visibleMarkdown(contents: string): string {
    return contents.replace(DOCUMENT_PATTERN, "").trimEnd();
}

export function hashVisibleMarkdown(contents: string): string {
    const value = visibleMarkdown(contents).replace(/\r\n/g, "\n");
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function readFileNativeDocument(contents: string): FileNativeDocument | null {
    const match = contents.match(DOCUMENT_PATTERN);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1]) as Partial<FileNativeDocument>;
        if (parsed.schemaVersion !== FILE_NATIVE_SCHEMA_VERSION || !Array.isArray(parsed.notes)) {
            return null;
        }
        const notes = parsed.notes.filter(
            (note): note is FileNativeNoteRecord =>
                !!note &&
                typeof note.id === "string" &&
                typeof note.noteTypeId === "string" &&
                !!note.fields &&
                typeof note.fields === "object" &&
                typeof note.deckPath === "string",
        );
        return { schemaVersion: FILE_NATIVE_SCHEMA_VERSION, notes };
    } catch {
        return null;
    }
}

export function writeFileNativeDocument(
    visibleContents: string,
    notes: FileNativeNoteRecord[],
): string {
    const body = visibleMarkdown(visibleContents);
    const manifest: FileNativeDocument = {
        schemaVersion: FILE_NATIVE_SCHEMA_VERSION,
        notes,
    };
    return `${body}\n\n<!-- ${DOCUMENT_MARKER}\n${safeJson(manifest)}\nmsre-file-native-end -->\n`;
}

export function formatFileNativeCatalog(catalog: FileNativeCatalog): string {
    return [
        "# Spaced Repetition library",
        "",
        "> [!info] Portable library definition",
        "> This file is the source of truth for note types, templates, decks, and knowledge areas.",
        "> It is ordinary Markdown and can be synced, versioned, or restored with the vault.",
        "",
        "```json",
        safeJson(catalog),
        "```",
        "",
    ].join("\n");
}

export function parseFileNativeCatalog(contents: string | null): FileNativeCatalog | null {
    const match = contents?.match(CATALOG_JSON_BLOCK);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1]) as Partial<FileNativeCatalog>;
        if (parsed.schemaVersion !== FILE_NATIVE_SCHEMA_VERSION) return null;
        if (
            !Array.isArray(parsed.noteTypes) ||
            !Array.isArray(parsed.deckOptions) ||
            !Array.isArray(parsed.decks) ||
            !Array.isArray(parsed.managedDecks) ||
            !Array.isArray(parsed.knowledgeAreas)
        ) {
            return null;
        }
        return parsed as FileNativeCatalog;
    } catch {
        return null;
    }
}
