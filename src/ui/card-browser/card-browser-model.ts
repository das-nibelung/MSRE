import { CardFlag, CardLifecycleState } from "src/data/collection/collection-types";
import { Card } from "src/data/data-structures/card/card";
import { CardType } from "src/data/data-structures/card/questions/question";

export type CardBrowserFilter = "all" | "new" | "due" | "scheduled" | "suspended" | "buried";
export type CardBrowserState = "new" | "due" | "scheduled";
export type CardBrowserSort = "due" | "front" | "note" | "interval";
export type CardBrowserCardType = "basic" | "reversed" | "cloze";

export interface CardBrowserRecord {
    card: Card;
    id: string;
    front: string;
    back: string;
    notePath: string;
    deckNames: string[];
    state: CardBrowserState;
    dueDate: string | null;
    interval: number | null;
    ease: number | null;
    lifecycleState: CardLifecycleState;
    flag: CardFlag;
    tags: string[];
    cardType: CardBrowserCardType;
    collectionCardId?: string | null;
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
            interval: card.scheduleInfo?.interval ?? null,
            ease: card.scheduleInfo?.latestEase ?? null,
            lifecycleState: "active",
            flag: 0,
            tags: [] as string[],
            cardType:
                card.question.questionType === CardType.Cloze
                    ? "cloze"
                    : card.question.questionType === CardType.SingleLineReversed ||
                        card.question.questionType === CardType.MultiLineReversed
                      ? "reversed"
                      : "basic",
        };
    });
}

export function filterCardBrowserRecords(
    records: CardBrowserRecord[],
    query: string,
    filter: CardBrowserFilter,
    deck: string = "all",
    notePath: string | null = null,
    tag: string = "all",
    flag: string = "all",
    cardType: string = "all",
): CardBrowserRecord[] {
    const normalizedQuery = normalizeForSearch(query);
    return records.filter((record) => {
        if (filter === "suspended" || filter === "buried") {
            if (record.lifecycleState !== filter) return false;
        } else if (filter !== "all") {
            if (record.lifecycleState !== "active" || record.state !== filter) return false;
        }
        if (deck !== "all" && !record.deckNames.includes(deck)) return false;
        if (notePath !== null && record.notePath !== notePath) return false;
        if (tag !== "all" && !record.tags.includes(tag)) return false;
        if (flag !== "all" && record.flag !== Number(flag)) return false;
        if (cardType !== "all" && record.cardType !== cardType) return false;
        if (!normalizedQuery) return true;
        return normalizeForSearch(
            [record.front, record.back, record.notePath, ...record.deckNames, ...record.tags].join(
                " ",
            ),
        ).includes(normalizedQuery);
    });
}

export function getCardBrowserTags(records: CardBrowserRecord[]): string[] {
    return [...new Set(records.flatMap((record) => record.tags))].sort((left, right) =>
        left.localeCompare(right),
    );
}

export function getCardBrowserDeckNames(records: CardBrowserRecord[]): string[] {
    return [...new Set(records.flatMap((record) => record.deckNames))].sort((left, right) =>
        left.localeCompare(right),
    );
}

export function sortCardBrowserRecords(
    records: CardBrowserRecord[],
    sort: CardBrowserSort,
): CardBrowserRecord[] {
    const stateOrder: Record<CardBrowserState, number> = { due: 0, new: 1, scheduled: 2 };
    return [...records].sort((left, right) => {
        let result = 0;
        if (sort === "front")
            result = normalizeForSearch(left.front).localeCompare(normalizeForSearch(right.front));
        if (sort === "note") result = left.notePath.localeCompare(right.notePath);
        if (sort === "interval") result = (left.interval ?? -1) - (right.interval ?? -1);
        if (sort === "due") {
            result = stateOrder[left.state] - stateOrder[right.state];
            if (result === 0) result = (left.dueDate ?? "").localeCompare(right.dueDate ?? "");
        }
        return result || left.id.localeCompare(right.id);
    });
}
