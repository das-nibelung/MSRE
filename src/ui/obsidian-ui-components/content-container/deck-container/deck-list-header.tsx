import "src/ui/obsidian-ui-components/content-container/deck-container/deck-list-header.css";
import { ButtonComponent, DropdownComponent, setIcon } from "obsidian";

import { t } from "src/lang/helpers";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import ModalCloseButtonComponent from "src/ui/obsidian-ui-components/content-container/modal-close-button";

export default class DeckListHeaderComponent {
    private header: HTMLDivElement;
    private deckIcon: HTMLElement;
    private title: HTMLDivElement;
    private reviewModeDropdown: DropdownComponent;

    public constructor(
        parentEl: HTMLElement,
        changeReviewMode: (reviewMode: FlashcardReviewMode) => void,
        openCardBrowser: () => void,
        closeModal?: () => void,
    ) {
        this.header = parentEl.createDiv();
        this.header.addClass("sr-deck-list-header");
        this.header.addClass("sr-header");

        this.deckIcon = this.header.createDiv();
        this.deckIcon.addClass("sr-deck-icon");
        setIcon(this.deckIcon, "layers");

        this.title = this.header.createDiv();
        this.title.addClass("sr-title");
        this.title.setText(t("DECKS"));

        this.header.createDiv().addClass("sr-flex-spacer");
        this.reviewModeDropdown = new DropdownComponent(this.header);
        const reviewModeOptions: Record<string, string> = {
            Review: t("REVIEW_MODE"),
            Cram: t("CRAM_MODE"),
        };
        this.reviewModeDropdown.addOptions(reviewModeOptions);
        this.reviewModeDropdown.setValue("Review");

        this.reviewModeDropdown.onChange((value) => {
            if (value === undefined) return;
            if (value === "Review") changeReviewMode(FlashcardReviewMode.Review);
            if (value === "Cram") changeReviewMode(FlashcardReviewMode.Cram);
        });

        new ButtonComponent(this.header)
            .setIcon("library-big")
            .setTooltip(t("BROWSE_CARDS"))
            .onClick(openCardBrowser);

        if (closeModal !== undefined) {
            new ModalCloseButtonComponent(this.header, closeModal, ["sr-deck-close-button"]);
        }
    }

    public updateReviewMode(reviewMode: FlashcardReviewMode) {
        this.reviewModeDropdown.setValue(
            reviewMode === FlashcardReviewMode.Review ? "Review" : "Cram",
        );
    }
}
