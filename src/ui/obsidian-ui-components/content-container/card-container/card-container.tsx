import "src/ui/obsidian-ui-components/content-container/card-container/card-container.css";
import moment from "moment";
import { App, ButtonComponent, Platform, setIcon } from "obsidian";

import { CardType } from "src/data/data-structures/card/questions/question";
import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import type SRPlugin from "src/main";
import { RepItemScheduleInfo } from "src/scheduling/algorithms/base/rep-item-schedule-info";
import { ReviewResponse } from "src/scheduling/algorithms/base/repetition-item";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import ContextSectionComponent from "src/ui/obsidian-ui-components/content-container/card-container/context-section/context-section";
import ResponseSectionComponent from "src/ui/obsidian-ui-components/content-container/card-container/response-section/response-section";
import CardToolbarComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar";
import {
    CardState,
    SessionData,
    SessionSummary,
} from "src/ui/obsidian-ui-components/content-container/content-manager";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";
import { escapeHtml } from "src/utils/escape-html";
import EmulatedPlatform from "src/utils/platform-detector";
import { RenderMarkdownWrapper } from "src/utils/renderers";

// TODO: Refactor cloze rendering into the renderers file
export class CardContainer {
    private app: App;
    private plugin: SRPlugin;
    private cardState: CardState;

    private view: HTMLDivElement;

    private toolbar: CardToolbarComponent;
    private contextSection: ContextSectionComponent | null = null;

    private scrollWrapper: HTMLDivElement;
    private content: HTMLDivElement;
    private pendingClock: HTMLDivElement | null = null;
    private pendingResumeTimeout: number | null = null;

    private response: ResponseSectionComponent;

    private clozeInputs: NodeListOf<HTMLInputElement> | null = null;
    private clozeAnswers: NodeListOf<Element> | null = null;

    private processReviewHandler: (response: ReviewResponse) => Promise<void>;
    private skipCardHandler: () => void;
    private showAnswerHandler: () => void | Promise<void>;
    private jumpToCardHandler: () => Promise<void>;
    private backToDeckHandler: () => Promise<void>;
    private undoLastReviewHandler: () => Promise<void>;
    private gestureStart: {
        pointerId: number;
        x: number;
        y: number;
        lastX: number;
        lastTime: number;
        velocityX: number;
        axis: "pending" | "horizontal" | "vertical";
        card: HTMLElement;
    } | null = null;
    private suppressNextCardClick = false;
    private workspaceTouchStart: {
        identifier: number;
        x: number;
        y: number;
        axis: "pending" | "horizontal" | "vertical";
    } | null = null;
    private workspaceGestureShieldEnabled = false;

    constructor(
        app: App,
        plugin: SRPlugin,
        settings: SRSettings,
        parentEl: HTMLElement,
        deleteCurrentCard: () => void,
        backToDeckHandler: () => Promise<void>,
        editCardHandler: () => void,
        processReviewHandler: (response: ReviewResponse) => Promise<void>,
        skipCardHandler: () => void,
        showAnswerHandler: () => void | Promise<void>,
        jumpToCurrentCardHandler: () => Promise<void>,
        displayCurrentCardInfoNoticeHandler: () => void,
        buryCurrentCardHandler: () => Promise<void>,
        undoLastReviewHandler: () => Promise<void>,
        closeModal?: () => void,
    ) {
        // Init properties
        this.app = app;
        this.plugin = plugin;
        this.cardState = CardState.Closed;
        this.processReviewHandler = processReviewHandler;
        this.skipCardHandler = skipCardHandler;
        this.showAnswerHandler = showAnswerHandler;
        this.jumpToCardHandler = jumpToCurrentCardHandler;
        this.backToDeckHandler = backToDeckHandler;
        this.undoLastReviewHandler = undoLastReviewHandler;

        // Build ui
        this.view = parentEl.createDiv();
        this.view.addClasses(["sr-container", "sr-card-container", "sr-is-hidden"]);

        this.setCustomHotKeyState(settings.useCustomHotkeys);

        this.toolbar = new CardToolbarComponent(
            this.view,
            settings.showDeleteButtonInCardView,
            deleteCurrentCard,
            backToDeckHandler,
            editCardHandler,
            jumpToCurrentCardHandler,
            displayCurrentCardInfoNoticeHandler,
            buryCurrentCardHandler,
            this.skipCardHandler,
            undoLastReviewHandler,
            () => {
                new ConfirmationModal(
                    app,
                    t("DELETE_SCHEDULING_DATA_OF_CURRENT_CARD"),
                    t("CONFIRM_SCHEDULING_DATA_DELETION_OF_CURRENT_CARD"),
                    t("SCHEDULING_DATA_DELETION_IN_PROGRESS_OF_CURRENT_CARD"),
                    async () => {
                        await this.processReviewHandler(ReviewResponse.Reset);
                    },
                ).open();
            },
            closeModal,
        );

        this.scrollWrapper = this.view.createDiv();
        this.scrollWrapper.addClass("sr-scroll-wrapper");

        this.content = this.scrollWrapper.createDiv();
        this.content.addClass("sr-content");
        this.content.addEventListener("click", (event) => {
            this.revealAnswerFromCard(event);
        });
        this.response = new ResponseSectionComponent(
            this.view,
            settings,
            this.showAnswerHandler,
            this.processReviewHandler,
        );
    }

    // #region -> public methods

    /**
     * Shows the FlashcardView if it is hidden
     */
    async openSession(sessionData: SessionData, settings: SRSettings) {
        // Prevents rest of code, from running if this was executed multiple times after one another
        if (!this.view.hasClass("sr-is-hidden")) {
            return;
        }

        await this.drawCardFront(sessionData, settings);

        this.enableWorkspaceGestureShield();
        this.view.removeClass("sr-is-hidden");
        activeDocument.addEventListener("keydown", this._keydownHandler);
    }

    /**
     * Hides the FlashcardView if it is visible
     */
    closeSession() {
        // Prevents the rest of code, from running if this was executed multiple times after one another

        if (this.view.hasClass("sr-is-hidden")) {
            return;
        }
        if (this.pendingResumeTimeout !== null) {
            window.clearTimeout(this.pendingResumeTimeout);
            this.pendingResumeTimeout = null;
        }
        this.cardState = CardState.Closed;
        this.disableWorkspaceGestureShield();
        activeDocument.removeEventListener("keydown", this._keydownHandler);
        this.view.addClass("sr-is-hidden");
    }

    /**
     * Blocks the key input to the FlashcardView
     *
     * @param block
     */
    blockKeyInput(block: boolean) {
        if (block) {
            activeDocument.addEventListener("keydown", this._keydownHandler);
        } else {
            activeDocument.removeEventListener("keydown", this._keydownHandler);
        }
    }

    public async drawCardFront(sessionData: SessionData, settings: SRSettings) {
        this.toolbar.setResetButtonDisabled(true);
        this.content.removeClass("sr-session-complete-screen");
        this.content.removeAttribute("aria-live");
        // Update current deck info
        this.cardState = sessionData.cardData.currentCardState;

        this._updateInfoBar(sessionData, settings.flashcardCardOrder);

        // Update card content
        await this.drawCardFrontContent(sessionData, settings, true);

        // Update response buttons
        this.response.resetResponseButtons();

        // Setup cloze input listeners
        this._setupClozeInputListeners();

        // auto-focus the first cloze input if this card is a cloze card
        if (sessionData.currentQuestion.questionType === CardType.Cloze) {
            const firstInput: HTMLInputElement | null =
                activeDocument.querySelector(".cloze-input");
            if (firstInput) {
                firstInput.focus();
            }
        }
    }

    private drawCardContext(
        sessionData: SessionData,
        settings: SRSettings,
        parentEl: HTMLDivElement = this.content,
    ) {
        if (settings.showContextInCards) {
            this.contextSection = new ContextSectionComponent(parentEl);
            this.contextSection.updateCardContext(
                settings.showContextInCards,
                sessionData.currentQuestion,
                sessionData.currentNote,
            );
        }
    }

    private async drawCardFrontContent(
        sessionData: SessionData,
        settings: SRSettings,
        allowTapToReveal: boolean,
    ) {
        // Update card content
        this.content.empty();

        const cardSurface = this.content.createDiv("sr-study-card");

        // Create context section
        this.drawCardContext(sessionData, settings, cardSurface);

        const cardFace = cardSurface.createDiv({
            cls: "sr-study-card-face sr-study-card-front",
        });

        // Build card content
        const wrapper: RenderMarkdownWrapper = new RenderMarkdownWrapper(
            this.app,
            this.plugin,
            sessionData.currentNote.filePath,
        );

        await wrapper.renderMarkdownWrapper(
            sessionData.cardData.currentCard.front.trimStart(),
            cardFace,
            sessionData.currentQuestion.questionText.textDirection,
            // sessionData.cardData.currentCardState
        );

        const isMobile = Platform.isMobile || EmulatedPlatform().isMobile;
        this.content.toggleClass("sr-can-reveal-answer", allowTapToReveal && isMobile);
        if (allowTapToReveal && isMobile) {
            const hint = cardSurface.createDiv("sr-tap-answer-hint");
            const icon = hint.createSpan("sr-tap-answer-hint-icon");
            setIcon(icon, "mouse-pointer-click");
            hint.createSpan({ text: t("TAP_CARD_TO_SHOW_ANSWER") });
            hint.setAttribute("aria-hidden", "true");
        }
        // Set scroll position back to top
        this.content.scrollTop = 0;
    }

    public drawPendingState(nextPendingDueUnix: number): void {
        this.toolbar.setResetButtonDisabled(true);
        this.cardState = CardState.Front;
        this.content.empty();
        this.content.removeClass("sr-can-reveal-answer");
        this.response.hideAllButtons();
        this.pendingClock = this.content.createDiv({
            cls: "sr-centered",
        });

        const updatePendingClock = () => {
            const startTime = moment();
            const endTime = moment(nextPendingDueUnix);

            // Calculate the difference in milliseconds
            const duration = moment.duration(endTime.diff(startTime));

            const hours = Math.floor(duration.asHours());
            const minutes = duration.minutes();
            const seconds = duration.seconds();

            const formatted = `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

            this.pendingClock?.setText(
                `Waiting for the next FSRS review step. Next card due in ${formatted} (HH:mm:ss).`,
            );
            this.pendingResumeTimeout = window.setTimeout(() => {
                updatePendingClock();
            }, 1000);
        };

        updatePendingClock();
    }

    // #region -> Deck Info

    private setCustomHotKeyState(state: boolean) {
        if (state) {
            if (!this.view.hasClass("sr-custom-hotkeys")) {
                this.view.addClass("sr-custom-hotkeys");
            }
        } else {
            if (this.view.hasClass("sr-custom-hotkeys")) {
                this.view.removeClass("sr-custom-hotkeys");
            }
        }
    }

    private _updateInfoBar(sessionData: SessionData, flashcardCardOrder: string) {
        if (sessionData.deckData.chosenDeck === null || sessionData.deckData.currentDeck === null)
            return;

        this.toolbar.updateInfo(
            sessionData.deckData.chosenDeck,
            sessionData.deckData.currentDeck,
            sessionData.deckData.chosenDeckStats,
            sessionData.deckData.currentDeckStats,
            sessionData.totalCardsInSession,
            sessionData.totalDecksInSession,
            sessionData.deckData.currentDeckTotalCardsInQueue,
            flashcardCardOrder,
        );
    }

    private _setupClozeInputListeners(): void {
        this.clozeInputs = activeDocument.querySelectorAll(".cloze-input");

        this.clozeInputs.forEach((input) => {
            input.addEventListener("keydown", (e: KeyboardEvent) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    (input as HTMLElement).blur();
                    void this.showAnswerHandler();
                }
            });
        });
    }
    private _evaluateClozeAnswers(): void {
        this.clozeAnswers = activeDocument.querySelectorAll(".cloze-answer");

        if (this.clozeInputs !== null && this.clozeAnswers.length === this.clozeInputs.length) {
            for (let i = 0; i < this.clozeAnswers.length; i++) {
                const clozeInput = this.clozeInputs[i];
                const clozeAnswer = this.clozeAnswers[i] as HTMLElement;

                const inputText = clozeInput.value.trim();
                const answerText = clozeAnswer.innerText.trim();

                clozeAnswer.empty();

                const answerElement = clozeAnswer.createSpan({
                    text: escapeHtml(inputText),
                    cls: "cloze-answer",
                });

                answerElement.setCssProps({
                    color: inputText === answerText ? "green" : "red",
                    "text-Decoration": inputText === answerText ? "none" : "line-through",
                });

                if (inputText !== answerText) {
                    const span = clozeAnswer.createSpan({
                        text: escapeHtml(answerText),
                        cls: "cloze-answer-wrong",
                    });
                    span.setCssProps({
                        color: "green",
                        "text-decoration": "none",
                    });
                }
            }
        }
    }

    public async drawBack(
        sessionData: SessionData,
        reviewMode: FlashcardReviewMode,
        settings: SRSettings,
        determineButtonSchedule: (response: ReviewResponse) => RepItemScheduleInfo | null,
    ) {
        this.setCustomHotKeyState(settings.useCustomHotkeys);
        this.content.removeClass("sr-session-complete-screen");
        this.cardState = sessionData.cardData.currentCardState;
        this.content.removeClass("sr-can-reveal-answer");

        this.toolbar.setResetButtonDisabled(false);

        // Show answer text
        let cardSurface: HTMLDivElement;
        if (sessionData.currentQuestion.questionType !== CardType.Cloze) {
            await this.drawCardFrontContent(sessionData, settings, false);
            cardSurface = this.content.querySelector<HTMLDivElement>(".sr-study-card")!;
        } else {
            this.content.empty();
            cardSurface = this.content.createDiv("sr-study-card");
            this.drawCardContext(sessionData, settings, cardSurface);
        }

        cardSurface.addClass("sr-study-card-answer-visible");
        const divider = cardSurface.createDiv("sr-study-card-divider");
        divider.setAttribute("aria-hidden", "true");
        const answerFace = cardSurface.createDiv({
            cls: "sr-study-card-face sr-study-card-back",
        });

        const wrapper: RenderMarkdownWrapper = new RenderMarkdownWrapper(
            this.app,
            this.plugin,
            sessionData.currentNote.filePath,
        );
        await wrapper.renderMarkdownWrapper(
            sessionData.cardData.currentCard.back,
            answerFace,
            sessionData.currentQuestion.questionText.textDirection,
            // sessionData.cardData.currentCardState,
        );

        // Evaluate cloze answers
        this._evaluateClozeAnswers();

        // Show response buttons
        this.response.showRatingButtons(
            reviewMode,
            settings.flashcardAgainText,
            settings.flashcardHardText,
            settings.flashcardGoodText,
            settings.flashcardEasyText,
            settings.showIntervalInReviewButtons,
            determineButtonSchedule,
        );
        // NEW: restore keyboard focus after cloze confirmation
        if (this.plugin.uiManager === null) throw new Error("UI manager not initialized!!!");
        this.plugin.uiManager.setSRViewInFocus(true);
        this.response.againButton.buttonEl.focus();
    }

    public drawCompletionState(summary: SessionSummary): void {
        this.cardState = CardState.Closed;
        this.toolbar.setResetButtonDisabled(true);
        this.content.empty();
        this.content.removeClass("sr-can-reveal-answer");
        this.content.addClass("sr-session-complete-screen");
        this.content.setAttribute("aria-live", "polite");
        this.response.hideAllButtons();

        const icon = this.content.createDiv("sr-session-complete-icon");
        setIcon(icon, "check");
        this.content.createDiv({ cls: "sr-session-complete-eyebrow", text: t("READY_TO_REVIEW") });
        const title = this.content.createEl("h2", {
            text: t("SESSION_COMPLETE"),
            attr: { tabindex: "-1" },
        });
        this.content.createEl("p", { text: t("SESSION_COMPLETE_DESC") });

        const stats = this.content.createDiv("sr-session-summary-grid");
        this.createSummaryStat(stats, summary.reviewed, t("SESSION_REVIEWED"));
        const minutes = Math.max(1, Math.round(summary.durationMs / 60000));
        this.createSummaryStat(
            stats,
            t("MINUTES_SHORT", { count: minutes }),
            t("SESSION_DURATION"),
        );
        this.createSummaryStat(stats, summary.again, t("AGAIN"));
        this.createSummaryStat(stats, summary.hard, t("HARD"));
        this.createSummaryStat(stats, summary.good, t("GOOD"));
        this.createSummaryStat(stats, summary.easy, t("EASY"));

        new ButtonComponent(this.content)
            .setButtonText(t("BACK_TO_DECKS"))
            .setCta()
            .setClass("sr-session-complete-action")
            .onClick(() => void this.backToDeckHandler());
        title.focus();
    }

    public setUndoAvailable(available: boolean): void {
        this.toolbar.setUndoAvailable(available);
    }

    private createSummaryStat(parent: HTMLElement, value: string | number, label: string): void {
        const stat = parent.createDiv("sr-session-summary-stat");
        stat.createEl("strong", { text: String(value) });
        stat.createSpan({ text: label });
    }

    private onGestureStart = (event: PointerEvent): void => {
        if (
            !(Platform.isMobile || EmulatedPlatform().isMobile) ||
            !event.isPrimary ||
            (event.pointerType !== "touch" && event.pointerType !== "pen")
        ) {
            this.gestureStart = null;
            return;
        }
        const target = event.target;
        if (
            !(target instanceof Element) ||
            !this.content.contains(target) ||
            target.closest("a, button, input, textarea, select, [contenteditable='true']") !== null
        ) {
            this.gestureStart = null;
            return;
        }
        event.stopPropagation();
        const card = this.content.querySelector<HTMLElement>(".sr-study-card");
        if (card === null) return;
        this.gestureStart = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            lastX: event.clientX,
            lastTime: event.timeStamp,
            velocityX: 0,
            axis: "pending",
            card,
        };
        this.content.setPointerCapture(event.pointerId);
    };

    private onGestureMove = (event: PointerEvent): void => {
        const start = this.gestureStart;
        if (start === null || start.pointerId !== event.pointerId) return;
        event.stopPropagation();

        const deltaX = event.clientX - start.x;
        const deltaY = event.clientY - start.y;
        if (start.axis === "pending" && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 8) {
            start.axis = Math.abs(deltaX) > Math.abs(deltaY) * 1.08 ? "horizontal" : "vertical";
        }
        if (start.axis !== "horizontal" || this.cardState !== CardState.Back) return;

        event.preventDefault();
        const elapsed = Math.max(1, event.timeStamp - start.lastTime);
        start.velocityX = (event.clientX - start.lastX) / elapsed;
        start.lastX = event.clientX;
        start.lastTime = event.timeStamp;

        const limitedX = Math.max(-180, Math.min(180, deltaX));
        const rotation = limitedX / 55;
        start.card.addClass("is-swiping");
        start.card.toggleClass("is-swiping-left", limitedX < 0);
        start.card.toggleClass("is-swiping-right", limitedX > 0);
        start.card.dataset.swipeLabel = limitedX < 0 ? t("AGAIN") : t("GOOD");
        start.card.setCssProps({
            transform: `translate3d(${limitedX}px, 0, 0) rotate(${rotation}deg)`,
            opacity: String(1 - Math.min(Math.abs(limitedX) / 720, 0.2)),
        });
    };

    private onGestureEnd = (event: PointerEvent): void => {
        const start = this.gestureStart;
        if (start === null || start.pointerId !== event.pointerId) return;
        event.stopPropagation();
        this.gestureStart = null;
        if (this.content.hasPointerCapture(event.pointerId)) {
            this.content.releasePointerCapture(event.pointerId);
        }

        const deltaX = event.clientX - start.x;
        const shouldRate =
            start.axis === "horizontal" &&
            this.cardState === CardState.Back &&
            (Math.abs(deltaX) >= Math.min(88, this.content.clientWidth * 0.18) ||
                (Math.abs(deltaX) >= 24 && Math.abs(start.velocityX) >= 0.45));

        if (start.axis === "horizontal" && Math.abs(deltaX) > 8) {
            this.suppressNextCardClick = true;
            window.setTimeout(() => {
                this.suppressNextCardClick = false;
            }, 0);
        }

        if (!shouldRate) {
            void this.resetGestureCard(start.card, true);
            return;
        }

        const response = deltaX < 0 ? ReviewResponse.Again : ReviewResponse.Good;
        void this.animateGesture(start.card, deltaX < 0 ? "left" : "right", () =>
            this.processReviewHandler(response),
        );
    };

    private onGestureCancel = (event: PointerEvent): void => {
        const start = this.gestureStart;
        if (start === null || start.pointerId !== event.pointerId) return;
        event.stopPropagation();
        this.gestureStart = null;
        void this.resetGestureCard(start.card, true);
    };

    private async resetGestureCard(card: HTMLElement, animate: boolean): Promise<void> {
        if (animate && card.style.transform !== "") {
            const animation = card.animate(
                [
                    { transform: card.style.transform, opacity: card.style.opacity || "1" },
                    { transform: "translate3d(0, 0, 0) rotate(0deg)", opacity: 1 },
                ],
                { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" },
            );
            await animation.finished.catch((): void => {});
        }
        card.removeClasses(["is-swiping", "is-swiping-left", "is-swiping-right"]);
        card.removeAttribute("data-swipe-label");
        card.style.removeProperty("transform");
        card.style.removeProperty("opacity");
    }

    private enableWorkspaceGestureShield(): void {
        if (
            this.workspaceGestureShieldEnabled ||
            !(Platform.isMobile || EmulatedPlatform().isMobile)
        ) {
            return;
        }
        this.workspaceGestureShieldEnabled = true;
        activeWindow.addEventListener("pointerdown", this.onGestureStart, true);
        activeWindow.addEventListener("pointermove", this.onGestureMove, true);
        activeWindow.addEventListener("pointerup", this.onGestureEnd, true);
        activeWindow.addEventListener("pointercancel", this.onGestureCancel, true);
        activeWindow.addEventListener("touchstart", this.onWorkspaceTouchStart, {
            capture: true,
            passive: true,
        });
        activeWindow.addEventListener("touchmove", this.onWorkspaceTouchMove, {
            capture: true,
            passive: false,
        });
        activeWindow.addEventListener("touchend", this.onWorkspaceTouchEnd, {
            capture: true,
            passive: true,
        });
        activeWindow.addEventListener("touchcancel", this.onWorkspaceTouchEnd, {
            capture: true,
            passive: true,
        });
    }

    private disableWorkspaceGestureShield(): void {
        if (!this.workspaceGestureShieldEnabled) return;
        this.workspaceGestureShieldEnabled = false;
        this.workspaceTouchStart = null;
        activeWindow.removeEventListener("pointerdown", this.onGestureStart, true);
        activeWindow.removeEventListener("pointermove", this.onGestureMove, true);
        activeWindow.removeEventListener("pointerup", this.onGestureEnd, true);
        activeWindow.removeEventListener("pointercancel", this.onGestureCancel, true);
        activeWindow.removeEventListener("touchstart", this.onWorkspaceTouchStart, true);
        activeWindow.removeEventListener("touchmove", this.onWorkspaceTouchMove, true);
        activeWindow.removeEventListener("touchend", this.onWorkspaceTouchEnd, true);
        activeWindow.removeEventListener("touchcancel", this.onWorkspaceTouchEnd, true);
    }

    private onWorkspaceTouchStart = (event: TouchEvent): void => {
        const target = event.target;
        if (
            event.touches.length !== 1 ||
            !(target instanceof Node) ||
            !this.content.contains(target) ||
            (target instanceof Element &&
                target.closest(
                    "a, button, input, textarea, select, [contenteditable='true'], .internal-embed",
                ) !== null)
        ) {
            this.workspaceTouchStart = null;
            return;
        }

        const touch = event.touches[0];
        this.workspaceTouchStart = {
            identifier: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
            axis: "pending",
        };
        event.stopPropagation();
    };

    private onWorkspaceTouchMove = (event: TouchEvent): void => {
        const start = this.workspaceTouchStart;
        if (start === null) return;
        const touch = [...event.touches].find((item) => item.identifier === start.identifier);
        if (touch === undefined) return;

        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        if (start.axis === "pending" && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 7) {
            start.axis = Math.abs(deltaX) > Math.abs(deltaY) * 1.08 ? "horizontal" : "vertical";
        }
        if (start.axis === "horizontal") event.preventDefault();
        event.stopPropagation();
    };

    private onWorkspaceTouchEnd = (event: TouchEvent): void => {
        if (this.workspaceTouchStart === null) return;
        event.stopPropagation();
        this.workspaceTouchStart = null;
    };

    private async animateGesture(
        card: HTMLElement,
        direction: "left" | "right",
        action: () => void | Promise<void>,
    ): Promise<void> {
        const reduceMotion = activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!reduceMotion) {
            const animation = card.animate(
                [
                    { transform: card.style.transform || "translate3d(0, 0, 0)", opacity: 1 },
                    {
                        transform: `translate3d(${direction === "left" ? "-115vw" : "115vw"}, 0, 0) rotate(${direction === "left" ? "-8deg" : "8deg"})`,
                        opacity: 0.05,
                    },
                ],
                { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
            );
            await animation.finished.catch((): void => {});
        }
        await action();
    }

    private revealAnswerFromCard(event: MouseEvent): void {
        if (this.suppressNextCardClick) {
            event.preventDefault();
            return;
        }
        if (
            this.cardState !== CardState.Front ||
            !(Platform.isMobile || EmulatedPlatform().isMobile)
        ) {
            return;
        }

        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
            target.closest(
                "a, button, input, textarea, select, [contenteditable='true'], .internal-embed",
            ) !== null
        ) {
            return;
        }

        const selection = activeWindow.getSelection();
        if (selection !== null && !selection.isCollapsed) return;
        void this.showAnswerHandler();
    }

    private _keydownHandler = (e: KeyboardEvent) => {
        if (!this.plugin.isInitialized) throw new Error("SR plugin or data not initialized!!!");
        if (this.plugin.uiManager === null) throw new Error("UI manager not initialized!!!");
        // Prevents any input, if the edit modal is open or if the view is not in focus
        if (
            this.plugin.dataManager.data.settings.useCustomHotkeys ||
            (activeDocument.activeElement !== null &&
                (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                    activeDocument.activeElement.nodeName === "INPUT")) ||
            !this.plugin.uiManager.getSRInFocusState() ||
            Platform.isMobile || // No keyboard events on mobile
            EmulatedPlatform().isMobile
        ) {
            return;
        }

        const consumeKeyEvent = () => {
            e.preventDefault();
            e.stopPropagation();
        };

        if ((e.metaKey || e.ctrlKey) && e.code === "KeyZ") {
            void this.undoLastReviewHandler();
            consumeKeyEvent();
            return;
        }

        if (this.cardState === CardState.Closed) return;

        switch (e.code) {
            case "KeyS":
                this.skipCardHandler();
                consumeKeyEvent();
                break;
            case "KeyJ":
                void this.jumpToCardHandler();
                consumeKeyEvent();
                break;
            case "Enter":
            case "NumpadEnter":
            case "Space":
                if (this.cardState === CardState.Front) {
                    void this.showAnswerHandler();
                    consumeKeyEvent();
                } else if (this.cardState === CardState.Back) {
                    void this.processReviewHandler(ReviewResponse.Good);
                    consumeKeyEvent();
                }
                break;
            case "Numpad1":
            case "Digit1":
                if (this.cardState !== CardState.Back) {
                    break;
                }
                void this.processReviewHandler(ReviewResponse.Again);
                consumeKeyEvent();
                break;
            case "Numpad2":
            case "Digit2":
                if (this.cardState !== CardState.Back) {
                    break;
                }
                void this.processReviewHandler(ReviewResponse.Hard);
                consumeKeyEvent();
                break;
            case "Numpad3":
            case "Digit3":
                if (this.cardState !== CardState.Back) {
                    break;
                }
                void this.processReviewHandler(ReviewResponse.Good);
                consumeKeyEvent();
                break;
            case "Numpad4":
            case "Digit4":
                if (this.cardState !== CardState.Back) {
                    break;
                }
                void this.processReviewHandler(ReviewResponse.Easy);
                consumeKeyEvent();
                break;
            case "Numpad0":
            case "Digit0":
                if (this.cardState !== CardState.Back) {
                    break;
                }
                void this.processReviewHandler(ReviewResponse.Reset);
                consumeKeyEvent();
                break;
            default:
                break;
        }
    };
}
