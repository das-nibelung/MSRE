import { TFile } from "obsidian";

import { DeckOptionsDefinition } from "src/data/collection/collection-types";
import { OsrCore } from "src/data/core";
import { Card } from "src/data/data-structures/card/card";
import { Deck, DeckTreeFilter } from "src/data/data-structures/deck/deck";
import {
    DeckOrder,
    DeckTreeIterator,
    IDeckTreeIterator,
    IIteratorOrder,
    RepItemOrder,
} from "src/data/data-structures/deck/deck-tree-iterator";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { SRSettings } from "src/data/settings";
import SRPlugin from "src/main";
import { Note } from "src/note/note";
import { RepItemState } from "src/scheduling/algorithms/base/repetition-item";
import { SRAlgorithm } from "src/scheduling/algorithms/base/sr-algorithm";
import {
    FlashcardReviewMode,
    FlashcardReviewSequencer,
    IFlashcardReviewSequencer,
} from "src/scheduling/flashcard-review-sequencer";
import { globalRandomNumberProvider } from "src/utils/numbers";

function stripRootPath(path: string[], rootPath: string[]): string {
    const startsAtRoot = rootPath.every((segment, index) => path[index] === segment);
    return (startsAtRoot ? path.slice(rootPath.length) : path).join("/");
}

function shuffleCards<T>(cards: T[]): T[] {
    const result = [...cards];
    for (let index = result.length - 1; index > 0; index--) {
        const other = globalRandomNumberProvider.getInteger(0, index);
        [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
}

export interface CustomStudyOptions {
    targetDeckPath: string[];
    scope: "due" | "new" | "all";
    limit: number;
    order: "due-first" | "random";
}

/** Creates a temporary, deck-scoped queue without changing card schedules. */
export function applyCustomStudyOptionsToQueue(deckTree: Deck, options: CustomStudyOptions): Deck {
    const target = deckTree.getDeck(new TopicPath([...options.targetDeckPath]));
    if (!target) return deckTree.copyWithRepItemFilter(() => false);

    const state =
        options.scope === "new"
            ? RepItemState.NewItem
            : options.scope === "due"
              ? RepItemState.DueItem
              : RepItemState.AnyItem;
    let candidates = [...new Set(target.getFlattenedRepItemArray(state, true))];
    if (options.scope === "all" && options.order === "due-first") {
        candidates = [
            ...new Set(target.getFlattenedRepItemArray(RepItemState.DueItem, true)),
            ...new Set(target.getFlattenedRepItemArray(RepItemState.NewItem, true)),
        ];
    }
    if (options.order === "random") candidates = shuffleCards(candidates);
    const selected = new Set(candidates.slice(0, Math.max(1, options.limit)));
    const filtered = deckTree.copyWithRepItemFilter((item) => selected.has(item));
    if (options.order === "random") {
        const randomize = (deck: Deck): void => {
            deck.newRepItems = shuffleCards(deck.newRepItems);
            deck.dueRepItems = shuffleCards(deck.dueRepItems);
            for (const child of deck.subdecks) randomize(child);
        };
        randomize(filtered);
    }
    filtered.pruneEmptySubdecks();
    return filtered;
}

/** Applies Anki-style per-deck daily limits without mutating the vault-wide deck tree. */
export function applyDeckOptionsToQueue(
    deckTree: Deck,
    rootTag: string,
    getOptions: (deckPath: string) => DeckOptionsDefinition,
): Deck {
    const limited = deckTree.clone();
    const rootPath = rootTag.replace(/^#/, "").split("/").filter(Boolean);
    const visit = (deck: Deck): void => {
        const deckPath = stripRootPath(deck.getTopicPath().path, rootPath);
        const options = getOptions(deckPath);
        const newCards =
            options.newCardOrder === "random" ? shuffleCards(deck.newRepItems) : deck.newRepItems;
        deck.newRepItems = newCards.slice(0, options.newCardsPerDay);
        deck.dueRepItems = deck.dueRepItems.slice(0, options.reviewsPerDay);
        for (const child of deck.subdecks) visit(child);
    };
    visit(limited);
    return limited;
}

/** Removes cards that are persistently suspended or buried from every deck copy. */
export function applyCardLifecycleToQueue(
    deckTree: Deck,
    isReviewable: (legacyStableId: string | null) => boolean,
): Deck {
    const filtered = deckTree.copyWithRepItemFilter((item) =>
        item instanceof Card ? isReviewable(item.stableId) : true,
    );
    filtered.pruneEmptySubdecks();
    return filtered;
}

/** Builds a temporary deck tree containing exactly the cards selected in the browser. */
export function applyStableIdSelectionToQueue(deckTree: Deck, stableIds: Set<string>): Deck {
    const filtered = deckTree.copyWithRepItemFilter(
        (item) => item instanceof Card && item.stableId !== null && stableIds.has(item.stableId),
    );
    filtered.pruneEmptySubdecks();
    return filtered;
}

export class ReviewQueueLoader {
    private plugin: SRPlugin;
    private osrCore: OsrCore;
    private singleNote: TFile | null = null;
    private reviewMode: FlashcardReviewMode;
    private customStudyOptions: CustomStudyOptions | null = null;
    private selectedStableIds: Set<string> | null = null;

    constructor(
        plugin: SRPlugin,
        osrCore: OsrCore,
        singleNote: TFile | null,
        reviewMode: FlashcardReviewMode,
    ) {
        this.osrCore = osrCore;
        this.singleNote = singleNote;
        this.reviewMode = reviewMode;
        this.plugin = plugin;
    }

    public getSingleNote(): TFile | null {
        return this.singleNote;
    }

    public getReviewMode(): FlashcardReviewMode {
        return this.reviewMode;
    }

    setReviewMode(reviewMode: FlashcardReviewMode) {
        this.reviewMode = reviewMode;
    }

    setCustomStudyOptions(options: CustomStudyOptions | null): void {
        this.customStudyOptions = options;
    }

    setSelectedStableIds(stableIds: Iterable<string> | null): void {
        this.selectedStableIds = stableIds === null ? null : new Set(stableIds);
    }

    public async loadReviewQueue(): Promise<IFlashcardReviewSequencer> {
        if (this.plugin === null || this.plugin.dataManager.osrCore === null)
            throw new Error("SR plugin or OSR app core not initialized!!!");

        if (!this.plugin.dataManager.syncLock) {
            await this.plugin.dataManager.sync();
        }
        const collection = this.plugin.dataManager.collectionStore;
        await collection.restoreExpiredBuriedCards();

        let deckTree: Deck;
        let remainingDeckTree: Deck;

        if (this.singleNote) {
            const singleNoteDeckData = await this.getPreparedDecksForSingleNoteReview(
                this.singleNote,
                this.reviewMode,
            );

            deckTree = singleNoteDeckData.deckTree;
            remainingDeckTree = singleNoteDeckData.remainingDeckTree;
        } else {
            deckTree = this.osrCore.reviewableDeckTree;
            remainingDeckTree =
                this.reviewMode === FlashcardReviewMode.Cram
                    ? this.osrCore.reviewableDeckTree
                    : this.osrCore.remainingDeckTree;
        }

        deckTree = applyCardLifecycleToQueue(deckTree, (stableId) =>
            collection.isLegacyCardReviewable(stableId),
        );
        remainingDeckTree = applyCardLifecycleToQueue(remainingDeckTree, (stableId) =>
            collection.isLegacyCardReviewable(stableId),
        );

        if (this.customStudyOptions) {
            deckTree = applyCustomStudyOptionsToQueue(deckTree, this.customStudyOptions);
            remainingDeckTree = applyCustomStudyOptionsToQueue(
                remainingDeckTree,
                this.customStudyOptions,
            );
        }

        if (this.selectedStableIds) {
            deckTree = applyStableIdSelectionToQueue(deckTree, this.selectedStableIds);
            remainingDeckTree = applyStableIdSelectionToQueue(
                remainingDeckTree,
                this.selectedStableIds,
            );
        }

        if (
            this.reviewMode === FlashcardReviewMode.Review &&
            !this.singleNote &&
            !this.customStudyOptions &&
            !this.selectedStableIds
        ) {
            const rootTag = this.plugin.dataManager.data.settings.flashcardTags[0] ?? "#flashcards";
            remainingDeckTree = applyDeckOptionsToQueue(remainingDeckTree, rootTag, (deckPath) =>
                this.plugin.dataManager.collectionStore.getDeckOptionsForPath(deckPath),
            );
        }

        const reviewSequencerData = this.getPreparedReviewSequencer(
            deckTree,
            remainingDeckTree,
            this.reviewMode,
        );

        return reviewSequencerData.reviewSequencer;
    }

    public getPreparedReviewSequencer(
        fullDeckTree: Deck,
        remainingDeckTree: Deck,
        reviewMode: FlashcardReviewMode,
    ): { reviewSequencer: IFlashcardReviewSequencer; mode: FlashcardReviewMode } {
        const deckIterator: IDeckTreeIterator = this.createDeckTreeIterator(
            this.plugin.dataManager.data.settings,
        );

        const reviewSequencer: IFlashcardReviewSequencer = new FlashcardReviewSequencer(
            reviewMode,
            deckIterator,
            this.plugin.dataManager.data.settings,
            SRAlgorithm.getInstance(),
            this.plugin.dataManager.osrCore.questionPostponementList,
            this.plugin.dataManager.osrCore.dueDateFlashcardHistogram,
            (card) => ({
                desiredRetention: this.getOptionsForCard(card).desiredRetention,
            }),
        );

        reviewSequencer.setDeckTree(fullDeckTree, remainingDeckTree);
        return { reviewSequencer, mode: reviewMode };
    }

    public async getPreparedDecksForSingleNoteReview(
        file: TFile,
        mode: FlashcardReviewMode,
    ): Promise<{ deckTree: Deck; remainingDeckTree: Deck; mode: FlashcardReviewMode }> {
        const note: Note | null = await this.plugin.dataManager.loadNote(file);

        const deckTree = new Deck("root", null);
        if (note) {
            note.appendCardsToDeck(deckTree);
        }
        const remainingDeckTree = DeckTreeFilter.filterForRemainingRepItems(
            this.plugin.dataManager.osrCore.questionPostponementList,
            deckTree,
            mode,
        );

        return { deckTree, remainingDeckTree, mode };
    }

    private createDeckTreeIterator(settings: SRSettings): IDeckTreeIterator {
        let cardOrder: RepItemOrder =
            RepItemOrder[settings.flashcardCardOrder as keyof typeof RepItemOrder];
        if (cardOrder === undefined) cardOrder = RepItemOrder.DueFirstSequential;
        let deckOrder: DeckOrder = DeckOrder[settings.flashcardDeckOrder as keyof typeof DeckOrder];
        if (deckOrder === undefined) deckOrder = DeckOrder.PrevDeckComplete_Sequential;

        const iteratorOrder: IIteratorOrder = {
            deckOrder,
            repItemOrder: cardOrder,
        };
        return new DeckTreeIterator(iteratorOrder, null);
    }

    private getOptionsForCard(card: Card): DeckOptionsDefinition {
        const rootTag = this.plugin.dataManager.data.settings.flashcardTags[0] ?? "#flashcards";
        const rootPath = rootTag.replace(/^#/, "").split("/").filter(Boolean);
        const topicPath = card.question.topicPathList.list[0]?.path ?? [];
        return this.plugin.dataManager.collectionStore.getDeckOptionsForPath(
            stripRootPath(topicPath, rootPath),
        );
    }
}
