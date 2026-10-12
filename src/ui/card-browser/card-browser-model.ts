import {
    CardFlag,
    CardLifecycleState,
    CollectionEditHistoryEntry,
    ReviewLogEntry,
} from "src/data/collection/collection-types";
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
    | "difficulty"
    | "stability"
    | "created"
    | "last-review";
export type CardBrowserSortDirection = "asc" | "desc";
export type CardBrowserCardType = "basic" | "reversed" | "cloze";
export type CardBrowserDiagnostic = "duplicate" | "empty" | "orphan" | "missing-media";
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
    | "difficulty"
    | "stability"
    | "created"
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
    "difficulty",
    "stability",
    "created",
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

/**
 * Turn rich card content into a short, readable browser summary without
 * leaking Markdown syntax or media embeds into the compact list row.
 */
export function compactCardText(value: string): string {
    return value
        .replace(/<!--SR:[\s\S]*?-->/g, "")
        .replace(/!\[\[[^\]]+\]\]/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]*>/g, " ")
        .replace(/\^[-\w]+\s*$/g, "")
        .replace(/[*_~`]/g, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}

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
    difficulty?: number | null;
    stability?: number | null;
    createdAt?: number | null;
    updatedAt?: number | null;
    lastReviewAt?: number | null;
    lastRating?: number | null;
    hasMedia?: boolean;
    hasSource?: boolean;
    missingMediaPaths?: string[];
    history?: ReviewLogEntry[];
    editHistory?: CollectionEditHistoryEntry[];
    diagnostics?: CardBrowserDiagnostic[];
}

interface QueryTerm {
    key: string | null;
    value: string;
}

type QueryExpression =
    | { type: "term"; term: QueryTerm }
    | { type: "not"; child: QueryExpression }
    | { type: "and" | "or"; children: QueryExpression[] };

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

function lexQuery(query: string): string[] {
    const tokens: string[] = [];
    let buffer = "";
    let quote = "";
    const flush = (): void => {
        if (buffer) tokens.push(buffer);
        buffer = "";
    };
    for (const character of query.trim()) {
        if (quote) {
            buffer += character;
            if (character === quote) quote = "";
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
            buffer += character;
        } else if (character === "(" || character === ")" || character === "|") {
            flush();
            tokens.push(character);
        } else if (/\s/.test(character)) flush();
        else buffer += character;
    }
    flush();
    return tokens;
}

function toQueryTerm(token: string): QueryTerm {
    const separator = token.indexOf(":");
    if (separator <= 0) return { key: null, value: unquote(token) };
    return {
        key: token.slice(0, separator).toLocaleLowerCase(),
        value: unquote(token.slice(separator + 1)),
    };
}

/** Parses a compact Anki-style query with implicit AND, OR, NOT and parentheses. */
export function parseCardBrowserQuery(query: string): QueryExpression | null {
    const tokens = lexQuery(query);
    let position = 0;
    const parseUnary = (): QueryExpression | null => {
        const token = tokens[position];
        if (!token) return null;
        if (token.toLocaleUpperCase() === "NOT") {
            position++;
            const child = parseUnary();
            return child ? { type: "not", child } : null;
        }
        if (token === "(") {
            position++;
            const child = parseOr();
            if (tokens[position] === ")") position++;
            return child;
        }
        if (token === ")" || token === "|" || token.toLocaleUpperCase() === "OR") return null;
        position++;
        if (token.startsWith("-") && token.length > 1) {
            return { type: "not", child: { type: "term", term: toQueryTerm(token.slice(1)) } };
        }
        return { type: "term", term: toQueryTerm(token) };
    };
    const parseAnd = (): QueryExpression | null => {
        const children: QueryExpression[] = [];
        while (position < tokens.length) {
            const token = tokens[position];
            if (token === ")" || token === "|" || token.toLocaleUpperCase() === "OR") break;
            if (token.toLocaleUpperCase() === "AND") {
                position++;
                continue;
            }
            const child = parseUnary();
            if (!child) break;
            children.push(child);
        }
        if (children.length === 0) return null;
        return children.length === 1 ? children[0] : { type: "and", children };
    };
    const parseOr = (): QueryExpression | null => {
        const children: QueryExpression[] = [];
        const first = parseAnd();
        if (first) children.push(first);
        while (tokens[position] === "|" || tokens[position]?.toLocaleUpperCase() === "OR") {
            position++;
            const child = parseAnd();
            if (child) children.push(child);
        }
        if (children.length === 0) return null;
        return children.length === 1 ? children[0] : { type: "or", children };
    };
    return parseOr();
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

function dateValue(value: string, now: number): number | null {
    const normalized = value.trim().toLocaleLowerCase();
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    if (normalized === "today") return date.getTime();
    if (normalized === "yesterday") return date.getTime() - 86_400_000;
    if (normalized === "tomorrow") return date.getTime() + 86_400_000;
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function compareDate(
    actual: number | string | null | undefined,
    expression: string,
    now: number = Date.now(),
): boolean {
    if (actual === null || actual === undefined) return false;
    const actualValue = typeof actual === "number" ? actual : Date.parse(actual);
    if (!Number.isFinite(actualValue)) return false;
    const recent = expression.trim().match(/^(\d+)d$/i);
    if (recent) return actualValue >= now - Number(recent[1]) * 86_400_000 && actualValue <= now;
    const match = expression.trim().match(/^(<=|>=|<|>|=)?\s*(.+)$/);
    const expected = match ? dateValue(match[2], now) : null;
    if (!match || expected === null) return false;
    const operator = match[1] ?? "=";
    if (operator === "<") return actualValue < expected;
    if (operator === "<=") return actualValue < expected + 86_400_000;
    if (operator === ">") return actualValue >= expected + 86_400_000;
    if (operator === ">=") return actualValue >= expected;
    return actualValue >= expected && actualValue < expected + 86_400_000;
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

function ratingValue(value: string): number | null {
    const normalized = normalizeForSearch(value);
    const names: Record<string, number> = { again: 1, hard: 2, good: 3, easy: 4 };
    return (
        names[normalized] ??
        (compareNumber(Number(normalized), normalized) ? Number(normalized) : null)
    );
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
    if (term.key === "difficulty") return compareNumber(record.difficulty, term.value);
    if (term.key === "stability") return compareNumber(record.stability, term.value);
    if (term.key === "ease") return compareNumber(record.ease, term.value);
    if (term.key === "rating") return ratingValue(term.value) === record.lastRating;
    if (term.key === "created") return compareDate(record.createdAt, term.value);
    if (term.key === "updated") return compareDate(record.updatedAt, term.value);
    if (term.key === "reviewed" || term.key === "review") {
        return compareDate(record.lastReviewAt, term.value);
    }
    if (term.key === "due") return compareDate(record.dueDate, term.value);
    if (term.key === "has") {
        const value = normalizeForSearch(term.value);
        if (value === "media") return record.hasMedia === true;
        if (value === "source") return record.hasSource !== false;
        if (value === "missing-media") return Boolean(record.missingMediaPaths?.length);
        return false;
    }
    if (term.key === "is") {
        const value = normalizeForSearch(term.value);
        if (value === "no-area") return (record.areaNames?.length ?? 0) === 0;
        if (value === "suspended" || value === "buried") return record.lifecycleState === value;
        if (value === "active") return record.lifecycleState === "active";
        if (value === "new" || value === "due" || value === "scheduled") {
            return record.lifecycleState === "active" && record.state === value;
        }
        if (
            value === "duplicate" ||
            value === "empty" ||
            value === "orphan" ||
            value === "missing-media"
        ) {
            return record.diagnostics?.includes(value) ?? false;
        }
        return false;
    }
    if (term.key === "field") {
        const match = term.value.match(/^([^=]+)=(.*)$/);
        if (!match) {
            const requestedName = normalizeForSearch(term.value);
            return Object.keys(record.fields ?? {}).some(
                (id) =>
                    normalizeForSearch(id) === requestedName ||
                    normalizeForSearch(record.fieldNames?.[id] ?? "") === requestedName,
            );
        }
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

function matchesExpression(record: CardBrowserRecord, expression: QueryExpression | null): boolean {
    if (!expression) return true;
    if (expression.type === "term") return matchesQueryTerm(record, expression.term);
    if (expression.type === "not") return !matchesExpression(record, expression.child);
    if (expression.type === "and") {
        return expression.children.every((child) => matchesExpression(record, child));
    }
    return expression.children.some((child) => matchesExpression(record, child));
}

/** Returns a human-readable syntax error without throwing while the user is typing. */
export function validateCardBrowserQuery(query: string): string | null {
    let quote = "";
    let depth = 0;
    for (const character of query) {
        if (quote) {
            if (character === quote) quote = "";
            continue;
        }
        if (character === '"' || character === "'") quote = character;
        if (character === "(") depth++;
        if (character === ")") depth--;
        if (depth < 0) return "Unexpected closing parenthesis";
    }
    if (quote) return "Unclosed quote";
    if (depth > 0) return "Unclosed parenthesis";
    return null;
}

export function extractCardMediaPaths(value: string): string[] {
    const paths = new Set<string>();
    for (const match of value.matchAll(/!\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        if (match[1]?.trim()) paths.add(match[1].trim());
    }
    for (const match of value.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
        if (match[1]?.trim() && !/^(?:https?:|data:)/i.test(match[1])) paths.add(match[1].trim());
    }
    for (const match of value.matchAll(
        /<(?:img|audio|video|source)\b[^>]*\bsrc=["']([^"']+)["']/gi,
    )) {
        if (match[1]?.trim() && !/^(?:https?:|data:)/i.test(match[1])) paths.add(match[1].trim());
    }
    return [...paths];
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
        if (record.hasSource === false) diagnostics.push("orphan");
        if (record.missingMediaPaths?.length) diagnostics.push("missing-media");
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
    const expression = parseCardBrowserQuery(query);
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
        return matchesExpression(record, expression);
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
        if (sort === "difficulty") result = (left.difficulty ?? -1) - (right.difficulty ?? -1);
        if (sort === "stability") result = (left.stability ?? -1) - (right.stability ?? -1);
        if (sort === "created") result = (left.createdAt ?? 0) - (right.createdAt ?? 0);
        if (sort === "last-review") result = (left.lastReviewAt ?? 0) - (right.lastReviewAt ?? 0);
        if (sort === "due") {
            result = stateOrder[left.state] - stateOrder[right.state];
            if (result === 0) result = (left.dueDate ?? "").localeCompare(right.dueDate ?? "");
        }
        return result * multiplier || left.id.localeCompare(right.id);
    });
}
