import "src/ui/obsidian-ui-components/content-container/deck-container/deck-list.css";
import { ButtonComponent, setIcon } from "obsidian";

import { Deck } from "src/data/data-structures/deck/deck";
import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import { DeckStats, IFlashcardReviewSequencer } from "src/scheduling/flashcard-review-sequencer";

export default class DeckListComponent {
    private scrollWrapper: HTMLDivElement;
    private content: HTMLDivElement;
    private overview: HTMLDivElement;
    private treeContainer: HTMLDivElement;

    private treeHeaderRow: HTMLDivElement;
    private treeHeaderRowSelf: HTMLDivElement;
    private treeHeaderRowInner: HTMLDivElement;
    private treeHeaderRowText: HTMLDivElement;
    private treeHeaderRowTextSpan: HTMLSpanElement;
    private treeHeaderRowNumbersWrapper: HTMLDivElement;

    private dueCardsText: HTMLDivElement;
    private newCardsText: HTMLDivElement;
    private reviewedCardsText: HTMLDivElement;
    private totalCardsText: HTMLDivElement;

    private startReviewOfDeck: (deck: Deck) => void;
    private openCardBrowser: () => void | Promise<void>;
    private createCard: () => void;

    public constructor(
        parentEl: HTMLElement,
        startReviewOfDeck: (deck: Deck) => void,
        openCardBrowser: () => void | Promise<void>,
        createCard: () => void,
    ) {
        this.startReviewOfDeck = startReviewOfDeck;
        this.openCardBrowser = openCardBrowser;
        this.createCard = createCard;
        // Prep main container
        this.scrollWrapper = parentEl.createDiv();
        this.scrollWrapper.addClass("sr-scroll-wrapper");

        this.content = this.scrollWrapper.createDiv();
        this.content.addClass("sr-content");

        this.overview = this.content.createDiv("sr-deck-overview");

        // Prep header row
        this.treeHeaderRow = this.content.createDiv();
        this.treeHeaderRow.addClass("sr-tree-row");
        this.treeHeaderRow.addClass("sr-header-row");
        this.treeHeaderRow.addClass("tree-item");
        this.treeHeaderRow.addClass("sr-tree-item-container");

        this.treeHeaderRowSelf = this.treeHeaderRow.createDiv();
        this.treeHeaderRowSelf.addClass("tree-item-self");
        this.treeHeaderRowSelf.addClass("sr-tree-item-row");

        this.treeHeaderRowInner = this.treeHeaderRowSelf.createDiv("tree-item-inner");
        this.treeHeaderRowText = this.treeHeaderRowInner.createDiv("tag-pane-tag-text");
        this.treeHeaderRowTextSpan = this.treeHeaderRowText.createSpan("tag-pane-tag-self");
        this.treeHeaderRowTextSpan.addClass("sr-tree-row-text");
        this.treeHeaderRowTextSpan.setText(t("DECKS"));

        this.treeHeaderRowNumbersWrapper = this.treeHeaderRowSelf.createDiv();
        this.treeHeaderRowNumbersWrapper.addClasses([
            "tree-item-flair-outer",
            "sr-tree-stats-container",
        ]);
        this.treeHeaderRowNumbersWrapper.addClass("sr-tree-row-numbers-wrapper");
        this.treeHeaderRowNumbersWrapper.addClass("sr-tree-stats-container");

        this.dueCardsText = this.treeHeaderRowNumbersWrapper.createDiv();
        this.dueCardsText.addClass("sr-tree-numbers-text");
        this.dueCardsText.addClasses([
            "tag-pane-tag-count",
            "tree-item-flair",
            "sr-tree-stats-count",
            "sr-stat-due",
        ]);
        this.dueCardsText.setText(t("DUE"));

        this.newCardsText = this.treeHeaderRowNumbersWrapper.createDiv();
        this.newCardsText.addClass("sr-tree-numbers-text");
        this.newCardsText.addClasses([
            "tag-pane-tag-count",
            "tree-item-flair",
            "sr-tree-stats-count",
            "sr-stat-new",
        ]);
        this.newCardsText.setText(t("NEW"));

        this.reviewedCardsText = this.treeHeaderRowNumbersWrapper.createDiv();
        this.reviewedCardsText.addClass("sr-tree-numbers-text");
        this.reviewedCardsText.addClasses([
            "tag-pane-tag-count",
            "tree-item-flair",
            "sr-tree-stats-count",
            "sr-stat-seen",
        ]);
        this.reviewedCardsText.setText(t("SEEN"));

        this.totalCardsText = this.treeHeaderRowNumbersWrapper.createDiv();
        this.totalCardsText.addClass("sr-tree-numbers-text");
        this.totalCardsText.addClasses([
            "tag-pane-tag-count",
            "tree-item-flair",
            "sr-tree-stats-count",
            "sr-stat-total",
        ]);
        this.totalCardsText.setText(t("TOTAL"));

        // Prep tree container
        this.treeContainer = this.content.createDiv("sr-tree-container");
    }

    /**
     * Redraws the deck list.
     * @param startReviewOfDeck - Callback for starting the review of a deck.
     * @param settings - The settings object.
     * @param reviewSequencer - The review sequencer object.
     */
    redraw(reviewSequencer: IFlashcardReviewSequencer, settings: SRSettings) {
        this.overview.empty();
        this.treeContainer.empty();

        const originDeckStats = reviewSequencer.getDeckStats(
            reviewSequencer.originalDeckTree.getTopicPath(),
        );

        if (originDeckStats.totalCount === 0) {
            this.overview.addClass("sr-is-hidden");
            this.treeHeaderRow.toggleClass(
                "sr-is-hidden",
                reviewSequencer.originalDeckTree.subdecks.length === 0,
            );
            const emptyState = this.treeContainer.createDiv("sr-deck-empty-state");
            const icon = emptyState.createDiv("sr-deck-empty-state-icon");
            setIcon(icon, "layers-3");
            emptyState.createEl("h3", { text: t("NO_CARDS_TITLE") });
            emptyState.createEl("p", { text: t("NO_CARDS_DESCRIPTION") });

            const actions = emptyState.createDiv("sr-deck-empty-state-actions");
            new ButtonComponent(actions)
                .setButtonText(t("CREATE_FIRST_CARD"))
                .setCta()
                .onClick(this.createCard);
            new ButtonComponent(actions)
                .setButtonText(t("BROWSE_CARDS"))
                .onClick(this.openCardBrowser);
            for (const subdeck of reviewSequencer.originalDeckTree.subdecks) {
                this._createTree(
                    subdeck,
                    this.treeContainer,
                    reviewSequencer,
                    settings,
                    this.startReviewOfDeck,
                );
            }
            return;
        }

        this.overview.removeClass("sr-is-hidden");
        this.treeHeaderRow.removeClass("sr-is-hidden");
        this.renderOverview(reviewSequencer.originalDeckTree, originDeckStats);
        this.treeContainer.toggleClass(
            "has-no-subdecks",
            reviewSequencer.originalDeckTree.subdecks.length === 0,
        );

        for (const subdeck of reviewSequencer.originalDeckTree.subdecks) {
            // Create the tree row for each deck
            this._createTree(
                subdeck,
                this.treeContainer,
                reviewSequencer,
                settings,
                this.startReviewOfDeck,
            );
        }
    }

    private renderOverview(deck: Deck, stats: DeckStats): void {
        const copy = this.overview.createDiv("sr-deck-overview-copy");
        copy.createDiv({ cls: "sr-deck-overview-eyebrow", text: t("READY_TO_REVIEW") });
        copy.createEl("h2", {
            cls: "sr-deck-overview-title",
            text: t("CARDS_READY", { count: stats.cardsInQueueCount }),
        });

        const details = copy.createDiv("sr-deck-overview-details");
        details.createSpan({ text: `${t("DUE")}: ${stats.dueCount}` });
        details.createSpan({ text: `${t("NEW_CARDS")}: ${stats.newCount}` });
        details.createSpan({
            text: t("DECKS_READY", { count: stats.decksInQueueOfThisDeckCount }),
        });

        const startButton = new ButtonComponent(this.overview)
            .setButtonText(t("START_REVIEW"))
            .setCta()
            .onClick(() => this.startReviewOfDeck(deck));
        const startIcon = activeDocument.createElement("span");
        setIcon(startIcon, "play");
        startButton.buttonEl.prepend(startIcon);
        startButton.buttonEl.addClass("sr-deck-overview-start");
        startButton.setDisabled(stats.cardsInQueueCount === 0);
    }

    private _createTree(
        deck: Deck,
        parentEl: HTMLDivElement,
        reviewSequencer: IFlashcardReviewSequencer,
        settings: SRSettings,
        startReviewOfDeck: (deck: Deck) => void,
    ) {
        const deckStats = reviewSequencer.getDeckStats(deck.getTopicPath());

        // Create the tree row for the deck
        const treeRowChildren = this._crateTreeRow(
            deck.deckName,
            deckStats,
            deck.subdecks.length,
            parentEl,
            settings.initiallyExpandAllSubdecksInTree,
            deck,
            startReviewOfDeck,
        );

        for (const subdeck of deck.subdecks) {
            // Create the tree row for each subdeck
            this._createTree(
                subdeck,
                treeRowChildren,
                reviewSequencer,
                settings,
                startReviewOfDeck,
            );
        }
    }

    private _crateTreeRow(
        deckName: string,
        deckStats: DeckStats,
        numOfSubdecks: number,
        parentEl: HTMLDivElement,
        initiallyExpanded: boolean = false,
        deck: Deck | null = null,
        startReviewOfDeck: (deck: Deck) => void = () => {},
    ): HTMLDivElement {
        const disableInteraction = deck === null;
        const hasSubdecks = numOfSubdecks > 0;
        const treeRow = parentEl.createDiv();
        treeRow.addClass("sr-tree-row");
        treeRow.addClass("tree-item");
        treeRow.addClass("sr-tree-item-container");

        const treeRowSelf = treeRow.createDiv();
        treeRowSelf.addClass("tree-item-self");
        if (!disableInteraction) {
            treeRowSelf.addClass("tag-pane-tag");
        }
        treeRowSelf.addClass("sr-tree-item-row");

        let collapsed = !initiallyExpanded;
        const collapseIconEl = treeRowSelf.createDiv("tree-item-icon collapse-icon");
        setIcon(collapseIconEl, "chevron-down");
        if (collapsed) collapseIconEl.addClass("is-collapsed");
        if (numOfSubdecks === 0) collapseIconEl.setCssProps({ display: "none" });

        const treeRowInner: HTMLElement = treeRowSelf.createDiv("tree-item-inner");
        const deckIcon = treeRowInner.createDiv("sr-deck-row-icon");
        setIcon(deckIcon, hasSubdecks ? "folders" : "folder");
        const treeRowInnerText: HTMLElement = treeRowInner.createDiv("tag-pane-tag-text");
        const treeRowInnerTextSpan: HTMLElement = treeRowInnerText.createSpan({
            cls: "tag-pane-tag-self sr-deck-row-title",
        });
        treeRowInnerTextSpan.setText(deckName);
        treeRowInnerText.createDiv({
            cls: "sr-deck-row-subtitle",
            text: `${t("DUE")}: ${deckStats.dueCount} · ${t("NEW_CARDS")}: ${deckStats.newCount}`,
        });

        const treeRowOuter: HTMLDivElement = treeRowSelf.createDiv();
        treeRowOuter.addClasses(["tree-item-flair-outer", "sr-tree-stats-container"]);

        const treeRowChildren: HTMLDivElement = treeRow.createDiv("tree-item-children");
        treeRowChildren.setCssProps({ display: collapsed ? "none" : "block" });

        const canStartReview =
            !disableInteraction && (deckStats.dueCount > 0 || deckStats.newCount > 0);

        const toggleSubdecks = () => {
            if (!hasSubdecks) return;
            collapsed = !collapsed;
            collapseIconEl.toggleClass("is-collapsed", collapsed);
            collapseIconEl.setAttribute("aria-expanded", String(!collapsed));
            treeRowChildren.setCssProps({ display: collapsed ? "none" : "block" });
        };

        if (hasSubdecks) {
            collapseIconEl.setAttribute("role", "button");
            collapseIconEl.setAttribute("tabindex", "0");
            collapseIconEl.setAttribute("aria-expanded", String(!collapsed));
            collapseIconEl.setAttribute("aria-label", deckName);
            collapseIconEl.addEventListener("click", (event) => {
                event.stopPropagation();
                toggleSubdecks();
            });
            collapseIconEl.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                toggleSubdecks();
            });
        }

        if (!canStartReview) {
            if (!disableInteraction) {
                treeRowSelf.addClass("is-disabled");
                treeRowSelf.setAttribute("aria-disabled", "true");
            }
        } else {
            treeRowSelf.addClass("is-clickable");
            treeRowSelf.setAttribute("role", "button");
            treeRowSelf.setAttribute("tabindex", "0");
            treeRowSelf.setAttribute(
                "aria-label",
                `${deckName}. ${t("DUE_CARDS")}: ${deckStats.dueCount}. ${t("NEW_CARDS")}: ${deckStats.newCount}.`,
            );
        }

        // Add the click handler to treeRowSelf instead of treeRowInner so that it activates
        // over the entire rectangle of the tree item, not just the text of the topic name
        // https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/709

        if (canStartReview) {
            treeRowSelf.addEventListener("click", () => {
                startReviewOfDeck(deck);
            });
            treeRowSelf.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                startReviewOfDeck(deck);
            });
        }

        this._createStatsInRow(treeRowOuter, deckStats);
        if (canStartReview) {
            const goIcon = treeRowSelf.createDiv("sr-deck-row-go");
            setIcon(goIcon, "chevron-right");
            goIcon.setAttribute("aria-hidden", "true");
        }
        return treeRowChildren;
    }

    private _createStatsInRow(parentEl: HTMLDivElement, deckStats: DeckStats) {
        parentEl.empty();

        this._createStatsContainer(t("DUE_CARDS"), deckStats.dueCount, "sr-stat-due", parentEl);
        this._createStatsContainer(t("NEW_CARDS"), deckStats.newCount, "sr-stat-new", parentEl);
        const reviewedCards: number =
            deckStats.totalCount - deckStats.newCount - deckStats.dueCount;
        this._createStatsContainer(t("SEEN_CARDS"), reviewedCards, "sr-stat-seen", parentEl);
        this._createStatsContainer(
            t("TOTAL_CARDS"),
            deckStats.totalCount,
            "sr-stat-total",
            parentEl,
        );
    }

    private _createStatsContainer(
        statsLable: string,
        statsNumber: number,
        statsClass: string,
        statsWrapper: HTMLDivElement,
    ): void {
        const statsContainer = statsWrapper.createDiv();

        statsContainer.ariaLabel = statsLable;

        statsContainer.addClasses([
            "tag-pane-tag-count",
            "tree-item-flair",
            "sr-tree-stats-count",
            statsClass,
        ]);

        statsContainer.setText(statsNumber.toString());
    }
}
