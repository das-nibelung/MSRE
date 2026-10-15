import {
    CollectionCard,
    CollectionData,
    ReviewLogData,
} from "src/data/collection/collection-types";
import { Card } from "src/data/data-structures/card/card";
import { Deck } from "src/data/data-structures/deck/deck";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { RepItemState } from "src/scheduling/algorithms/base/repetition-item";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";

const DAY = 86_400_000;
const DEFAULT_RESPONSE_MS = 12_000;

export interface ReviewSessionPlan {
    availableCards: number;
    selectedCards: number;
    dueCards: number;
    newCards: number;
    backlogCards: number;
    aheadCards: number;
    estimatedMinutes: number;
    averageResponseMs: number;
    finishAt: number;
}

export interface PlannedCard {
    card: CollectionCard;
    dueAt: number | null;
    priority: number;
    score: number;
    /** Positive when this card was promoted to unlock dependent knowledge. */
    dependencyBoost: number;
    /** Human-readable paths whose review depends on this prerequisite. */
    unlocks: string[];
    /** Weak prerequisite paths that should be reviewed before this card. */
    blockedBy: string[];
}

export interface KnowledgeDependencyEdge {
    prerequisitePath: string;
    dependentPath: string;
    reason?: string;
    source: "frontmatter" | "compiler" | "manual";
}

export interface ReviewPlanInsight {
    cardId: string;
    stableId: string | null;
    kind: "prerequisite" | "dependent" | "learning" | "overdue" | "new" | "scheduled";
    headline: string;
    detail: string;
    score: number;
    unlocks: string[];
    blockedBy: string[];
}

export function explainPlannedCard(item: PlannedCard, now = Date.now()): ReviewPlanInsight {
    const stableId = item.card.legacyStableId;
    if (item.dependencyBoost > 0) {
        return {
            cardId: item.card.id,
            stableId,
            kind: "prerequisite",
            headline: "Prerequisite first",
            detail: `Reviewing this now unlocks ${item.unlocks.length} dependent knowledge ${item.unlocks.length === 1 ? "path" : "paths"}.`,
            score: item.score,
            unlocks: item.unlocks,
            blockedBy: item.blockedBy,
        };
    }
    if (item.blockedBy.length > 0) {
        return {
            cardId: item.card.id,
            stableId,
            kind: "dependent",
            headline: "Dependent knowledge",
            detail: `${item.blockedBy.length} weak ${item.blockedBy.length === 1 ? "prerequisite is" : "prerequisites are"} scheduled before this card.`,
            score: item.score,
            unlocks: item.unlocks,
            blockedBy: item.blockedBy,
        };
    }
    if (item.card.queue === "learning" || item.card.queue === "relearning") {
        return {
            cardId: item.card.id,
            stableId,
            kind: "learning",
            headline: "Learning step",
            detail: "This card is in an active learning sequence and should not wait.",
            score: item.score,
            unlocks: [],
            blockedBy: [],
        };
    }
    if (item.card.queue === "new") {
        return {
            cardId: item.card.id,
            stableId,
            kind: "new",
            headline: "New knowledge",
            detail: "Selected inside today’s new-card and time limits.",
            score: item.score,
            unlocks: [],
            blockedBy: [],
        };
    }
    const overdueDays = item.dueAt === null ? 0 : Math.max(0, Math.floor((now - item.dueAt) / DAY));
    return {
        cardId: item.card.id,
        stableId,
        kind: overdueDays > 0 ? "overdue" : "scheduled",
        headline: overdueDays > 0 ? `${overdueDays}d overdue` : "Memory due",
        detail:
            overdueDays > 0
                ? "Forgetting risk and overdue time raised this card in the queue."
                : "The scheduler placed this card inside the current review horizon.",
        score: item.score,
        unlocks: [],
        blockedBy: [],
    };
}

export function averageReviewDuration(reviewLog: ReviewLogData): number {
    const recent = Object.values(reviewLog.entries)
        .filter((entry) => !entry.deletedAt && entry.durationMs !== null && entry.durationMs > 0)
        .sort((left, right) => right.reviewedAt - left.reviewedAt)
        .slice(0, 500)
        .map((entry) => Math.min(120_000, entry.durationMs));
    if (!recent.length) return DEFAULT_RESPONSE_MS;
    return recent.reduce((sum, value) => sum + value, 0) / recent.length;
}

export function cardDueAt(card: Pick<CollectionCard, "schedule">): number | null {
    if (!card.schedule) return null;
    const due = Date.parse(card.schedule.scheduleData.dueDate);
    return Number.isFinite(due) ? due : null;
}

function retrievability(card: CollectionCard, now: number): number {
    if (!card.schedule || card.schedule.algorithm !== SRAlgorithmType.FSRS) return 1;
    const schedule = card.schedule.scheduleData as ISerializedFSRSScheduleData;
    const lastReview = Date.parse(schedule.lastReview);
    if (!Number.isFinite(lastReview) || !Number.isFinite(schedule.stability)) return 1;
    const elapsed = Math.max(0, (now - lastReview) / DAY);
    return Math.pow(1 + (19 / 81) * (elapsed / Math.max(0.001, schedule.stability)), -0.5);
}

export function planReviewSession(
    collection: CollectionData,
    reviewLog: ReviewLogData,
    options: {
        now?: number;
        minutes?: number;
        aheadDays?: number;
        intelligentBacklog?: boolean;
        priorityForDeck?: (deckPath: string) => number;
        aheadDaysForDeck?: (deckPath: string) => number;
        dependencyEdges?: KnowledgeDependencyEdge[];
        dependencyRetentionThreshold?: number;
        /** Optional queue boundary after daily deck limits; graph prerequisites may cross it. */
        baselineCardIds?: ReadonlySet<string>;
    } = {},
): { plan: ReviewSessionPlan; cards: PlannedCard[] } {
    const now = options.now ?? Date.now();
    const responseMs = averageReviewDuration(reviewLog);
    const activeCards = Object.values(collection.cards).filter(
        (card) => !card.deletedAt && card.state === "active",
    );
    const notePath = (card: CollectionCard): string =>
        collection.notes[card.noteId]?.source.path ?? "";
    const eligible = new Set<string>();
    const dueById = new Map<string, number | null>();
    for (const card of activeCards) {
        const dueAt = cardDueAt(card);
        dueById.set(card.id, dueAt);
        const aheadDays = Math.max(
            0,
            options.aheadDays ?? 0,
            options.aheadDaysForDeck?.(card.deckPath) ?? 0,
        );
        const horizon = now + aheadDays * DAY;
        const insideBaseline = !options.baselineCardIds || options.baselineCardIds.has(card.id);
        if (insideBaseline && (card.queue === "new" || (dueAt !== null && dueAt <= horizon))) {
            eligible.add(card.id);
        }
    }

    const dependencyBoost = new Map<string, number>();
    const unlocks = new Map<string, Set<string>>();
    const blockedBy = new Map<string, Set<string>>();
    const threshold = Math.max(0.7, Math.min(0.99, options.dependencyRetentionThreshold ?? 0.88));
    const cardsByPath = new Map<string, CollectionCard[]>();
    for (const card of activeCards) {
        const path = notePath(card);
        if (path) cardsByPath.set(path, [...(cardsByPath.get(path) ?? []), card]);
    }
    for (const edge of options.dependencyEdges ?? []) {
        const dependents = cardsByPath.get(edge.dependentPath) ?? [];
        const prerequisites = cardsByPath.get(edge.prerequisitePath) ?? [];
        const dependentReady = dependents.some((card) => eligible.has(card.id));
        if (!dependentReady || prerequisites.length === 0) continue;
        const weakPrerequisites = prerequisites.filter((card) => {
            const dueAt = dueById.get(card.id) ?? null;
            return (
                card.queue === "new" ||
                (dueAt !== null && dueAt <= now) ||
                card.lapses >= 2 ||
                retrievability(card, now) < threshold
            );
        });
        if (!weakPrerequisites.length) continue;
        for (const card of weakPrerequisites) {
            eligible.add(card.id);
            const risk = 1 - retrievability(card, now);
            dependencyBoost.set(card.id, (dependencyBoost.get(card.id) ?? 0) + 420 + risk * 180);
            const paths = unlocks.get(card.id) ?? new Set<string>();
            paths.add(edge.dependentPath);
            unlocks.set(card.id, paths);
        }
        for (const card of dependents) {
            if (!eligible.has(card.id)) continue;
            const paths = blockedBy.get(card.id) ?? new Set<string>();
            paths.add(edge.prerequisitePath);
            blockedBy.set(card.id, paths);
        }
    }

    const cards = activeCards
        .filter((card) => eligible.has(card.id))
        .map((card): PlannedCard => {
            const dueAt = cardDueAt(card);
            const priority = options.priorityForDeck?.(card.deckPath) ?? 0;
            const overdueDays = dueAt === null ? 0 : Math.max(0, (now - dueAt) / DAY);
            const memoryRisk = 1 - retrievability(card, now);
            const learningBoost =
                card.queue === "learning" || card.queue === "relearning" ? 500 : 0;
            const graphBoost = dependencyBoost.get(card.id) ?? 0;
            const dependencyPenalty = (blockedBy.get(card.id)?.size ?? 0) * 90;
            const score =
                priority * 1000 +
                learningBoost +
                graphBoost -
                dependencyPenalty +
                (options.intelligentBacklog === false ? 0 : overdueDays * 12 + memoryRisk * 100) -
                (dueAt !== null && dueAt > now ? (dueAt - now) / DAY : 0);
            return {
                card,
                dueAt,
                priority,
                score,
                dependencyBoost: graphBoost,
                unlocks: [...(unlocks.get(card.id) ?? [])],
                blockedBy: [...(blockedBy.get(card.id) ?? [])],
            };
        })
        .sort((left, right) => right.score - left.score || (left.dueAt ?? 0) - (right.dueAt ?? 0));
    const availableCards = cards.length;
    const maxCards = options.minutes
        ? Math.max(1, Math.floor((options.minutes * 60_000) / responseMs))
        : availableCards;
    const selected = cards.slice(0, maxCards);
    const dueCards = selected.filter(
        ({ card, dueAt }) => card.queue !== "new" && dueAt !== null && dueAt <= now,
    ).length;
    const newCards = selected.filter(({ card }) => card.queue === "new").length;
    const aheadCards = selected.filter(({ dueAt }) => dueAt !== null && dueAt > now).length;
    const backlogCards = selected.filter(
        ({ card, dueAt }) => card.queue !== "new" && dueAt !== null && dueAt < now - DAY,
    ).length;
    const estimatedMinutes = Math.ceil((selected.length * responseMs) / 60_000);
    return {
        cards: selected,
        plan: {
            availableCards,
            selectedCards: selected.length,
            dueCards,
            newCards,
            backlogCards,
            aheadCards,
            estimatedMinutes,
            averageResponseMs: responseMs,
            finishAt: now + selected.length * responseMs,
        },
    };
}

/** Keeps the exact legacy Card objects selected by the file-native plan. */
export function applyStableIdPlanToQueue(
    deckTree: Deck,
    stableIds: ReadonlySet<string> | readonly string[],
): Deck {
    const ordered = Array.isArray(stableIds) ? stableIds : [...stableIds];
    const rank = new Map(ordered.map((id, index) => [id, index]));
    const filtered = deckTree.copyWithRepItemFilter(
        (item) => item instanceof Card && item.stableId !== null && rank.has(item.stableId),
    );
    const sortDeck = (deck: Deck): void => {
        const score = (card: Card) => rank.get(card.stableId ?? "") ?? Number.MAX_SAFE_INTEGER;
        deck.dueRepItems.sort((left, right) => score(left) - score(right));
        deck.newRepItems.sort((left, right) => score(left) - score(right));
        for (const child of deck.subdecks) sortDeck(child);
        const firstRank = (candidate: Deck) =>
            Math.min(
                Number.MAX_SAFE_INTEGER,
                ...candidate
                    .getFlattenedRepItemArray(RepItemState.AnyItem, true)
                    .filter((item): item is Card => item instanceof Card)
                    .map(score),
            );
        deck.subdecks.sort((left, right) => firstRank(left) - firstRank(right));
    };
    sortDeck(filtered);
    return filtered;
}

/** Sorts due cards by urgency and applies a global time budget without mutating the shared tree. */
export function applyTimeBudgetToQueue(
    deckTree: Deck,
    minutes: number,
    averageResponseMs: number,
): Deck {
    if (minutes <= 0) return deckTree;
    const maxCards = Math.max(1, Math.floor((minutes * 60_000) / Math.max(500, averageResponseMs)));
    const all = [...new Set(deckTree.getFlattenedRepItemArray(RepItemState.AnyItem, true))]
        .filter((item): item is Card => item instanceof Card)
        .sort((left, right) => {
            if (left.isNew !== right.isNew) return left.isNew ? 1 : -1;
            const leftDue = left.scheduleInfo?.dueDateAsUnix ?? Number.MAX_SAFE_INTEGER;
            const rightDue = right.scheduleInfo?.dueDateAsUnix ?? Number.MAX_SAFE_INTEGER;
            return leftDue - rightDue;
        });
    const selected = new Set(all.slice(0, maxCards));
    return deckTree.copyWithRepItemFilter((item) => item instanceof Card && selected.has(item));
}
