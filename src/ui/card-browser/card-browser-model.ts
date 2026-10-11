import { CardFlag, CardLifecycleState, ReviewLogEntry } from "src/data/collection/collection-types";
import { Card } from "src/data/data-structures/card/card";
import { CardType } from "src/data/data-structures/card/questions/question";

export type CardBrowserFilter = "all" | "new" | "due" | "scheduled" | "suspended" | "buried";
export type CardBrowserState = "new" | "due" | "scheduled";
export type CardBrowserSort =
    | "due"
    | "front"
    | "note"
    | "interval"
    | "deck"
    | "type"
    | "reps"
    | "lapses"
    | "retention"
    | "last-review";
export type CardBrowserSortDirection = "asc" | "desc";
export type CardBrowserCardType = "basic" | "reversed" | "cloze";
export type CardBrowserDiagnostic = "duplicate" | "empty";
export type CardBrowserColumn =
    | "question"
    | "answer"
    | "deck"
    | "area"
    | "type"
    | "state"
    | "due"
    | "interval"
    | "ease"
    | "reps"
    | "lapses"
    | "retention"
    | "note"
    | "tags"
    | "last-review";

export const CARD_BROWSER_COLUMNS: CardBrowserColumn[] = [
    "question",
    "answer",
    "deck",
    "area",
    "type",
    "state",
    "due",
    "interval",
    "ease",
    "reps",
    "lapses",
    "retention",
    "note",
    "tags",
    "last-review",
];

export const DEFAULT_CARD_BROWSER_COLUMNS: CardBrowserColumn[] = [
    "question",
    "answer",
    "deck",
    "state",
    "due",
    "interval",
];

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
    noteId?: string | null;
    noteTypeId?: string | null;
    noteTypeName?: string;
    fields?: Record<string, string>;
    fieldNames?: Record<string, string>;
    areaNames?: string[];
    reps?: number;
    lapses?: number;
    retention?: number | null;
    lastReviewAt?: number | null;
    hasMedia?: boolean;
    history?: ReviewLogEntry[];
    diagnostics?: CardBrowserDiagnostic[];
}

interface QueryTerm {
    key: string | null;
    value: string;
}

function normalizeForSearch(value: string): string {
    return value
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLocaleLowerCase();
}

function unquote(value: string): string {
    const trimmed = value.trim();
    if (
        trimmed.length >= 2 &&
        ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
            (trimmed.startsWith("'") && trimmed.endsWith("'")))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function tokenizeQuery(query: string): QueryTerm[] {
    const tokens = query.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    return tokens.map((token) => {
        const separator = token.indexOf(":");
        if (separator <= 0) return { key: null, value: unquote(token) };
        return {
            key: token.slice(0, separator).toLocaleLowerCase(),
            value: unquote(token.slice(separator + 1)),
        };
    });
}

function compareNumber(actual: number | null | undefined, expression: string): boolean {
    if (actual === null || actual === undefined || !Number.isFinite(actual)) return false;
    const match = expression.trim().match(/^(<=|>=|<|>|=)?\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) return false;
    const expected = Number(match[2]);
    if (match[1] === "<") return actual < expected;
    if (match[1] === "<=") return actual <= expected;
    if (match[1] === ">") return actual > expected;
    if (match[1] === ">=") return actual >= expected;
    return actual === expected;
}

function includesNormalized(values: Array<string | undefined>, expected: string): boolean {
    const needle = normalizeForSearch(expected);
    return values.some((value) => normalizeForSearch(value ?? "").includes(needle));
}

function flagValue(value: string): number | null {
    const normalized = normalizeForSearch(value);
    const names: Record<string, number> = {
        none: 0,
        red: 1,
        orange: 2,
        green: 3,
        blue: 4,
        pink: 5,
        turquoise: 6,
        cyan: 6,
        purple: 7,
    };
    if (normalized in names) return names[normalized];
    const numeric = Number(normalized);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 7 ? numeric : null;
}

function matchesQueryTerm(record: CardBrowserRecord, term: QueryTerm): boolean {
    if (!term.key) {
        return includesNormalized(
            [
                record.front,
                record.back,
                record.notePath,
                ...record.deckNames,
                ...(record.areaNames ?? []),
                ...record.tags,
                ...Object.values(record.fields ?? {}),
            ],
            term.value,
        );
    }
    if (term.key === "deck") return includesNormalized(record.deckNames, term.value);
    if (term.key === "area") return includesNormalized(record.areaNames ?? [], term.value);
    if (term.key === "type") {
        return includesNormalized(
            [record.cardType, record.noteTypeName, record.noteTypeId ?? ""],
            term.value,
        );
    }
    if (term.key === "tag") return includesNormalized(record.tags, term.value.replace(/^#/, ""));
    if (term.key === "note") return includesNormalized([record.notePath], term.value);
    if (term.key === "flag") return flagValue(term.value) === record.flag;
    if (term.key === "reps") return compareNumber(record.reps, term.value);
    if (term.key === "lapses") return compareNumber(record.lapses, term.value);
    if (term.key === "retention") return compareNumber(record.retention, term.value);
    if (term.key === "has") {
        return normalizeForSearch(term.value) === "media" ? record.hasMedia === true : false;
    }
    if (term.key === "is") {
        const value = normalizeForSearch(term.value);
        if (value === "suspended" || value === "buried") return record.lifecycleState === value;
        if (value === "active") return record.lifecycleState === "active";
        if (value === "new" || value === "due" || value === "scheduled") {
            return record.lifecycleState === "active" && record.state === value;
        }
        if (value === "duplicate" || value === "empty") {
            return record.diagnostics?.includes(value) ?? false;
        }
        return false;
    }
    if (term.key === "field") {
        const match = term.value.match(/^([^=]+)=(.*)$/);
        if (!match) return false;
        const requestedName = normalizeForSearch(match[1]);
        const expected = unquote(match[2]);
        const fields = record.fields ?? {};
        const names = record.fieldNames ?? {};
        return Object.entries(fields).some(
            ([id, value]) =>
                (normalizeForSearch(id) === requestedName ||
                    normalizeForSearch(names[id] ?? "") === requestedName) &&
                includesNormalized([value], expected),
        );
    }
    return false;
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

export function annotateCardBrowserDiagnostics(records: CardBrowserRecord[]): CardBrowserRecord[] {
    const duplicateGroups = new Map<string, string[]>();
    for (const record of records) {
        const front = normalizeForSearch(record.front);
        const back = normalizeForSearch(record.back);
        if (!front && !back) continue;
        const key = `${front}\u0000${back}`;
        duplicateGroups.set(key, [...(duplicateGroups.get(key) ?? []), record.id]);
    }
    const duplicateIds = new Set(
        [...duplicateGroups.values()].filter((ids) => ids.length > 1).flat(),
    );
    return records.map((record) => {
        const hasText = Boolean(normalizeForSearch(`${record.front} ${record.back}`));
        const diagnostics: CardBrowserDiagnostic[] = [];
        if (duplicateIds.has(record.id)) diagnostics.push("duplicate");
        if (!hasText && !record.hasMedia) diagnostics.push("empty");
        return { ...record, diagnostics };
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
    const terms = tokenizeQuery(query);
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
        return terms.every((term) => matchesQueryTerm(record, term));
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
    direction: CardBrowserSortDirection = "asc",
): CardBrowserRecord[] {
    const stateOrder: Record<CardBrowserState, number> = { due: 0, new: 1, scheduled: 2 };
    const multiplier = direction === "asc" ? 1 : -1;
    return [...records].sort((left, right) => {
        let result = 0;
        if (sort === "front")
            result = normalizeForSearch(left.front).localeCompare(normalizeForSearch(right.front));
        if (sort === "note") result = left.notePath.localeCompare(right.notePath);
        if (sort === "deck")
            result = (left.deckNames[0] ?? "").localeCompare(right.deckNames[0] ?? "");
        if (sort === "type")
            result = (left.noteTypeName ?? left.cardType).localeCompare(
                right.noteTypeName ?? right.cardType,
            );
        if (sort === "interval") result = (left.interval ?? -1) - (right.interval ?? -1);
        if (sort === "reps") result = (left.reps ?? 0) - (right.reps ?? 0);
        if (sort === "lapses") result = (left.lapses ?? 0) - (right.lapses ?? 0);
        if (sort === "retention") result = (left.retention ?? -1) - (right.retention ?? -1);
        if (sort === "last-review") result = (left.lastReviewAt ?? 0) - (right.lastReviewAt ?? 0);
        if (sort === "due") {
            result = stateOrder[left.state] - stateOrder[right.state];
            if (result === 0) result = (left.dueDate ?? "").localeCompare(right.dueDate ?? "");
        }
        return result * multiplier || left.id.localeCompare(right.id);
    });
}
