import { now } from "moment";
import { App, MarkdownView, Notice, Platform } from "obsidian";

import { CardFlag, LegacyCardInput } from "src/data/collection/collection-types";
import { DataManager } from "src/data/data-manager";
import { DataStore } from "src/data/data-store/base/data-store";
import { Card } from "src/data/data-structures/card/card";
import { Question } from "src/data/data-structures/card/questions/question";
import { Deck } from "src/data/data-structures/deck/deck";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { Note } from "src/note/note";
import { RepItemScheduleInfo } from "src/scheduling/algorithms/base/rep-item-schedule-info";
import { RepItemState, ReviewResponse } from "src/scheduling/algorithms/base/repetition-item";
import {
    DeckStats,
    FlashcardReviewMode,
    IFlashcardReviewSequencer,
} from "src/scheduling/flashcard-review-sequencer";
import { CardContainer } from "src/ui/obsidian-ui-components/content-container/card-container/card-container";
import CardInfoNotice from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar-buttons/card-info-notice";
import { DeckContainer } from "src/ui/obsidian-ui-components/content-container/deck-container/deck-container";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";
import { CustomStudyModal } from "src/ui/obsidian-ui-components/modals/custom-study-modal";
import { FlashcardEditModal } from "src/ui/obsidian-ui-components/modals/edit-modal";
import { PostponeModal } from "src/ui/obsidian-ui-components/modals/postpone-modal";
import { CustomStudyOptions, ReviewQueueLoader } from "src/ui/review-queue-loader";
import { UIManager, UIState } from "src/ui/ui-manager";
import EmulatedPlatform from "src/utils/platform-detector";

export enum ContentState {
    Deck,
    CardFront,
    CardBack,
    Closed,
}

export enum CardState {
    Front,
    Back,
    Closed,
}

export interface CardData {
    currentCard: Card | null;
    currentCardState: CardState;
}

export interface DeckData {
    chosenDeck: Deck;
    currentDeck: Deck | null;
    previousDeck: Deck | null;
    currentDeckTotalCardsInQueue: number;
    currentDeckStats: DeckStats | null;
    previousDeckStats: DeckStats | null;
    chosenDeckStats: DeckStats;
}

export interface SessionData {
    cardData: CardData;
    deckData: DeckData;

    totalDecksInSession: number;
    totalCardsInSession: number;

    currentQuestion: Question;
    currentNote: Note;
}

export interface SessionSummary {
    reviewed: number;
    again: number;
    hard: number;
    good: number;
    easy: number;
    durationMs: number;
}

interface ReviewUndoSnapshot {
    card: Card;
    previousSchedule: RepItemScheduleInfo | null;
    chosenDeckPath: TopicPath;
    response: ReviewResponse;
    reviewLogId: string | null;
}

// TODO: Refactor/integrate this code with the backend

/**
 * Manages the content of the deck and flashcard views, by determining their behavior.
 *
 * @method open - Opens the content manager, loading the review queue and initializing the deck and flashcard views.
 * @method close - Closes the content manager, shutting down the deck and flashcard views.
 */
export default class ContentManager {
    private app: App;
    private plugin: SRPlugin;
    private uiManager: UIManager;
    private dataManager: DataManager;
    private reviewSequencer: IFlashcardReviewSequencer | null = null;
    private settings: SRSettings;
    private reviewMode: FlashcardReviewMode;
    private deckContainer: DeckContainer;
    private cardContainer: CardContainer;

    private reviewQueueLoader: ReviewQueueLoader;
    private sessionData: SessionData | null = null;
    private sessionSummary: SessionSummary | null = null;
    private sessionStartedAt = 0;
    private reviewUndoStack: ReviewUndoSnapshot[] = [];
    private isUndoingReview = false;
    private customStudyActive = false;

    private lastPressedOnProcessReview: number = 0;
    private pendingResumeTimeout: number | null = null;

    constructor(
        app: App,
        plugin: SRPlugin,
        reviewQueueLoader: ReviewQueueLoader,
        settings: SRSettings,
        parentEl: HTMLElement,
        closeModal?: () => void,
    ) {
        this.app = app;
        this.plugin = plugin;
        this.reviewQueueLoader = reviewQueueLoader;
        this.settings = settings;
        this.reviewMode = reviewQueueLoader.getReviewMode();

        this.uiManager = this.plugin.uiManager;
        this.dataManager = this.plugin.dataManager;

        const openCardBrowser = async () => {
            // A workspace view is otherwise opened behind the review modal on mobile.
            // Close the modal first so the newly opened card browser is actually visible.
            closeModal?.();
            await this.uiManager.openCardBrowser();
        };

        this.deckContainer = new DeckContainer(
            parentEl,
            this.plugin,
            this._changeReviewMode.bind(this),
            this._startReviewOfDeck.bind(this),
            this._openCustomStudy.bind(this),
            openCardBrowser,
            this.uiManager.openNativeCardCreator.bind(this.uiManager),
            this.uiManager.openNativeDeckCreator.bind(this.uiManager),
            (deckPath: string) => void this.uiManager.openNativeDeckOptions(deckPath),
            this.uiManager.openNativeKnowledgeAreaCreator.bind(this.uiManager),
            closeModal,
        );

        this.cardContainer = new CardContainer(
            this.app,
            this.plugin,
            this.settings,
            parentEl,
            this._deleteCurrentCard.bind(this),
            this._showDecksList.bind(this),
            this._doEditQuestionText.bind(this),
            this._processReview.bind(this),
            this._skipCurrentCard.bind(this),
            this._showAnswer.bind(this),
            this._jumpToCurrentCard.bind(this),
            this._displayCurrentCardInfoNotice.bind(this),
            () => this._buryCurrentCard(),
            () => this._postponeCurrentCard(),
            () => this._suspendCurrentCard(),
            (flag) => this._setCurrentCardFlag(flag),
            () => this._undoLastReview(),
            closeModal,
        );
    }

    public close() {
        this._clearPendingResumeTimeout();
        this.uiManager.setSRViewInFocus(false);
        this.deckContainer.closeList();
        this.cardContainer.closeSession();
        this.uiManager.setUIState(UIState.Closed);
    }

    public async open() {
        // Prepare a review queue to display
        this.reviewSequencer = await this.reviewQueueLoader.loadReviewQueue();

        // Determine if the card view should be opened immediately
        const subdecksWithCardsInQueue: Deck[] = this.reviewSequencer.getSubDecksWithCardsInQueue(
            this.reviewSequencer.originalDeckTree,
        );

        let openImmediately: boolean = false;
        let deckWithCards: Deck | null = null;

        // Loop through all decks and determine if any have cards in queue
        for (const subdeck of subdecksWithCardsInQueue) {
            const subdeckStats = this.reviewSequencer.getDeckStats(subdeck.getTopicPath());

            if (
                openImmediately &&
                (subdeckStats.cardsInQueueOfThisDeckCount ||
                    this.reviewMode === FlashcardReviewMode.Cram)
            ) {
                openImmediately = false;
                break;
            }

            if (
                subdeckStats.cardsInQueueOfThisDeckCount ||
                this.reviewMode === FlashcardReviewMode.Cram
            ) {
                openImmediately = true;
                deckWithCards = subdeck;
            }
        }

        if (openImmediately && deckWithCards !== null) {
            await this._reviewDeck(deckWithCards);
        } else {
            await this._showDecksList();
        }
    }

    // MARK: Content Manager

    private async _showDecksList(reloadReviewQueue: boolean = false): Promise<void> {
        this._clearPendingResumeTimeout();
        if (this.customStudyActive) {
            this.customStudyActive = false;
            this.reviewMode = FlashcardReviewMode.Review;
            this.reviewQueueLoader.setReviewMode(FlashcardReviewMode.Review);
            this.reviewQueueLoader.setCustomStudyOptions(null);
            reloadReviewQueue = true;
        }
        if (reloadReviewQueue) {
            this.reviewSequencer = await this.reviewQueueLoader.loadReviewQueue();
        }
        if (this.reviewSequencer === null) return;
        this.cardContainer.closeSession();
        this.uiManager.setUIState(UIState.DeckList);
        this.deckContainer.showList(this.reviewSequencer, this.settings, this.reviewMode);
    }

    private async _reviewDeck(deck: Deck): Promise<void> {
        this.deckContainer.closeList();
        this.sessionStartedAt = Date.now();
        this.sessionSummary = {
            reviewed: 0,
            again: 0,
            hard: 0,
            good: 0,
            easy: 0,
            durationMs: 0,
        };
        this.reviewUndoStack = [];
        this.cardContainer.setUndoAvailable(false);
        this.sessionData = this._getNewSessionData(deck);
        if (this.sessionData === null) return;
        this.uiManager.setUIState(UIState.CardFront);
        await this.cardContainer.openSession(this.sessionData, this.settings);
    }

    private async _showNextCard(): Promise<void> {
        if (this.sessionData === null || this.reviewSequencer === null) {
            await this._showDecksList(true);
            return;
        }

        if (!this.reviewSequencer.hasCurrentCard) {
            // TODO: Re-enable pending state, once it is more integrated with the rest of the ui & once data refreshing is better implemented
            // if (this.reviewSequencer.hasPendingCards) {
            //     await this._showPendingState();
            // } else {
            //     await this._showDecksList(true);
            // }
            if (this.sessionSummary !== null && this.sessionSummary.reviewed > 0) {
                this.sessionSummary.durationMs = Date.now() - this.sessionStartedAt;
                this.uiManager.setUIState(UIState.CardFront);
                this.cardContainer.drawCompletionState(this.sessionSummary);
            } else {
                await this._showDecksList(true);
            }
            return;
        }

        if (this.reviewSequencer.currentDeck === null) {
            await this._showDecksList(true);
            return;
        }

        const chosenDeckStats = this.reviewSequencer.getDeckStats(
            this.sessionData.deckData.chosenDeck.getTopicPath(),
        );
        this.sessionData.deckData.chosenDeckStats = chosenDeckStats;

        this.sessionData.deckData.previousDeck = this.sessionData.deckData.currentDeck;
        this.sessionData.deckData.previousDeckStats = this.sessionData.deckData.currentDeckStats;

        this.sessionData.deckData.currentDeck = this.reviewSequencer.currentDeck;

        const currentDeckStats = this.reviewSequencer.getDeckStats(
            this.reviewSequencer.currentDeck.getTopicPath(),
        );
        this.sessionData.deckData.currentDeckStats = currentDeckStats;

        if (this.sessionData.deckData.previousDeck !== this.sessionData.deckData.currentDeck) {
            this.sessionData.deckData.currentDeckTotalCardsInQueue =
                currentDeckStats.cardsInQueueOfThisDeckCount;
        }

        this.sessionData.currentNote = this.reviewSequencer.currentNote;
        this.sessionData.currentQuestion = this.reviewSequencer.currentQuestion;

        this.sessionData.cardData.currentCard = this.reviewSequencer.currentCard;
        this.uiManager.setUIState(UIState.CardFront);
        this.sessionData.cardData.currentCardState = CardState.Front;

        if (
            this.sessionData.cardData.currentCard !== null &&
            this.sessionData.cardData.currentCard !== undefined
        ) {
            await this.cardContainer.drawCardFront(this.sessionData, this.settings);
        } else {
            await this._showDecksList(true);
        }
    }

    private async _showPendingState(): Promise<void> {
        if (this.reviewSequencer === null) return;
        this._clearPendingResumeTimeout();
        const nextPendingDueUnix = this.reviewSequencer.nextPendingDueUnix;
        if (nextPendingDueUnix === null) {
            await this._showDecksList(true);
            return;
        }

        this.uiManager.setUIState(UIState.CardFront);
        this.cardContainer.drawPendingState(nextPendingDueUnix);

        const delayMs = Math.max(0, nextPendingDueUnix - Date.now());
        this.pendingResumeTimeout = window.setTimeout(() => {
            if (this.reviewSequencer === null) return;
            this.reviewSequencer.refreshCurrentDeck();
            void this._showNextCard();
        }, delayMs + 50);
    }

    private _getNewSessionData(deck: Deck): SessionData | null {
        if (this.reviewSequencer === null) return null;
        const chosenDeckStats = this.reviewSequencer.getDeckStats(deck.getTopicPath());
        const totalCardsInSession: number = chosenDeckStats.cardsInQueueCount;
        const totalDecksInSession: number = chosenDeckStats.decksInQueueOfThisDeckCount;
        const currentCardState: CardState = CardState.Front;

        const currentDeckStats =
            this.reviewSequencer.currentDeck === null
                ? null
                : this.reviewSequencer.getDeckStats(
                      this.reviewSequencer.currentDeck.getTopicPath(),
                  );

        return {
            cardData: {
                currentCard: this.reviewSequencer.currentCard,
                currentCardState,
            },
            deckData: {
                chosenDeck: deck,
                currentDeck: this.reviewSequencer.currentDeck,
                previousDeck: null,
                currentDeckTotalCardsInQueue:
                    currentDeckStats === null ? 0 : currentDeckStats.cardsInQueueOfThisDeckCount,
                currentDeckStats: currentDeckStats,
                previousDeckStats: null,
                chosenDeckStats: chosenDeckStats,
            },
            totalCardsInSession,
            totalDecksInSession,
            currentQuestion: this.reviewSequencer.currentQuestion,
            currentNote: this.reviewSequencer.currentNote,
        };
    }

    // MARK: Card button handlers

    public _deleteCurrentCard() {
        if (
            this.sessionData === null ||
            this.reviewSequencer === null ||
            this.dataManager.data === null
        )
            return;

        const timeNow = now();
        if (
            this.lastPressedOnProcessReview &&
            timeNow - this.lastPressedOnProcessReview <
                this.dataManager.data.settings.reviewButtonDelay
        ) {
            return;
        }
        this.lastPressedOnProcessReview = timeNow;

        new ConfirmationModal(
            this.app,
            t("DELETE_CARD"),
            t("DELETE_CARD_CONFIRMATION"),
            t("CANCEL"),
            async () => {
                if (this.sessionData === null || this.reviewSequencer === null) return;
                const currentCard = this.sessionData.cardData.currentCard;
                const sourcePath =
                    currentCard?.storageInfo?.notePath ?? this.sessionData.currentNote.filePath;
                const questionId =
                    currentCard?.storageInfo?.questionId ??
                    this.sessionData.currentQuestion.questionText.obsidianBlockId ??
                    null;
                await this.reviewSequencer.deleteCurrentCardFromNote();
                await this.dataManager.collectionStore.deleteNoteBySource(sourcePath, questionId);
                await this._showNextCard();
            },
        ).open();
    }

    public async _showAnswer() {
        if (this.sessionData === null) return;

        const timeNow = now();
        if (
            this.lastPressedOnProcessReview &&
            timeNow - this.lastPressedOnProcessReview <
                this.dataManager.data.settings.reviewButtonDelay
        ) {
            return;
        }
        this.lastPressedOnProcessReview = timeNow;

        this.uiManager.setUIState(UIState.CardBack);
        this.sessionData.cardData.currentCardState = CardState.Back;

        await this.cardContainer.drawBack(
            this.sessionData,
            this.reviewMode,
            this.settings,
            this._determineButtonSchedule.bind(this),
        );
    }

    private async _doEditQuestionText(): Promise<void> {
        if (this.reviewSequencer === null) return;
        const currentCard: Card | null = this.reviewSequencer.currentCard;
        const currentQ: Question = this.reviewSequencer.currentQuestion;

        // Just the question/answer text; without any preceding topic tag
        const textPrompt = currentQ.questionText.actualQuestion;
        const currentUIState = this.uiManager.uiState;
        this.uiManager.setUIState(UIState.EditModal);
        const editModal = FlashcardEditModal.Prompt(
            this.app,
            this.settings,
            currentCard,
            textPrompt,
            currentQ.questionText.textDirection,
        );
        await editModal
            .then(async (modifiedCardText) => {
                if (this.reviewSequencer === null) return;
                await this.reviewSequencer.updateCurrentQuestionTextAndCards(modifiedCardText);
                this.uiManager.setUIState(currentUIState);

                if (this.sessionData !== null) {
                    if (this.uiManager.uiState === UIState.CardFront) {
                        await this.cardContainer.drawCardFront(this.sessionData, this.settings);
                    }

                    if (this.uiManager.uiState === UIState.CardBack) {
                        await this.cardContainer.drawBack(
                            this.sessionData,
                            this.reviewMode,
                            this.settings,
                            this._determineButtonSchedule.bind(this),
                        );
                    }
                }
            })
            .catch((reason) => console.log(reason));
    }

    public async _jumpToCurrentCard(): Promise<void> {
        if (this.reviewSequencer === null) return;
        const currentQuestion = this.reviewSequencer.currentQuestion;
        if (!currentQuestion) return;

        if (
            !this.settings.openViewInNewTab &&
            !(Platform.isMobile || EmulatedPlatform().isMobile)
        ) {
            new Notice("Note was opened in new tab in the background");
        }

        const file = currentQuestion.note.file.tfile;
        const blockId = currentQuestion.questionText.obsidianBlockId;
        const line = Math.max(0, currentQuestion.lineNo ?? 0);

        if (blockId) {
            await this.app.workspace.openLinkText(`${file.path}#${blockId}`, file.path, false);
            return;
        }

        // If the file is already open in another leaf, open it in the current one to prevent duplicates
        const existingLeaf = this.app.workspace.getLeavesOfType("markdown").find((leaf) => {
            const view = leaf.view as MarkdownView;
            return view.file?.path === file.path;
        });

        if (existingLeaf) {
            await existingLeaf.openFile(file, { eState: { line } });
            this.app.workspace.setActiveLeaf(existingLeaf);
            const markdownView = existingLeaf.view as MarkdownView;
            if (markdownView?.editor) {
                markdownView.editor.setCursor({ line, ch: 0 });
                markdownView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } });
            }
            return;
        }

        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(file, { eState: { line } });

        const markdownView = leaf.view as MarkdownView;
        if (markdownView?.editor) {
            markdownView.editor.setCursor({ line, ch: 0 });
            markdownView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } });
        }
    }

    public async _skipCurrentCard() {
        if (this.reviewSequencer === null) return;
        this.reviewSequencer.skipCurrentCard();
        await this._showNextCard();
    }

    public async _buryCurrentCard() {
        if (this.reviewSequencer === null || this.sessionData === null) return;
        const inputs = this.getCurrentCardInputs(true);
        await this.reviewSequencer.buryCurrentQuestion();
        await this.dataManager.collectionStore.setLegacyCardsState(
            inputs,
            "buried",
            this.nextLocalDayStart(),
        );
        new Notice(inputs.length > 1 ? t("SIBLINGS_BURIED") : t("CARD_BURIED_UNTIL_TOMORROW"));
        await this._showNextCard();
    }

    public async _postponeCurrentCard(): Promise<void> {
        if (this.reviewSequencer === null || this.sessionData === null) return;
        const until = await PostponeModal.choose(this.app);
        if (until === null) return;
        const inputs = this.getCurrentCardInputs(false);
        await this.dataManager.collectionStore.setLegacyCardsState(inputs, "buried", until);
        this.reviewSequencer.skipCurrentCard();
        new Notice(`Card postponed until ${new Date(until).toLocaleString()}.`);
        await this._showNextCard();
    }

    public async _suspendCurrentCard(): Promise<void> {
        if (this.reviewSequencer === null || this.sessionData === null) return;
        const inputs = this.getCurrentCardInputs(false);
        if (inputs.length === 0) return;
        await this.dataManager.collectionStore.setLegacyCardsState(inputs, "suspended");
        this.reviewSequencer.skipCurrentCard();
        new Notice(t("CARD_SUSPENDED"));
        await this._showNextCard();
    }

    public async _setCurrentCardFlag(flag: CardFlag): Promise<void> {
        const inputs = this.getCurrentCardInputs(false);
        if (inputs.length === 0) return;
        await this.dataManager.collectionStore.setLegacyCardsFlag(inputs, flag);
        new Notice(flag === 0 ? t("FLAGS_CLEARED") : t("FLAG_SET"));
    }

    private getCurrentCardInputs(includeSiblings: boolean): LegacyCardInput[] {
        const current = this.sessionData?.cardData.currentCard;
        if (!current) return [];
        const cards = includeSiblings ? current.question.cards : [current];
        return cards.map((card) => {
            const stored = this.dataManager.collectionStore.getCardByLegacyStableId(card.stableId);
            return {
                sourcePath:
                    card.storageInfo?.notePath ?? this.sessionData?.currentNote.filePath ?? "",
                questionId: card.storageInfo?.questionId ?? null,
                ordinal: card.cardIdx,
                deckPath: stored?.deckPath ?? "",
                front: card.front,
                back: card.back,
            };
        });
    }

    private nextLocalDayStart(): number {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow.getTime();
    }

    private _displayCurrentCardInfoNotice() {
        if (this.sessionData === null) return;
        new CardInfoNotice(
            this.sessionData.cardData.currentCard.scheduleInfo,
            this.sessionData.currentNote.file.path,
        );
    }

    public async _processReview(response: ReviewResponse): Promise<void> {
        if (this.reviewSequencer === null || this.sessionData === null) return;
        const timeNow = now();
        if (
            timeNow - this.lastPressedOnProcessReview <
            this.dataManager.data.settings.reviewButtonDelay
        ) {
            return;
        }
        this.lastPressedOnProcessReview = timeNow;

        const currentCard = this.reviewSequencer.currentCard;
        const snapshot: ReviewUndoSnapshot | null =
            response === ReviewResponse.Reset || currentCard === null
                ? null
                : {
                      card: currentCard,
                      previousSchedule: currentCard.scheduleInfo,
                      chosenDeckPath: this.sessionData.deckData.chosenDeck.getTopicPath().clone(),
                      response,
                      reviewLogId: null,
                  };

        const previousSchedule = currentCard?.scheduleInfo?.serializeSchedule() ?? null;

        await this.reviewSequencer.processReview(response);
        if (snapshot !== null) {
            try {
                const deckPath = snapshot.chosenDeckPath.path.join("/");
                const deckOptions =
                    this.dataManager.collectionStore.getDeckOptionsForPath(deckPath);
                const area = this.dataManager.data.knowledgeAreas.find((candidate) =>
                    candidate.deckPaths.some(
                        (path) => deckPath === path || deckPath.startsWith(`${path}/`),
                    ),
                );
                snapshot.reviewLogId = await this.dataManager.collectionStore.recordReview({
                    sourcePath:
                        currentCard?.storageInfo?.notePath ?? this.sessionData.currentNote.filePath,
                    questionId:
                        currentCard?.storageInfo?.questionId ??
                        this.sessionData.currentQuestion.questionText.obsidianBlockId ??
                        null,
                    ordinal: currentCard?.cardIdx ?? 0,
                    deckPath,
                    front: currentCard?.front ?? "",
                    back: currentCard?.back ?? "",
                    rating: this.reviewResponseToRating(response),
                    mode: this.reviewMode === FlashcardReviewMode.Cram ? "cram" : "review",
                    previousSchedule,
                    nextSchedule: currentCard?.scheduleInfo?.serializeSchedule() ?? null,
                    leechThreshold: area?.scheduling?.leechThreshold ?? deckOptions.leechThreshold,
                    leechAction: area?.scheduling?.leechAction ?? deckOptions.leechAction,
                });
            } catch (error) {
                console.warn("MSRE: Unable to record review history", error);
            }
            this.reviewUndoStack.push(snapshot);
            this.reviewUndoStack = this.reviewUndoStack.slice(
                -Math.max(1, this.settings.reviewUndoDepth),
            );
            this.recordResponse(response, 1);
            this.cardContainer.setUndoAvailable(true);
        }
        await this._showNextCard();
    }

    private async _undoLastReview(): Promise<void> {
        const snapshot = this.reviewUndoStack[this.reviewUndoStack.length - 1] ?? null;
        if (snapshot === null || this.isUndoingReview) return;
        this.isUndoingReview = true;
        this.cardContainer.setUndoAvailable(false);

        try {
            const previousTotalCards = this.sessionData?.totalCardsInSession;
            const previousTotalDecks = this.sessionData?.totalDecksInSession;
            snapshot.card.scheduleInfo = snapshot.previousSchedule;
            await DataStore.getInstance().writeSchedule(snapshot.card.question);

            this.reviewSequencer = await this.reviewQueueLoader.loadReviewQueue();
            const stableId = snapshot.card.stableId;
            const restoredCard = this.reviewSequencer.originalDeckTree
                .getFlattenedRepItemArray(RepItemState.AnyItem, true)
                .find((card) => card.stableId === stableId);
            const restoredCardSelected =
                restoredCard !== undefined &&
                this.reviewSequencer.selectCard(restoredCard, snapshot.chosenDeckPath);
            if (!restoredCardSelected) {
                this.reviewSequencer.setCurrentDeck(snapshot.chosenDeckPath);
            }
            const chosenDeck = this.reviewSequencer.originalDeckTree.getDeck(
                snapshot.chosenDeckPath,
            );
            this.sessionData = this._getNewSessionData(chosenDeck);
            if (this.sessionData === null || !this.reviewSequencer.hasCurrentCard) {
                throw new Error("Restored card is not available in the review queue");
            }

            if (previousTotalCards !== undefined) {
                this.sessionData.totalCardsInSession = previousTotalCards;
            }
            if (previousTotalDecks !== undefined) {
                this.sessionData.totalDecksInSession = previousTotalDecks;
            }

            this.recordResponse(snapshot.response, -1);
            if (snapshot.reviewLogId) {
                await this.dataManager.collectionStore.removeReview(snapshot.reviewLogId);
            }
            this.reviewUndoStack.pop();
            this.uiManager.setUIState(UIState.CardFront);
            this.sessionData.cardData.currentCardState = CardState.Front;
            await this.cardContainer.drawCardFront(this.sessionData, this.settings);
            this.cardContainer.setUndoAvailable(this.reviewUndoStack.length > 0);
            new Notice(t("REVIEW_UNDONE"));
        } catch (error) {
            console.warn("SR: Unable to undo the last review", error);
            this.cardContainer.setUndoAvailable(this.reviewUndoStack.length > 0);
            new Notice(t("UNDO_REVIEW_FAILED"));
        } finally {
            this.isUndoingReview = false;
        }
    }

    private recordResponse(response: ReviewResponse, delta: 1 | -1): void {
        if (this.sessionSummary === null) return;
        this.sessionSummary.reviewed = Math.max(0, this.sessionSummary.reviewed + delta);
        switch (response) {
            case ReviewResponse.Again:
                this.sessionSummary.again = Math.max(0, this.sessionSummary.again + delta);
                break;
            case ReviewResponse.Hard:
                this.sessionSummary.hard = Math.max(0, this.sessionSummary.hard + delta);
                break;
            case ReviewResponse.Good:
                this.sessionSummary.good = Math.max(0, this.sessionSummary.good + delta);
                break;
            case ReviewResponse.Easy:
                this.sessionSummary.easy = Math.max(0, this.sessionSummary.easy + delta);
                break;
            case ReviewResponse.Reset:
                break;
        }
    }

    private reviewResponseToRating(response: ReviewResponse): 1 | 2 | 3 | 4 {
        switch (response) {
            case ReviewResponse.Again:
                return 1;
            case ReviewResponse.Hard:
                return 2;
            case ReviewResponse.Good:
                return 3;
            case ReviewResponse.Easy:
                return 4;
            case ReviewResponse.Reset:
                return 1;
        }
    }

    // MARK: Deck button handlers

    private async _startReviewOfDeck(deck: Deck) {
        if (this.reviewSequencer === null) return;
        this.reviewSequencer.setCurrentDeck(deck.getTopicPath());
        if (this.reviewSequencer.hasCurrentCard) {
            await this._reviewDeck(deck);
        } else {
            await this._showDecksList();
        }
    }

    private _openCustomStudy(deck: Deck): void {
        new CustomStudyModal(this.app, deck.deckName, deck.getTopicPath().path, (options) =>
            this._startCustomStudy(deck, options),
        ).open();
    }

    private async _startCustomStudy(deck: Deck, options: CustomStudyOptions): Promise<void> {
        this.reviewQueueLoader.setReviewMode(FlashcardReviewMode.Cram);
        this.reviewQueueLoader.setCustomStudyOptions(options);
        this.reviewMode = FlashcardReviewMode.Cram;
        try {
            this.reviewSequencer = await this.reviewQueueLoader.loadReviewQueue();
        } finally {
            this.reviewQueueLoader.setCustomStudyOptions(null);
        }
        const filteredDeck = this.reviewSequencer.originalDeckTree.getDeck(deck.getTopicPath());
        if (!filteredDeck) {
            this.reviewMode = FlashcardReviewMode.Review;
            this.reviewQueueLoader.setReviewMode(FlashcardReviewMode.Review);
            new Notice(t("ALL_CAUGHT_UP"));
            await this._showDecksList(true);
            return;
        }
        const stats = this.reviewSequencer.getDeckStats(filteredDeck.getTopicPath());
        if (stats.cardsInQueueCount === 0) {
            this.reviewMode = FlashcardReviewMode.Review;
            this.reviewQueueLoader.setReviewMode(FlashcardReviewMode.Review);
            new Notice(t("ALL_CAUGHT_UP"));
            await this._showDecksList(true);
            return;
        }
        this.customStudyActive = true;
        await this._startReviewOfDeck(filteredDeck);
    }

    private async _changeReviewMode(reviewMode: FlashcardReviewMode) {
        this.reviewQueueLoader.setReviewMode(reviewMode);
        this.reviewMode = reviewMode;
        this.reviewSequencer = await this.reviewQueueLoader.loadReviewQueue();
        this.deckContainer.closeList();
        await this._showDecksList();
    }

    // MARK: Utils

    private _determineButtonSchedule(reviewResponse: ReviewResponse): RepItemScheduleInfo | null {
        if (this.sessionData === null) return null;
        if (this.reviewSequencer === null) return null;
        return this.reviewSequencer.determineCardSchedule(
            reviewResponse,
            this.sessionData.cardData.currentCard,
        );
    }

    private _clearPendingResumeTimeout(): void {
        if (this.pendingResumeTimeout !== null) {
            window.clearTimeout(this.pendingResumeTimeout);
            this.pendingResumeTimeout = null;
        }
    }
}
