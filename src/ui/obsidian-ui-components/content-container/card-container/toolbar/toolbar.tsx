import "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar.css";

import { Deck } from "src/data/data-structures/deck/deck";
import { t } from "src/lang/helpers";
import { DeckStats } from "src/scheduling/flashcard-review-sequencer";
import DeckInfoComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/deck-info/deck-info";
import BackButtonComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar-buttons/back-button";
import CardMenuButtonComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar-buttons/card-menu-button";
import EditButtonComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar-buttons/edit-button";
import ResetButtonComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar-buttons/reset-button";
import SkipButtonComponent from "src/ui/obsidian-ui-components/content-container/card-container/toolbar/toolbar-buttons/skip-button";
import SRButtonComponent from "src/ui/sr-button";

export default class CardToolbarComponent {
    private toolbar: HTMLDivElement;
    private infoSection: DeckInfoComponent;
    private resetButton: ResetButtonComponent;
    private undoButton: SRButtonComponent;
    private extendedMenuButton: CardMenuButtonComponent;
    private shortMenuButton: CardMenuButtonComponent;

    public constructor(
        parentEl: HTMLElement,
        showDeleteButton: boolean,
        deleteCurrentCard: () => void,
        backToDeckHandler: () => Promise<void>,
        editClickHandler: () => void,
        jumpToCurrentCard: () => Promise<void>,
        displayCurrentCardInfoNotice: () => void,
        buryCurrentCard: () => Promise<void>,
        skipCurrentCard: () => void,
        undoLastReview: () => Promise<void>,
        onOpenResetModalClick: () => void,
        closeModal?: () => void,
    ) {
        // Build ui
        this.toolbar = parentEl.createDiv();
        this.toolbar.addClass("sr-card-toolbar");
        const isModal = closeModal !== undefined;
        const iconButtonClasses = ["clickable-icon", "sr-toolbar-icon-button"];

        new BackButtonComponent(
            this.toolbar,
            async () => await backToDeckHandler(),
            iconButtonClasses,
        );

        this.undoButton = new SRButtonComponent(this.toolbar, {
            classNames: [...iconButtonClasses, "sr-undo-button", "sr-is-hidden"],
            icon: "undo-2",
            tooltip: t("UNDO_LAST_REVIEW"),
            onClick: () => undoLastReview(),
        });
        this.undoButton.setDisabled(true);

        const centerSpacer = this.toolbar.createDiv();
        centerSpacer.addClass("sr-flex-spacer");
        centerSpacer.addClass("sr-center-spacer");

        this.infoSection = new DeckInfoComponent(this.toolbar);

        this.toolbar.createDiv().addClass("sr-flex-spacer");

        new SRButtonComponent(this.toolbar, {
            classNames: [...iconButtonClasses, "sr-source-button"],
            icon: "file-output",
            tooltip: t("OPEN_SOURCE_NOTE"),
            onClick: async () => {
                await jumpToCurrentCard();
                closeModal?.();
            },
        });

        new EditButtonComponent(this.toolbar, editClickHandler, iconButtonClasses);

        this.resetButton = new ResetButtonComponent(
            this.toolbar,
            onOpenResetModalClick,
            iconButtonClasses,
        );
        this.resetButton.setDisabled(true);

        new SkipButtonComponent(this.toolbar, () => skipCurrentCard(), iconButtonClasses);

        this.toolbar.createDiv("sr-divider");

        this.shortMenuButton = new CardMenuButtonComponent(
            this.toolbar,
            false, // isExtended = false
            showDeleteButton,
            isModal,
            this.resetButton.disabled,
            deleteCurrentCard,
            editClickHandler,
            jumpToCurrentCard,
            displayCurrentCardInfoNotice,
            buryCurrentCard,
            skipCurrentCard,
            onOpenResetModalClick,
            closeModal,
            [...iconButtonClasses, "sr-short-menu-button"],
        );

        this.extendedMenuButton = new CardMenuButtonComponent(
            this.toolbar,
            true, // isExtended = true
            showDeleteButton,
            isModal,
            this.resetButton.disabled,
            deleteCurrentCard,
            editClickHandler,
            jumpToCurrentCard,
            displayCurrentCardInfoNotice,
            buryCurrentCard,
            skipCurrentCard,
            onOpenResetModalClick,
            closeModal,
            [...iconButtonClasses, "sr-extended-menu-button"],
        );

        // The back button is the predictable exit from study mode. A second close icon made
        // the mobile header crowded and duplicated Obsidian's own navigation affordances.
    }

    /**
     * Updates the deck info section
     * @param chosenDeck - The chosen deck
     * @param currentDeck - The current deck
     * @param chosenDeckStats - The stats of the chosen deck
     * @param currentDeckStats - The stats of the current deck
     * @param totalCardsInSession - The total number of cards in the session
     * @param totalDecksInSession - The total number of decks in the session
     * @param currentDeckTotalCardsInQueue - The total number of cards in the current deck
     * @param settings - The settings object
     */
    public updateInfo(
        chosenDeck: Deck,
        currentDeck: Deck,
        chosenDeckStats: DeckStats,
        currentDeckStats: DeckStats,
        totalCardsInSession: number,
        totalDecksInSession: number,
        currentDeckTotalCardsInQueue: number,
        flashcardCardOrder: string,
    ) {
        this.infoSection.updateInfo(
            chosenDeck.deckName,
            totalCardsInSession,
            totalCardsInSession - chosenDeckStats.cardsInQueueCount,
            totalDecksInSession,
            totalDecksInSession - chosenDeckStats.decksInQueueOfThisDeckCount,
            currentDeck.deckName,
            currentDeckTotalCardsInQueue,
            currentDeckTotalCardsInQueue - currentDeckStats.cardsInQueueOfThisDeckCount,
            flashcardCardOrder === "EveryCardRandomDeckAndCard",
        );
    }

    /**
     * Sets the reset button disabled state
     * @param disabled - The disabled state
     */
    public setResetButtonDisabled(disabled: boolean) {
        this.resetButton.buttonEl.toggleClass("mod-disabled", disabled);
        this.extendedMenuButton.setResetButtonDisabled(disabled);
        this.shortMenuButton.setResetButtonDisabled(disabled);
    }

    public setUndoAvailable(available: boolean): void {
        this.undoButton.setDisabled(!available);
        this.undoButton.buttonEl.toggleClass("sr-is-hidden", !available);
    }
}
