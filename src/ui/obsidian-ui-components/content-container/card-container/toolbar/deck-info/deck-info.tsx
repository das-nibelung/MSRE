import "src/ui/obsidian-ui-components/content-container/card-container/toolbar/deck-info/deck-info.css";
import { setIcon } from "obsidian";

import ProgressCounterComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/deck-info/progress-counter-component";

export default class DeckInfoComponent {
    private deckInfoContainer: HTMLDivElement;

    private chosenDeckInfo: HTMLDivElement;
    private chosenDeckName: HTMLDivElement;
    private chosenDeckCounterDivider: HTMLDivElement;
    private chosenDeckCardCounter: ProgressCounterComponent;
    private chosenDeckSubDeckCounter: ProgressCounterComponent;

    private deckPointer: HTMLDivElement;

    private currentDeckInfo: HTMLDivElement;
    private currentDeckName: HTMLDivElement;
    private currentDeckCounterDivider: HTMLDivElement;
    private currentDeckCardCounter: ProgressCounterComponent;
    private sessionProgress: HTMLDivElement;
    private sessionProgressFill: HTMLDivElement;

    constructor(parentEl: HTMLDivElement) {
        this.deckInfoContainer = parentEl.createDiv();
        this.deckInfoContainer.addClass("sr-info-section");

        this.chosenDeckInfo = this.deckInfoContainer.createDiv();
        this.chosenDeckInfo.addClass("sr-deck-info");
        this.chosenDeckInfo.addClass("sr-bg-blue");
        this.chosenDeckInfo.addClass("sr-chosen-deck-info");

        this.chosenDeckName = this.chosenDeckInfo.createDiv();
        this.chosenDeckName.addClass("sr-deck-name");

        this.chosenDeckCounterDivider = this.chosenDeckInfo.createDiv();
        this.chosenDeckCounterDivider.addClass("sr-divider");

        this.chosenDeckCardCounter = new ProgressCounterComponent(
            this.chosenDeckInfo,
            "credit-card",
            0,
            0,
        );

        this.chosenDeckSubDeckCounter = new ProgressCounterComponent(
            this.chosenDeckInfo,
            "layers",
            0,
            0,
        );

        this.deckPointer = this.deckInfoContainer.createDiv();
        setIcon(this.deckPointer, "chevron-right");
        this.deckPointer.addClass("sr-deck-pointer");

        this.currentDeckInfo = this.deckInfoContainer.createDiv();
        this.currentDeckInfo.addClass("sr-deck-info");
        this.currentDeckInfo.addClass("sr-bg-blue");
        this.currentDeckInfo.addClass("sr-current-deck-info");

        this.currentDeckName = this.currentDeckInfo.createDiv();
        this.currentDeckName.addClass("sr-deck-name");

        this.currentDeckCounterDivider = this.currentDeckInfo.createDiv();
        this.currentDeckCounterDivider.addClass("sr-divider");
        this.currentDeckCardCounter = new ProgressCounterComponent(
            this.currentDeckInfo,
            "credit-card",
            0,
            0,
        );

        this.sessionProgress = this.deckInfoContainer.createDiv("sr-session-progress");
        this.sessionProgress.setAttribute("role", "progressbar");
        this.sessionProgress.setAttribute("aria-valuemin", "0");
        this.sessionProgressFill = this.sessionProgress.createDiv("sr-session-progress-fill");
    }

    public updateInfo(
        chosenDeckName: string,
        totalCardsInChosenDeck: number,
        cardProgressInChosenDeck: number,
        totalDecksInChosenDeck: number,
        deckProgressInChosenDeck: number,
        currentDeckName: string,
        currentDeckTotalCardsInDeck: number,
        cardProgressInCurrentDeck: number,
        isTotallyRandom: boolean,
    ) {
        // Set values
        this.chosenDeckName.setText(chosenDeckName);
        this.chosenDeckCardCounter.setProgress(cardProgressInChosenDeck, totalCardsInChosenDeck);
        this.chosenDeckSubDeckCounter.setProgress(deckProgressInChosenDeck, totalDecksInChosenDeck);

        const progress = Math.max(0, Math.min(cardProgressInChosenDeck, totalCardsInChosenDeck));
        const progressPercent =
            totalCardsInChosenDeck === 0 ? 0 : (progress / totalCardsInChosenDeck) * 100;
        this.sessionProgress.setAttribute("aria-valuemax", totalCardsInChosenDeck.toString());
        this.sessionProgress.setAttribute("aria-valuenow", progress.toString());
        this.sessionProgressFill.setCssProps({ width: `${progressPercent}%` });

        this.currentDeckName.setText(currentDeckName);
        this.currentDeckCardCounter.setProgress(
            cardProgressInCurrentDeck,
            currentDeckTotalCardsInDeck,
        );

        const hideCurrentDeckInfo: boolean =
            chosenDeckName === currentDeckName || totalDecksInChosenDeck === 1;
        const hideCurrentDeckCardCounter: boolean = isTotallyRandom;
        const hideSubdeckCounter: boolean = totalDecksInChosenDeck === 1;
        const hideChosenDeckName: boolean = !hideCurrentDeckInfo;
        const hideDeckPointer: boolean = hideCurrentDeckInfo;
        const hideChosenDeckDivider: boolean = hideChosenDeckName;
        const hideCurrentDeckDivider: boolean = hideCurrentDeckCardCounter;

        // Hide unused elements
        if (hideChosenDeckName) {
            if (!this.chosenDeckName.hasClass("sr-is-hidden")) {
                this.chosenDeckName.addClass("sr-is-hidden");
            }
        } else {
            if (this.chosenDeckName.hasClass("sr-is-hidden")) {
                this.chosenDeckName.removeClass("sr-is-hidden");
            }
        }

        if (hideChosenDeckDivider) {
            if (!this.chosenDeckCounterDivider.hasClass("sr-is-hidden")) {
                this.chosenDeckCounterDivider.addClass("sr-is-hidden");
            }
        } else {
            if (this.chosenDeckCounterDivider.hasClass("sr-is-hidden")) {
                this.chosenDeckCounterDivider.removeClass("sr-is-hidden");
            }
        }

        if (hideSubdeckCounter) {
            if (!this.chosenDeckSubDeckCounter.hasClass("sr-is-hidden")) {
                this.chosenDeckSubDeckCounter.addClass("sr-is-hidden");
            }
        } else {
            if (this.chosenDeckSubDeckCounter.hasClass("sr-is-hidden")) {
                this.chosenDeckSubDeckCounter.removeClass("sr-is-hidden");
            }
        }

        if (hideDeckPointer) {
            if (!this.deckPointer.hasClass("sr-is-hidden")) {
                this.deckPointer.addClass("sr-is-hidden");
            }
        } else {
            if (this.deckPointer.hasClass("sr-is-hidden")) {
                this.deckPointer.removeClass("sr-is-hidden");
            }
        }

        if (hideCurrentDeckInfo) {
            if (!this.currentDeckInfo.hasClass("sr-is-hidden")) {
                this.currentDeckInfo.addClass("sr-is-hidden");
            }
        } else {
            if (this.currentDeckInfo.hasClass("sr-is-hidden")) {
                this.currentDeckInfo.removeClass("sr-is-hidden");
            }
        }

        if (hideCurrentDeckDivider) {
            if (!this.currentDeckCounterDivider.hasClass("sr-is-hidden")) {
                this.currentDeckCounterDivider.addClass("sr-is-hidden");
            }
        } else {
            if (this.currentDeckCounterDivider.hasClass("sr-is-hidden")) {
                this.currentDeckCounterDivider.removeClass("sr-is-hidden");
            }
        }

        if (hideCurrentDeckCardCounter) {
            if (!this.currentDeckCardCounter.hasClass("sr-is-hidden")) {
                this.currentDeckCardCounter.addClass("sr-is-hidden");
            }
        } else {
            if (this.currentDeckCardCounter.hasClass("sr-is-hidden")) {
                this.currentDeckCardCounter.removeClass("sr-is-hidden");
            }
        }
    }
}
