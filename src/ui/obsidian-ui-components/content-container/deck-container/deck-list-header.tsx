import "src/ui/obsidian-ui-components/content-container/deck-container/deck-list-header.css";
import { ButtonComponent, Menu, setIcon } from "obsidian";

import { t } from "src/lang/helpers";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import ModalCloseButtonComponent from "src/ui/obsidian-ui-components/content-container/modal-close-button";

export default class DeckListHeaderComponent {
    private header: HTMLDivElement;
    private reviewModeButtons = new Map<FlashcardReviewMode, HTMLButtonElement>();

    public constructor(
        parentEl: HTMLElement,
        changeReviewMode: (reviewMode: FlashcardReviewMode) => void,
        openCardBrowser: () => void | Promise<void>,
        createCard: () => void,
        createDeck: () => void,
        closeModal?: () => void,
    ) {
        this.header = parentEl.createDiv();
        this.header.addClass("sr-deck-list-header");
        this.header.addClass("sr-header");

        const navigation = this.header.createDiv("sr-deck-navigation");
        const title = navigation.createDiv("sr-title");
        title.setText(t("DECKS"));

        const actions = navigation.createDiv("sr-deck-navigation-actions");
        const browserButton = new ButtonComponent(actions)
            .setButtonText(t("CARD_BROWSER"))
            .setTooltip(t("BROWSE_CARDS"))
            .onClick(openCardBrowser);
        browserButton.buttonEl.addClass("sr-card-browser-button");
        browserButton.buttonEl.setAttribute("aria-label", t("BROWSE_CARDS"));
        const browserIcon = activeDocument.createElement("span");
        browserIcon.addClass("sr-card-browser-icon");
        setIcon(browserIcon, "library-big");
        browserButton.buttonEl.prepend(browserIcon);

        const createButton = new ButtonComponent(actions)
            .setIcon("plus")
            .setTooltip(t("NEW_CARD"))
            .onClick((event) => {
                const menu = new Menu();
                menu.addItem((item) =>
                    item.setTitle(t("NEW_CARD")).setIcon("square-pen").onClick(createCard),
                );
                menu.addItem((item) =>
                    item.setTitle(t("NEW_DECK")).setIcon("layers-3").onClick(createDeck),
                );
                menu.showAtMouseEvent(event);
            });
        createButton.buttonEl.addClass("sr-deck-create-button");

        if (closeModal !== undefined) {
            new ModalCloseButtonComponent(actions, closeModal, [
                "sr-deck-close-button",
                "clickable-icon",
            ]);
        }

        const modeSwitcher = this.header.createDiv("sr-review-mode-switcher");
        modeSwitcher.setAttribute("role", "group");
        modeSwitcher.setAttribute("aria-label", t("REVIEW_MODE"));
        this.createModeButton(
            modeSwitcher,
            FlashcardReviewMode.Review,
            t("REVIEW_MODE"),
            changeReviewMode,
        );
        this.createModeButton(
            modeSwitcher,
            FlashcardReviewMode.Cram,
            t("CRAM_MODE"),
            changeReviewMode,
        );
        this.updateReviewMode(FlashcardReviewMode.Review);
    }

    public updateReviewMode(reviewMode: FlashcardReviewMode) {
        this.reviewModeButtons.forEach((button, mode) => {
            const isActive = mode === reviewMode;
            button.toggleClass("is-active", isActive);
            button.setAttribute("aria-pressed", String(isActive));
        });
    }

    private createModeButton(
        parentEl: HTMLElement,
        mode: FlashcardReviewMode,
        label: string,
        changeReviewMode: (reviewMode: FlashcardReviewMode) => void,
    ): void {
        const button = new ButtonComponent(parentEl).setButtonText(label).onClick(() => {
            this.updateReviewMode(mode);
            changeReviewMode(mode);
        });
        button.buttonEl.addClass("sr-review-mode-button");
        this.reviewModeButtons.set(mode, button.buttonEl);
    }
}
