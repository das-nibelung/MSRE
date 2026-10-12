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
        };
    });
}
