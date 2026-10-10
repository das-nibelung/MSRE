import { Card } from "src/data/data-structures/card/card";

export type CardBrowserFilter = "all" | "new" | "due" | "scheduled";
export type CardBrowserState = Exclude<CardBrowserFilter, "all">;

export interface CardBrowserRecord {
    card: Card;
    id: string;
    front: string;
    back: string;
    notePath: string;
    deckNames: string[];
    state: CardBrowserState;
    dueDate: string | null;
}

function normalizeForSearch(value: string): string {
    return value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
}

function getCardState(card: Card): CardBrowserState {
    if (card.isNew) return "new";
    return card.isDue ? "due" : "scheduled";
}

export function createCardBrowserRecords(cards: Card[]): CardBrowserRecord[] {
    return cards.map((card, index) => {
        const deckNames = card.question.topicPathList.list
            .map((topicPath) => topicPath.path.join("/"))
            .filter(Boolean);
        return {
            card,
            id:
                card.stableId ??
                `${card.question.note?.filePath ?? "unknown"}:${card.question.lineNo}:${card.cardIdx}:${index}`,
            front: card.front,
            back: card.back,
            notePath: card.question.note?.filePath ?? card.storageInfo?.notePath ?? "",
            deckNames,
            state: getCardState(card),
            dueDate: card.scheduleInfo?.formatDueDate() ?? null,
        };
    });
}

export function filterCardBrowserRecords(
    records: CardBrowserRecord[],
    query: string,
    filter: CardBrowserFilter,
): CardBrowserRecord[] {
    const normalizedQuery = normalizeForSearch(query);
    return records.filter((record) => {
        if (filter !== "all" && record.state !== filter) return false;
        if (!normalizedQuery) return true;
        return normalizeForSearch(
            [record.front, record.back, record.notePath, ...record.deckNames].join(" "),
        ).includes(normalizedQuery);
    });
}
