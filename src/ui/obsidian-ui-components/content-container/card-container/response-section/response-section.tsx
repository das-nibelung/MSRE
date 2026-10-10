import "src/ui/obsidian-ui-components/content-container/card-container/response-section/response-section.css";

import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import { RepItemScheduleInfo } from "src/scheduling/algorithms/base/rep-item-schedule-info";
import { ReviewResponse } from "src/scheduling/algorithms/base/repetition-item";
import { formatScheduleInterval } from "src/scheduling/algorithms/schedule-display";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import SRResponseButtonComponent from "src/ui/obsidian-ui-components/content-container/card-container/response-section/sr-response-button";

export default class ResponseSectionComponent {
    public responseEl: HTMLDivElement;
    public againButton: SRResponseButtonComponent;
    public hardButton: SRResponseButtonComponent;
    public goodButton: SRResponseButtonComponent;
    public easyButton: SRResponseButtonComponent;
    public answerButton: SRResponseButtonComponent;
    private isProcessing = false;

    constructor(
        container: HTMLElement,
        settings: SRSettings,
        showAnswer: () => void | Promise<void>,
        processReview: (response: ReviewResponse) => Promise<void>,
    ) {
        this.responseEl = container.createDiv();
        this.responseEl.addClass("sr-response");

        this.answerButton = new SRResponseButtonComponent(this.responseEl, {
            classNames: ["sr-bg-blue", "sr-show-answer-button"],
            text: t("SHOW_ANSWER"),
            onClick: () => this.runAction(this.answerButton, showAnswer),
        });

        this.againButton = new SRResponseButtonComponent(this.responseEl, {
            classNames: ["sr-bg-red", "sr-again-button", "sr-is-hidden"],
            text: settings.flashcardAgainText,
            onClick: () =>
                this.runAction(this.againButton, () => processReview(ReviewResponse.Again)),
        });

        this.hardButton = new SRResponseButtonComponent(this.responseEl, {
            classNames: ["sr-bg-yellow", "sr-hard-button", "sr-is-hidden"],
            text: settings.flashcardHardText,
            onClick: () =>
                this.runAction(this.hardButton, () => processReview(ReviewResponse.Hard)),
        });

        this.goodButton = new SRResponseButtonComponent(this.responseEl, {
            classNames: ["sr-bg-blue", "sr-good-button", "sr-is-hidden"],
            text: settings.flashcardGoodText,
            onClick: () =>
                this.runAction(this.goodButton, () => processReview(ReviewResponse.Good)),
        });

        this.easyButton = new SRResponseButtonComponent(this.responseEl, {
            classNames: ["sr-bg-green", "sr-easy-button", "sr-is-hidden"],
            text: settings.flashcardEasyText,
            onClick: () =>
                this.runAction(this.easyButton, () => processReview(ReviewResponse.Easy)),
        });
    }

    private async runAction(
        sourceButton: SRResponseButtonComponent,
        action: () => void | Promise<void>,
    ): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;
        this.responseEl.setAttribute("aria-busy", "true");
        sourceButton.buttonEl.addClass("mod-loading");
        this.getButtons().forEach((button) => {
            button.setDisabled(true);
        });

        try {
            await action();
        } finally {
            this.getButtons().forEach((button) => {
                button.setDisabled(false);
            });
            sourceButton.buttonEl.removeClass("mod-loading");
            this.responseEl.removeAttribute("aria-busy");
            this.isProcessing = false;
            if (
                sourceButton === this.answerButton &&
                !this.againButton.buttonEl.hasClass("sr-is-hidden")
            ) {
                this.againButton.buttonEl.focus();
            }
        }
    }

    private getButtons(): SRResponseButtonComponent[] {
        return [
            this.answerButton,
            this.againButton,
            this.hardButton,
            this.goodButton,
            this.easyButton,
        ];
    }

    public resetResponseButtons() {
        // Sets all buttons in to their default state
        if (this.responseEl.hasClass("sr-is-hidden")) {
            this.responseEl.removeClass("sr-is-hidden");
        }
        this.answerButton.buttonEl.removeClass("sr-is-hidden");
        this.againButton.buttonEl.addClass("sr-is-hidden");
        this.hardButton.buttonEl.addClass("sr-is-hidden");
        this.goodButton.buttonEl.addClass("sr-is-hidden");
        this.easyButton.buttonEl.addClass("sr-is-hidden");
    }

    public hideAllButtons() {
        if (!this.responseEl.hasClass("sr-is-hidden")) {
            this.responseEl.addClass("sr-is-hidden");
        }
        this.answerButton.buttonEl.addClass("sr-is-hidden");
        this.againButton.buttonEl.addClass("sr-is-hidden");
        this.hardButton.buttonEl.addClass("sr-is-hidden");
        this.goodButton.buttonEl.addClass("sr-is-hidden");
        this.easyButton.buttonEl.addClass("sr-is-hidden");
    }

    public showRatingButtons(
        reviewMode: FlashcardReviewMode,
        againButtonText: string,
        hardButtonText: string,
        goodButtonText: string,
        easyButtonText: string,
        showIntervalInReviewButtons: boolean,
        determineButtonSchedule: (response: ReviewResponse) => RepItemScheduleInfo | null,
    ) {
        if (this.responseEl.hasClass("sr-is-hidden")) {
            this.responseEl.removeClass("sr-is-hidden");
        }
        // Shows the rating buttons and hides the show answer button
        this.answerButton.buttonEl.addClass("sr-is-hidden");

        if (reviewMode === FlashcardReviewMode.Cram) {
            this.responseEl.addClass("is-cram");
            this.setLabelOnly(this.againButton, againButtonText);
            this.setLabelOnly(this.easyButton, easyButtonText);

            if (this.againButton.buttonEl.hasClass("sr-is-hidden")) {
                this.againButton.buttonEl.removeClass("sr-is-hidden");
            }
            if (this.easyButton.buttonEl.hasClass("sr-is-hidden")) {
                this.easyButton.buttonEl.removeClass("sr-is-hidden");
            }

            if (!this.goodButton.buttonEl.hasClass("sr-is-hidden")) {
                this.goodButton.buttonEl.addClass("sr-is-hidden");
            }
            if (!this.hardButton.buttonEl.hasClass("sr-is-hidden")) {
                this.hardButton.buttonEl.addClass("sr-is-hidden");
            }
        } else {
            if (this.responseEl.hasClass("is-cram")) this.responseEl.removeClass("is-cram");
            this.againButton.buttonEl.removeClass("sr-is-hidden");
            this.hardButton.buttonEl.removeClass("sr-is-hidden");
            this.goodButton.buttonEl.removeClass("sr-is-hidden");
            this.easyButton.buttonEl.removeClass("sr-is-hidden");
            this._setupEaseButton(
                this.againButton,
                againButtonText,
                determineButtonSchedule(ReviewResponse.Again),
                showIntervalInReviewButtons,
            );
            this._setupEaseButton(
                this.hardButton,
                hardButtonText,
                determineButtonSchedule(ReviewResponse.Hard),
                showIntervalInReviewButtons,
            );
            this._setupEaseButton(
                this.goodButton,
                goodButtonText,
                determineButtonSchedule(ReviewResponse.Good),
                showIntervalInReviewButtons,
            );
            this._setupEaseButton(
                this.easyButton,
                easyButtonText,
                determineButtonSchedule(ReviewResponse.Easy),
                showIntervalInReviewButtons,
            );
        }
    }

    private _setupEaseButton(
        button: SRResponseButtonComponent,
        buttonName: string,
        schedule: RepItemScheduleInfo | null,
        showInterval: boolean,
    ) {
        if (showInterval) {
            button.setSmallText(formatScheduleInterval(schedule, true));
            button.setLargeText(buttonName);
            button.buttonEl.addClass("sr-show-small-text");
            button.buttonEl.addClass("sr-show-large-text");
        } else {
            this.setLabelOnly(button, buttonName);
        }
    }

    private setLabelOnly(button: SRResponseButtonComponent, buttonName: string): void {
        button.buttonEl.removeClass("sr-show-small-text");
        button.buttonEl.addClass("sr-show-large-text");
        button.setLargeText(buttonName);
    }
}
