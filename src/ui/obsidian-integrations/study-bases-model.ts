import type { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";

export interface StudyBaseFile {
    path: string;
    basename: string;
}

export interface StudyBaseSummary extends StudyBaseFile {
    total: number;
    due: number;
    newCards: number;
    scheduled: number;
    decks: string[];
    areas: string[];
    tags: string[];
    lapses: number;
    retention: number | null;
    difficulty: number | null;
    stability: number | null;
    lastReviewAt: number | null;
}

export type StudyBasePreset = "all" | "today" | "errors" | "weak" | "no-area";
export type StudyCsvRow = Record<string, string>;

/** Parses quoted, multiline-safe-enough CSV exported by the Study Base. */
export function parseStudyCsv(content: string): StudyCsvRow[] {
    const table: string[][] = [];
    let row: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < content.length; index++) {
        const character = content[index];
        if (quoted) {
            if (character === '"' && content[index + 1] === '"') {
                value += '"';
                index++;
            } else if (character === '"') quoted = false;
            else value += character;
        } else if (character === '"') quoted = true;
        else if (character === ",") {
            row.push(value);
            value = "";
        } else if (character === "\n") {
            row.push(value.replace(/\r$/g, ""));
            table.push(row);
            row = [];
            value = "";
        } else value += character;
    }
    if (value || row.length) {
        row.push(value.replace(/\r$/g, ""));
        table.push(row);
    }
    const headers = table.shift()?.map((header) => header.trim()) ?? [];
    return table
        .filter((cells) => cells.some(Boolean))
        .map((cells) =>
            Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
        );
}

export function aggregateStudyBaseEntries(
    files: StudyBaseFile[],
    records: CardBrowserRecord[],
): StudyBaseSummary[] {
    const recordsByPath = new Map<string, CardBrowserRecord[]>();
    for (const record of records) {
        const group = recordsByPath.get(record.notePath) ?? [];
        group.push(record);
        recordsByPath.set(record.notePath, group);
    }
    return files.map((file) => {
        const cards = recordsByPath.get(file.path) ?? [];
        return {
            ...file,
            total: cards.length,
            due: cards.filter((card) => card.state === "due").length,
            newCards: cards.filter((card) => card.state === "new").length,
            scheduled: cards.filter((card) => card.state === "scheduled").length,
            decks: [...new Set(cards.flatMap((card) => card.deckNames))].sort((a, b) =>
                a.localeCompare(b),
            ),
            areas: [...new Set(cards.flatMap((card) => card.areaNames ?? []))].sort((a, b) =>
                a.localeCompare(b),
            ),
            tags: [...new Set(cards.flatMap((card) => card.tags))].sort((a, b) =>
                a.localeCompare(b),
            ),
            lapses: cards.reduce((sum, card) => sum + (card.lapses ?? 0), 0),
            retention: average(cards.map((card) => card.retention)),
            difficulty: average(cards.map((card) => card.difficulty)),
            stability: average(cards.map((card) => card.stability)),
            lastReviewAt:
                cards.reduce((latest, card) => Math.max(latest, card.lastReviewAt ?? 0), 0) || null,
        };
    });
}

export function filterStudyBaseRecords(
    records: CardBrowserRecord[],
    preset: StudyBasePreset,
): CardBrowserRecord[] {
    if (preset === "today") {
        return records.filter(
            (record) =>
                record.lifecycleState === "active" &&
                (record.state === "due" || record.state === "new"),
        );
    }
    if (preset === "errors") return records.filter((record) => (record.lapses ?? 0) > 0);
    if (preset === "weak") {
        return records.filter(
            (record) =>
                (record.lapses ?? 0) >= 2 ||
                (record.retention !== null &&
                    record.retention !== undefined &&
                    record.retention < 0.85) ||
                (record.difficulty ?? 0) >= 7,
        );
    }
    if (preset === "no-area") return records.filter((record) => !record.areaNames?.length);
    return records;
}

function average(values: Array<number | null | undefined>): number | null {
    const valid = values.filter((value): value is number =>
        Boolean(value !== null && value !== undefined && Number.isFinite(value)),
    );
    if (!valid.length) return null;
    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

export function filterStudyBaseSummaries(
    summaries: StudyBaseSummary[],
    preset: StudyBasePreset,
): StudyBaseSummary[] {
    if (preset === "today") return summaries.filter((entry) => entry.due > 0);
    if (preset === "errors") return summaries.filter((entry) => entry.lapses > 0);
    if (preset === "weak") {
        return summaries.filter(
            (entry) =>
                entry.lapses >= 2 ||
                (entry.retention !== null && entry.retention < 0.85) ||
                (entry.difficulty !== null && entry.difficulty >= 7),
        );
    }
    if (preset === "no-area") return summaries.filter((entry) => entry.areas.length === 0);
    return summaries;
}
