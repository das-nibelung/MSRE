import "src/ui/obsidian-ui-components/content-container/card-container/card-container.css";
import moment from "moment";
import { App, ButtonComponent, Platform, setIcon } from "obsidian";

import {
    AnswerEvaluationContext,
    AnswerValue,
    canonicalAnswerMode,
    evaluateAnswer,
    normalizeAnswerConfig,
} from "src/data/collection/answer-evaluator";
import {
    IMAGE_OCCLUSION_NOTE_TYPE_ID,
    OCCLUSION_ASSETS_FIELD_ID,
} from "src/data/collection/builtin-note-types";
import {
    CardFlag,
    CardTemplateDefinition,
    NoteTypeDefinition,
} from "src/data/collection/collection-types";
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
    private activeReviewMode = FlashcardReviewMode.Review;

    private clozeInputs: NodeListOf<HTMLInputElement> | null = null;
    private clozeAnswers: NodeListOf<Element> | null = null;
    private answerValue: AnswerValue = "";
    private answerContext: AnswerEvaluationContext | null = null;

    private processReviewHandler: (response: ReviewResponse) => Promise<void>;
    private skipCardHandler: () => void;
    private showAnswerHandler: () => void | Promise<void>;
    private jumpToCardHandler: () => Promise<void>;
    private backToDeckHandler: () => Promise<void>;
    private undoLastReviewHandler: () => Promise<void>;
    private editCardHandler: () => void;
    private buryCurrentCardHandler: () => Promise<void>;
    private suspendCurrentCardHandler: () => Promise<void>;
    private setCurrentCardFlagHandler: (flag: CardFlag) => Promise<void>;
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
        lastX: number;
        lastY: number;
        lastTime: number;
        velocityX: number;
        velocityY: number;
        axis: "pending" | "horizontal" | "vertical" | "vertical-scroll";
        card: HTMLElement;
    } | null = null;
    private workspaceGestureShieldEnabled = false;
    private gestureActionPending = false;

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
        suspendCurrentCardHandler: () => Promise<void>,
        setCurrentCardFlagHandler: (flag: CardFlag) => Promise<void>,
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
        this.editCardHandler = editCardHandler;
        this.buryCurrentCardHandler = buryCurrentCardHandler;
        this.suspendCurrentCardHandler = suspendCurrentCardHandler;
        this.setCurrentCardFlagHandler = setCurrentCardFlagHandler;

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
            suspendCurrentCardHandler,
            setCurrentCardFlagHandler,
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
        this.clearGestureState();
        this.answerValue = "";
        this.answerContext = null;
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
        this.applyNoteTypeAppearance(cardSurface, sessionData);

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
        this.applyTemplateSurfaceAppearance(cardFace, sessionData, "question");
        this.bindTemplateActions(cardFace);

        const answerContext = this.getAnswerContext(sessionData);
        this.answerContext = answerContext;
        if (allowTapToReveal && answerContext && cardFace.querySelector(".cloze-input") === null) {
            this.renderAnswerComposer(cardSurface, answerContext);
        }

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

    private getAnswerContext(sessionData: SessionData): AnswerEvaluationContext | null {
        const card = sessionData.cardData.currentCard;
        const note = this.plugin.dataManager.collectionStore.findNoteBySource(
            sessionData.currentNote.filePath,
            card.storageInfo?.questionId,
        );
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const questionId = card.storageInfo?.questionId;
        const storedCard = note
            ? (Object.values(snapshot.cards).find(
                  (candidate) =>
                      !candidate.deletedAt &&
                      candidate.noteId === note.id &&
                      Boolean(questionId) &&
                      candidate.legacyStableId === `${questionId}:${card.cardIdx}`,
              ) ??
              Object.values(snapshot.cards).find(
                  (candidate) =>
                      !candidate.deletedAt &&
                      candidate.noteId === note.id &&
                      Boolean(questionId) &&
                      candidate.legacyStableId?.startsWith(`${questionId}:`),
              ))
            : undefined;
        const template =
            note && storedCard
                ? snapshot.noteTypes[note.noteTypeId]?.templates.find(
                      (candidate) => candidate.id === storedCard.templateId,
                  )
                : undefined;
        const templateMode = canonicalAnswerMode(template?.answerMode);
        if (template && templateMode !== "reveal") {
            let expected = template.answerFieldId
                ? (note?.fields[template.answerFieldId]?.trim() ?? "")
                : "";
            let answerConfig = normalizeAnswerConfig(template.answerConfig);
            if (note?.noteTypeId === IMAGE_OCCLUSION_NOTE_TYPE_ID && !expected) {
                try {
                    const assets = JSON.parse(
                        note.fields[OCCLUSION_ASSETS_FIELD_ID] ?? "[]",
                    ) as Array<{
                        label?: string;
                        acceptedLabels?: string[];
                        answers?: Array<{
                            id: string;
                            label: string;
                            acceptedLabels?: string[];
                            concepts?: string[];
                        }>;
                    }>;
                    const asset = assets[storedCard?.ordinal ?? card.cardIdx];
                    expected = asset?.label?.trim() ?? "";
                    answerConfig = {
                        ...answerConfig,
                        acceptedAnswers: asset?.acceptedLabels ?? [],
                        parts:
                            asset?.answers?.map((answer, index) => ({
                                id: answer.id,
                                label:
                                    answer.concepts?.filter(Boolean).join(" · ") ||
                                    `Region ${index + 1}`,
                                answerFieldId: null as string | null,
                                acceptedAnswers: [answer.label, ...(answer.acceptedLabels ?? [])]
                                    .map((value) => value.trim())
                                    .filter(Boolean),
                                requiredKeywords: [] as string[],
                                optional: false,
                                weight: 1,
                            })) ?? [],
                    };
                } catch {
                    expected = "";
                }
            }
            return {
                mode: templateMode,
                expected,
                config: answerConfig,
                values: this.answerValue,
                fieldValues: note?.fields ?? {},
            };
        }
        if (canonicalAnswerMode(note?.answerMode) === "text") {
            return {
                mode: "text",
                expected: "",
                values: this.answerValue,
                fieldValues: note?.fields ?? {},
            };
        }
        const fallback = card.back.match(/<!--\s*sr-typed-answer:\s*([^]*?)\s*-->/i);
        return fallback
            ? {
                  mode: "text",
                  expected: decodeURIComponent(fallback[1].trim()),
                  values: this.answerValue,
              }
            : null;
    }

    private renderAnswerComposer(cardSurface: HTMLElement, context: AnswerEvaluationContext): void {
        const mode = canonicalAnswerMode(context.mode);
        const config = normalizeAnswerConfig(context.config);
        const composer = cardSurface.createDiv(`sr-smart-answer-composer is-${mode}`);
        composer.addEventListener("click", (event) => event.stopPropagation());

        const submit = () => {
            const active = composer.querySelector<HTMLElement>("input:focus, textarea:focus");
            active?.blur();
            void this.showAnswerHandler();
        };
        const bindSubmit = (input: HTMLInputElement | HTMLTextAreaElement) => {
            input.addEventListener("keydown", (rawEvent) => {
                const event = rawEvent as KeyboardEvent;
                if (
                    event.key !== "Enter" ||
                    (input instanceof HTMLTextAreaElement && event.shiftKey)
                )
                    return;
                if (
                    ["ordered-list", "unordered-list"].includes(mode) &&
                    !event.metaKey &&
                    !event.ctrlKey
                )
                    return;
                event.preventDefault();
                event.stopPropagation();
                submit();
            });
        };

        if (mode === "multiple-choice") {
            const selected = new Set(Array.isArray(this.answerValue) ? this.answerValue : []);
            const choices = composer.createDiv("sr-answer-choice-grid");
            const choiceGroup = `sr-answer-${Date.now()}`;
            for (const choice of config.choices) {
                const label = choices.createEl("label", { cls: "sr-review-answer-choice" });
                const input = label.createEl("input", {
                    attr: {
                        type: config.multipleChoice ? "checkbox" : "radio",
                        name: choiceGroup,
                        value: choice.id,
                    },
                });
                input.checked = selected.has(choice.id);
                input.addEventListener("change", () => {
                    if (!config.multipleChoice) selected.clear();
                    if (input.checked) selected.add(choice.id);
                    else selected.delete(choice.id);
                    this.answerValue = [...selected];
                    choices
                        .querySelectorAll("label")
                        .forEach((item) =>
                            item.toggleClass(
                                "is-selected",
                                item.querySelector<HTMLInputElement>("input")?.checked ?? false,
                            ),
                        );
                });
                label.createSpan({ text: choice.label });
                label.toggleClass("is-selected", input.checked);
            }
        } else if (mode === "multiple-text" || mode === "image-labels") {
            const values =
                typeof this.answerValue === "object" && !Array.isArray(this.answerValue)
                    ? this.answerValue
                    : {};
            const parts =
                config.parts.length > 0
                    ? config.parts
                    : [
                          {
                              id: "label",
                              label: t("TYPE_YOUR_ANSWER"),
                              answerFieldId: null,
                              acceptedAnswers: context.expected ? [context.expected] : [],
                              requiredKeywords: [],
                              optional: false,
                              weight: 1,
                          },
                      ];
            for (const part of parts) {
                const field = composer.createEl("label", { cls: "sr-smart-answer-field" });
                field.createSpan({ text: part.label });
                const input = field.createEl("input", {
                    cls: "sr-typed-answer-input",
                    attr: { type: "text", autocomplete: "off" },
                });
                input.value = values[part.id] ?? "";
                input.addEventListener("input", () => {
                    values[part.id] = input.value;
                    this.answerValue = values;
                });
                bindSubmit(input);
            }
        } else {
            const isList = mode === "ordered-list" || mode === "unordered-list";
            const input = isList
                ? composer.createEl("textarea", {
                      cls: "sr-typed-answer-input sr-smart-answer-list",
                      attr: { rows: "4", placeholder: t("TYPE_YOUR_ANSWER") },
                  })
                : composer.createEl("input", {
                      cls: "sr-typed-answer-input",
                      attr: {
                          type: mode === "number" ? "text" : "text",
                          inputmode: mode === "number" ? "decimal" : "text",
                          autocomplete: "off",
                          autocapitalize: mode === "formula" ? "off" : "sentences",
                          placeholder: t("TYPE_YOUR_ANSWER"),
                          "aria-label": t("TYPE_YOUR_ANSWER"),
                      },
                  });
            input.value = typeof this.answerValue === "string" ? this.answerValue : "";
            input.addEventListener("input", () => (this.answerValue = input.value));
            bindSubmit(input);
        }
        const button = composer.createEl("button", {
            cls: "sr-typed-answer-submit",
            attr: { type: "button", "aria-label": t("CHECK_ANSWER") },
        });
        setIcon(button, "arrow-up");
        button.addEventListener("click", submit);
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
        this.clearGestureState();
        this.activeReviewMode = reviewMode;
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
            this.applyNoteTypeAppearance(cardSurface, sessionData);
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
        this.applyTemplateSurfaceAppearance(answerFace, sessionData, "answer");
        this.bindTemplateActions(answerFace);

        if (this.answerContext) {
            const context = { ...this.answerContext, values: this.answerValue };
            if (!context.expected) context.expected = answerFace.innerText.trim();
            const evaluation = evaluateAnswer(context);
            const comparison = cardSurface.createDiv(
                `sr-smart-answer-result is-${evaluation.status}`,
            );
            const summary = comparison.createDiv("sr-smart-answer-summary");
            const icon = summary.createSpan("sr-smart-answer-status-icon");
            setIcon(
                icon,
                evaluation.status === "correct"
                    ? "check"
                    : evaluation.status === "partial"
                      ? "circle-dot"
                      : "x",
            );
            summary.createEl("strong", {
                text:
                    evaluation.status === "correct"
                        ? t("ANSWER_CORRECT")
                        : evaluation.status === "partial"
                          ? t("ANSWER_PARTIAL")
                          : t("ANSWER_INCORRECT"),
            });
            summary.createSpan({
                cls: "sr-smart-answer-score",
                text: t("SCORE_PERCENT", { score: Math.round(evaluation.score * 100) }),
            });
            const parts = comparison.createDiv("sr-smart-answer-parts");
            for (const part of evaluation.parts) {
                const row = parts.createDiv(
                    `sr-smart-answer-part ${part.correct ? "is-correct" : ""}`,
                );
                if (evaluation.parts.length > 1) row.createEl("strong", { text: part.label });
                const answers = row.createDiv("sr-smart-answer-values");
                answers.createSpan({ cls: "is-submitted", text: part.submitted || "—" });
                if (!part.correct) {
                    answers.createSpan({ cls: "is-expected", text: part.expected });
                    if (part.diff.length > 0) {
                        const diff = row.createDiv("sr-smart-answer-diff");
                        for (const token of part.diff) {
                            diff.createSpan({ cls: `is-${token.kind}`, text: `${token.value} ` });
                        }
                    }
                }
            }
            if (evaluation.missingKeywords.length > 0) {
                comparison.createDiv({
                    cls: "sr-smart-answer-missing",
                    text: t("MISSING_KEYWORDS", {
                        keywords: evaluation.missingKeywords.join(", "),
                    }),
                });
            }
            if (evaluation.missingOptionalKeywords.length > 0) {
                comparison.createDiv({
                    cls: "sr-smart-answer-optional",
                    text: t("MISSING_OPTIONAL_KEYWORDS", {
                        keywords: evaluation.missingOptionalKeywords.join(", "),
                    }),
                });
            }
        }

        if (Platform.isMobile || EmulatedPlatform().isMobile) {
            const guide = cardSurface.createDiv("sr-swipe-guide");
            const gestures: [string, string, string][] =
                reviewMode === FlashcardReviewMode.Cram
                    ? [
                          ["arrow-left", t("AGAIN"), "again"],
                          ["arrow-right", t("EASY"), "easy"],
                      ]
                    : [
                          ["arrow-left", t("AGAIN"), "again"],
                          ["arrow-down", t("HARD"), "hard"],
                          ["arrow-up", t("GOOD"), "good"],
                          ["arrow-right", t("EASY"), "easy"],
                      ];
            for (const [iconName, label, tone] of gestures) {
                const item = guide.createDiv(`sr-swipe-guide-item is-${tone}`);
                const icon = item.createSpan();
                setIcon(icon, iconName);
                item.createSpan({ text: label });
            }
        }

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

    private applyNoteTypeAppearance(cardSurface: HTMLElement, sessionData: SessionData): void {
        const presentation = this.getTemplatePresentation(sessionData);
        if (!presentation) return;
        const { noteType, template } = presentation;
        cardSurface.dataset.noteType = noteType.id;
        this.applyTemplateCss(cardSurface, [noteType.css, template?.css ?? ""]);
    }

    private getTemplatePresentation(sessionData: SessionData): {
        noteType: NoteTypeDefinition;
        template: CardTemplateDefinition | undefined;
    } | null {
        const card = sessionData.cardData.currentCard;
        const note = this.plugin.dataManager.collectionStore.findNoteBySource(
            sessionData.currentNote.filePath,
            card?.storageInfo?.questionId,
        );
        if (!note) return null;
        const noteType = this.plugin.dataManager.collectionStore.getNoteType(note.noteTypeId);
        if (!noteType) return null;
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const questionId = card?.storageInfo?.questionId;
        const storedCard = Object.values(snapshot.cards).find(
            (candidate) =>
                !candidate.deletedAt &&
                candidate.noteId === note.id &&
                Boolean(questionId) &&
                candidate.legacyStableId?.startsWith(`${questionId}:`),
        );
        const template = noteType.templates.find(
            (template) => template.id === storedCard?.templateId,
        );
        return { noteType, template };
    }

    private applyTemplateSurfaceAppearance(
        element: HTMLElement,
        sessionData: SessionData,
        surface: "question" | "answer",
    ): void {
        const template = this.getTemplatePresentation(sessionData)?.template;
        if (!template) return;
        this.applyTemplateCss(element, [
            surface === "question" ? (template.questionCss ?? "") : (template.answerCss ?? ""),
        ]);
    }

    private applyTemplateCss(element: HTMLElement, sources: string[]): void {
        for (const source of sources.map((value) => value.trim()).filter(Boolean)) {
            if (!source.includes("{")) {
                const current = element.getAttribute("style") ?? "";
                element.setAttribute("style", [current, source].filter(Boolean).join(";"));
                continue;
            }
            const scope = `sr-template-scope-${Math.random().toString(36).slice(2, 9)}`;
            element.classList.add(scope);
            const selector = `.${scope}`;
            const scoped = source
                .replaceAll("{{card}}", selector)
                .replaceAll("{{front}}", selector)
                .replaceAll("{{back}}", selector)
                .replaceAll("{{browser}}", selector)
                .replace(/(^|})(\s*)([^@}{][^{]*){/g, (_match, boundary, space, selectors) => {
                    const prefixed = String(selectors)
                        .split(",")
                        .map((candidate) => {
                            const trimmed = candidate.trim();
                            return trimmed.startsWith(selector)
                                ? trimmed
                                : `${selector} ${trimmed}`;
                        })
                        .join(", ");
                    return `${boundary}${space}${prefixed}{`;
                });
            element.createEl("style", { text: scoped });
        }
    }

    private bindTemplateActions(root: HTMLElement): void {
        for (const button of root.querySelectorAll<HTMLElement>(".sr-template-tts")) {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const encoded = button.dataset.srTts;
                if (!encoded || !("speechSynthesis" in window)) return;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(
                    new SpeechSynthesisUtterance(decodeURIComponent(encoded)),
                );
            });
        }
    }

    private createSummaryStat(parent: HTMLElement, value: string | number, label: string): void {
        const stat = parent.createDiv("sr-session-summary-stat");
        stat.createEl("strong", { text: String(value) });
        stat.createSpan({ text: label });
    }

    private onGestureStart = (event: PointerEvent): void => {
        if (this.gestureActionPending) {
            this.gestureStart = null;
            return;
        }
        if (event.pointerType === "touch") {
            if (
                event.target instanceof Node &&
                this.content.contains(event.target) &&
                this.isGestureTarget(event.target)
            ) {
                event.stopPropagation();
            }
            this.gestureStart = null;
            return;
        }
        if (
            !(Platform.isMobile || EmulatedPlatform().isMobile) ||
            !event.isPrimary ||
            event.pointerType !== "pen"
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
        if (event.pointerType === "touch" && this.workspaceTouchStart !== null) {
            event.stopPropagation();
            return;
        }
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
        if (event.pointerType === "touch" && this.workspaceTouchStart !== null) {
            event.stopPropagation();
            return;
        }
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
        if (event.pointerType === "touch" && this.workspaceTouchStart !== null) {
            event.stopPropagation();
            return;
        }
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
        card.removeClasses([
            "is-swiping",
            "is-swiping-left",
            "is-swiping-right",
            "is-swiping-up",
            "is-swiping-down",
        ]);
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
            passive: false,
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
            this.gestureActionPending ||
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
        const card = this.content.querySelector<HTMLElement>(".sr-study-card");
        if (card === null) return;
        this.workspaceTouchStart = {
            identifier: touch.identifier,
            x: touch.clientX,
            y: touch.clientY,
            lastX: touch.clientX,
            lastY: touch.clientY,
            lastTime: event.timeStamp,
            velocityX: 0,
            velocityY: 0,
            axis: "pending",
            card,
        };
        event.stopPropagation();
    };

    private isGestureTarget(target: Node): boolean {
        return !(
            target instanceof Element &&
            target.closest(
                "a, button, input, textarea, select, [contenteditable='true'], .internal-embed",
            ) !== null
        );
    }

    private onWorkspaceTouchMove = (event: TouchEvent): void => {
        const start = this.workspaceTouchStart;
        if (start === null) return;
        const touch = [...event.touches].find((item) => item.identifier === start.identifier);
        if (touch === undefined) return;

        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        if (start.axis === "pending" && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 7) {
            if (Math.abs(deltaX) > Math.abs(deltaY) * 1.05) {
                start.axis = "horizontal";
            } else {
                const contentCanScroll = this.content.scrollHeight > this.content.clientHeight + 4;
                start.axis = contentCanScroll ? "vertical-scroll" : "vertical";
            }
        }
        if (start.axis === "vertical-scroll") {
            event.stopPropagation();
            return;
        }

        if (start.axis === "horizontal" || start.axis === "vertical") {
            event.preventDefault();
            const elapsed = Math.max(1, event.timeStamp - start.lastTime);
            start.velocityX = (touch.clientX - start.lastX) / elapsed;
            start.velocityY = (touch.clientY - start.lastY) / elapsed;
            start.lastX = touch.clientX;
            start.lastY = touch.clientY;
            start.lastTime = event.timeStamp;
            this.updateTouchGesture(start, deltaX, deltaY);
        }
        event.stopPropagation();
    };

    private onWorkspaceTouchEnd = (event: TouchEvent): void => {
        const start = this.workspaceTouchStart;
        if (start === null) return;
        event.stopPropagation();
        this.workspaceTouchStart = null;
        const touch = [...event.changedTouches].find(
            (item) => item.identifier === start.identifier,
        );
        const endX = touch?.clientX ?? start.lastX;
        const endY = touch?.clientY ?? start.lastY;
        const deltaX = endX - start.x;
        const deltaY = endY - start.y;
        const distance = Math.hypot(deltaX, deltaY);
        const velocity = Math.hypot(start.velocityX, start.velocityY);
        const isGestureAxis = start.axis === "horizontal" || start.axis === "vertical";

        if (isGestureAxis && distance > 8) {
            this.suppressNextCardClick = true;
            window.setTimeout(() => {
                this.suppressNextCardClick = false;
            }, 0);
        }

        const shouldAct =
            isGestureAxis &&
            (distance >= Math.min(82, this.content.clientWidth * 0.17) ||
                (distance >= 26 && velocity >= 0.42));
        if (!shouldAct) {
            void this.resetGestureCard(start.card, true);
            return;
        }

        if (this.cardState === CardState.Front) {
            void this.resetGestureCard(start.card, false).then(() => this.showAnswerHandler());
            return;
        }
        if (this.cardState !== CardState.Back) {
            void this.resetGestureCard(start.card, true);
            return;
        }

        const { response, direction } = this.getTouchGestureAction(deltaX, deltaY);
        void this.animateGesture(start.card, direction, () => this.processReviewHandler(response));
    };

    private updateTouchGesture(
        start: NonNullable<CardContainer["workspaceTouchStart"]>,
        deltaX: number,
        deltaY: number,
    ): void {
        const maxTravel = Math.min(190, this.content.clientWidth * 0.42);
        const scale = Math.min(1, maxTravel / Math.max(1, Math.hypot(deltaX, deltaY)));
        const x = deltaX * scale;
        const y = deltaY * scale;
        const action =
            this.cardState === CardState.Back
                ? this.getTouchGestureAction(deltaX, deltaY)
                : { response: ReviewResponse.Good, direction: "up" as const };
        const label =
            this.cardState === CardState.Front
                ? t("SHOW_ANSWER")
                : action.response === ReviewResponse.Again
                  ? t("AGAIN")
                  : action.response === ReviewResponse.Hard
                    ? t("HARD")
                    : action.response === ReviewResponse.Good
                      ? t("GOOD")
                      : t("EASY");
        start.card.addClass("is-swiping");
        start.card.removeClasses([
            "is-swiping-left",
            "is-swiping-right",
            "is-swiping-up",
            "is-swiping-down",
        ]);
        start.card.addClass(`is-swiping-${action.direction}`);
        start.card.dataset.swipeLabel = label;
        start.card.setCssProps({
            transform: `translate3d(${x}px, ${y}px, 0) rotate(${x / 70}deg)`,
            opacity: String(1 - Math.min(Math.hypot(x, y) / 760, 0.18)),
        });
    }

    private getTouchGestureAction(
        deltaX: number,
        deltaY: number,
    ): {
        response: ReviewResponse;
        direction: "left" | "right" | "up" | "down";
    } {
        if (Math.abs(deltaX) >= Math.abs(deltaY)) {
            return deltaX < 0
                ? { response: ReviewResponse.Again, direction: "left" }
                : { response: ReviewResponse.Easy, direction: "right" };
        }
        if (this.activeReviewMode === FlashcardReviewMode.Cram) {
            return deltaY < 0
                ? { response: ReviewResponse.Again, direction: "up" }
                : { response: ReviewResponse.Easy, direction: "down" };
        }
        return deltaY < 0
            ? { response: ReviewResponse.Good, direction: "up" }
            : { response: ReviewResponse.Hard, direction: "down" };
    }

    private async animateGesture(
        card: HTMLElement,
        direction: "left" | "right" | "up" | "down",
        action: () => void | Promise<void>,
    ): Promise<void> {
        if (this.gestureActionPending) return;
        this.gestureActionPending = true;
        const reduceMotion = activeWindow.matchMedia("(prefers-reduced-motion: reduce)").matches;
        try {
            if (!reduceMotion) {
                const exitTransform =
                    direction === "left"
                        ? "translate3d(-115vw, 0, 0) rotate(-8deg)"
                        : direction === "right"
                          ? "translate3d(115vw, 0, 0) rotate(8deg)"
                          : direction === "up"
                            ? "translate3d(0, -115vh, 0)"
                            : "translate3d(0, 115vh, 0)";
                const animation = card.animate(
                    [
                        {
                            transform: card.style.transform || "translate3d(0, 0, 0)",
                            opacity: 1,
                        },
                        {
                            transform: exitTransform,
                            opacity: 0.05,
                        },
                    ],
                    { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
                );
                await animation.finished.catch((): void => {});
                animation.cancel();
            }
            await this.resetGestureCard(card, false);
            await action();
        } finally {
            if (card.isConnected) await this.resetGestureCard(card, false);
            this.gestureActionPending = false;
        }
    }

    private clearGestureState(): void {
        this.gestureStart = null;
        this.workspaceTouchStart = null;
        const card = this.content?.querySelector<HTMLElement>(".sr-study-card");
        if (card) void this.resetGestureCard(card, false);
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

        if (e.shiftKey && /^Digit[1-7]$/.test(e.code)) {
            void this.setCurrentCardFlagHandler(Number(e.code.slice(-1)) as CardFlag);
            consumeKeyEvent();
            return;
        }

        if (e.shiftKey && e.code === "Digit0") {
            void this.setCurrentCardFlagHandler(0);
            consumeKeyEvent();
            return;
        }

        if (this.cardState === CardState.Closed) return;

        switch (e.code) {
            case "KeyE":
                this.editCardHandler();
                consumeKeyEvent();
                break;
            case "KeyB":
                void this.buryCurrentCardHandler();
                consumeKeyEvent();
                break;
            case "KeyU":
                void this.suspendCurrentCardHandler();
                consumeKeyEvent();
                break;
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
