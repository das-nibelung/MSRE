import "src/ui/obsidian-ui-components/content-container/deck-container/deck-list.css";
import { ButtonComponent, Menu, SearchComponent, setIcon } from "obsidian";

import { Deck } from "src/data/data-structures/deck/deck";
import { NativeCardStore, normalizeManagedDeckPath } from "src/data/native-card-store";
import { KnowledgeArea } from "src/data/plugin-data";
import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import type SRPlugin from "src/main";
import { DeckStats, IFlashcardReviewSequencer } from "src/scheduling/flashcard-review-sequencer";

interface KnowledgeAreaGroup {
    area: KnowledgeArea | null;
    name: string;
    decks: Deck[];
    pinned: boolean;
}

export default class DeckListComponent {
    private scrollWrapper: HTMLDivElement;
    private content: HTMLDivElement;
    private overview: HTMLDivElement;
    private organization: HTMLDivElement;
    private areaSummary: HTMLSpanElement;
    private treeContainer: HTMLDivElement;
    private searchQuery = "";
    private currentReviewSequencer: IFlashcardReviewSequencer | null = null;
    private currentSettings: SRSettings | null = null;
    private readonly store: NativeCardStore;

    private readonly startReviewOfDeck: (deck: Deck) => void;
    private readonly openCardBrowser: () => void | Promise<void>;
    private readonly createCard: (deckPath?: string) => void;
    private readonly createDeck: (deckPath?: string, areaId?: string) => void;
    private readonly editKnowledgeArea: (areaId?: string) => void;

    public constructor(
        parentEl: HTMLElement,
        startReviewOfDeck: (deck: Deck) => void,
        openCardBrowser: () => void | Promise<void>,
        createCard: (deckPath?: string) => void,
        createDeck: (deckPath?: string, areaId?: string) => void,
        editKnowledgeArea: (areaId?: string) => void,
        plugin: SRPlugin,
    ) {
        this.startReviewOfDeck = startReviewOfDeck;
        this.openCardBrowser = openCardBrowser;
        this.createCard = createCard;
        this.createDeck = createDeck;
        this.editKnowledgeArea = editKnowledgeArea;
        this.store = new NativeCardStore(plugin);

        this.scrollWrapper = parentEl.createDiv("sr-scroll-wrapper");
        this.content = this.scrollWrapper.createDiv("sr-content");
        this.overview = this.content.createDiv("sr-deck-overview");

        this.organization = this.content.createDiv("sr-deck-organization");
        const heading = this.organization.createDiv("sr-deck-organization-heading");
        const headingCopy = heading.createDiv();
        headingCopy.createEl("h2", { text: t("KNOWLEDGE_AREAS") });
        this.areaSummary = headingCopy.createSpan();
        const addArea = new ButtonComponent(heading)
            .setIcon("plus")
            .setTooltip(t("NEW_KNOWLEDGE_AREA"))
            .onClick(() => this.editKnowledgeArea());
        addArea.buttonEl.addClass("sr-add-area-button");

        const searchWrapper = this.organization.createDiv("sr-deck-search");
        new SearchComponent(searchWrapper).setPlaceholder(t("SEARCH_DECKS")).onChange((value) => {
            this.searchQuery = value.trim().toLocaleLowerCase();
            this.redrawCurrent();
        });

        this.treeContainer = this.content.createDiv("sr-knowledge-area-list");
    }

    redraw(reviewSequencer: IFlashcardReviewSequencer, settings: SRSettings): void {
        this.currentReviewSequencer = reviewSequencer;
        this.currentSettings = settings;
        this.overview.empty();
        this.treeContainer.empty();

        const root = reviewSequencer.originalDeckTree;
        const rootStats = reviewSequencer.getDeckStats(root.getTopicPath());
        const groups = this.buildAreaGroups(root.subdecks).filter((group) =>
            this.groupMatchesSearch(group),
        );
        this.areaSummary.setText(
            t("KNOWLEDGE_AREAS_SUMMARY", { count: this.store.getKnowledgeAreas().length }),
        );

        if (rootStats.totalCount === 0) this.overview.addClass("sr-is-hidden");
        else {
            this.overview.removeClass("sr-is-hidden");
            this.renderOverview(root, rootStats);
        }

        for (const group of groups) this.renderKnowledgeArea(group, reviewSequencer, settings);
        if (groups.length === 0) {
            if (this.searchQuery) this.renderSearchEmpty();
            else this.renderEmptyState(root.subdecks.length === 0);
        }
    }

    private redrawCurrent(): void {
        if (this.currentReviewSequencer && this.currentSettings) {
            this.redraw(this.currentReviewSequencer, this.currentSettings);
        }
    }

    private buildAreaGroups(decks: Deck[]): KnowledgeAreaGroup[] {
        const areas = this.store.getKnowledgeAreas();
        const assigned = new Set<string>();
        const groups: KnowledgeAreaGroup[] = areas.map((area) => {
            const paths = new Set(area.deckPaths.map(normalizeManagedDeckPath));
            const areaDecks = decks.filter((deck) => {
                const path = this.getVisibleDeckPath(deck);
                if (!paths.has(path)) return false;
                assigned.add(path);
                return true;
            });
            return { area, name: area.name, decks: areaDecks, pinned: area.pinned };
        });
        const unassigned = decks.filter((deck) => !assigned.has(this.getVisibleDeckPath(deck)));
        if (unassigned.length > 0) {
            groups.push({
                area: null,
                name: t("UNASSIGNED_DECKS"),
                decks: unassigned,
                pinned: false,
            });
        }
        return groups.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    }

    private groupMatchesSearch(group: KnowledgeAreaGroup): boolean {
        if (!this.searchQuery) return true;
        if (group.name.toLocaleLowerCase().includes(this.searchQuery)) return true;
        return group.decks.some((deck) => this.deckMatchesSearch(deck));
    }

    private deckMatchesSearch(deck: Deck): boolean {
        if (deck.deckName.toLocaleLowerCase().includes(this.searchQuery)) return true;
        return deck.subdecks.some((child) => this.deckMatchesSearch(child));
    }

    private renderKnowledgeArea(
        group: KnowledgeAreaGroup,
        sequencer: IFlashcardReviewSequencer,
        settings: SRSettings,
    ): void {
        const areaEl = this.treeContainer.createDiv("sr-knowledge-area-card");
        areaEl.toggleClass("is-pinned", group.pinned);
        const header = areaEl.createDiv("sr-knowledge-area-header");
        const icon = header.createDiv("sr-knowledge-area-icon");
        setIcon(icon, group.pinned ? "pin" : "library-big");
        const copy = header.createDiv("sr-knowledge-area-copy");
        copy.createEl("h3", { text: group.name });
        copy.createSpan({ text: t("AREA_DECKS_SUMMARY", { count: group.decks.length }) });

        const actions = header.createDiv("sr-knowledge-area-actions");
        if (group.area) {
            const area = group.area;
            const menuButton = new ButtonComponent(actions)
                .setIcon("ellipsis")
                .setTooltip(t("MORE_ACTIONS"))
                .onClick((event) => this.openAreaMenu(event, area));
            menuButton.buttonEl.addClass("sr-area-menu-button");
        }
        let collapsed = false;
        const collapse = new ButtonComponent(actions)
            .setIcon("chevron-down")
            .setTooltip(group.name)
            .onClick(() => {
                collapsed = !collapsed;
                areaEl.toggleClass("is-collapsed", collapsed);
                collapse.buttonEl.setAttribute("aria-expanded", String(!collapsed));
            });
        collapse.buttonEl.addClass("sr-area-collapse-button");
        collapse.buttonEl.setAttribute("aria-expanded", "true");

        const body = areaEl.createDiv("sr-knowledge-area-body");
        if (group.decks.length === 0) {
            const empty = body.createDiv("sr-area-empty");
            empty.createSpan({ text: t("AREA_EMPTY") });
            if (group.area) {
                const area = group.area;
                new ButtonComponent(empty)
                    .setButtonText(t("NEW_DECK_IN_AREA"))
                    .onClick(() => this.createDeck(undefined, area.id));
            }
            return;
        }
        for (const deck of group.decks) {
            if (this.searchQuery && !this.deckMatchesSearch(deck)) continue;
            this.createDeckTree(deck, body, sequencer, settings, group.area, 0);
        }
    }

    private createDeckTree(
        deck: Deck,
        parent: HTMLDivElement,
        sequencer: IFlashcardReviewSequencer,
        settings: SRSettings,
        area: KnowledgeArea | null,
        depth: number,
    ): void {
        const stats = sequencer.getDeckStats(deck.getTopicPath());
        const hasChildren = deck.subdecks.length > 0;
        const row = parent.createDiv("sr-tree-row tree-item sr-tree-item-container");
        row.addClass(depth === 0 ? "sr-area-deck" : "sr-nested-deck");
        const rowSelf = row.createDiv("tree-item-self tag-pane-tag sr-tree-item-row");
        const children = row.createDiv("tree-item-children");
        let collapsed = !(settings.initiallyExpandAllSubdecksInTree || this.searchQuery);

        const collapseIcon = rowSelf.createDiv("tree-item-icon collapse-icon");
        setIcon(collapseIcon, "chevron-down");
        collapseIcon.toggleClass("is-collapsed", collapsed);
        if (!hasChildren) collapseIcon.addClass("is-placeholder");
        else {
            collapseIcon.setAttribute("role", "button");
            collapseIcon.setAttribute("tabindex", "0");
            collapseIcon.setAttribute("aria-expanded", String(!collapsed));
            const toggle = (event: Event): void => {
                event.preventDefault();
                event.stopPropagation();
                collapsed = !collapsed;
                collapseIcon.toggleClass("is-collapsed", collapsed);
                collapseIcon.setAttribute("aria-expanded", String(!collapsed));
                children.setCssProps({ display: collapsed ? "none" : "block" });
            };
            collapseIcon.addEventListener("click", toggle);
            collapseIcon.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") toggle(event);
            });
        }

        const inner = rowSelf.createDiv("tree-item-inner");
        const deckIcon = inner.createDiv("sr-deck-row-icon");
        setIcon(deckIcon, hasChildren ? "folders" : "folder");
        const text = inner.createDiv("tag-pane-tag-text");
        text.createSpan({ cls: "tag-pane-tag-self sr-deck-row-title", text: deck.deckName });
        text.createDiv({
            cls: "sr-deck-row-subtitle",
            text: `${t("DUE")}: ${stats.dueCount} · ${t("NEW_CARDS")}: ${stats.newCount}`,
        });

        const statsEl = rowSelf.createDiv("tree-item-flair-outer sr-tree-stats-container");
        this.createStats(statsEl, stats);
        const deckPath = this.getVisibleDeckPath(deck);
        const menuButton = new ButtonComponent(rowSelf)
            .setIcon("ellipsis")
            .setTooltip(t("MORE_ACTIONS"))
            .onClick((event) => {
                event.stopPropagation();
                this.openDeckMenu(event, deckPath, area, depth === 0);
            });
        menuButton.buttonEl.addClass("sr-deck-menu-button");

        const canReview = stats.dueCount > 0 || stats.newCount > 0;
        const go = rowSelf.createDiv("sr-deck-row-go");
        if (canReview) setIcon(go, "chevron-right");
        else go.addClass("is-placeholder");
        rowSelf.toggleClass("is-clickable", canReview);
        rowSelf.toggleClass("is-disabled", !canReview);
        if (canReview) {
            rowSelf.setAttribute("role", "button");
            rowSelf.setAttribute("tabindex", "0");
            rowSelf.addEventListener("click", () => this.startReviewOfDeck(deck));
            rowSelf.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                this.startReviewOfDeck(deck);
            });
        }

        children.setCssProps({ display: collapsed ? "none" : "block" });
        for (const child of deck.subdecks) {
            if (this.searchQuery && !this.deckMatchesSearch(child)) continue;
            this.createDeckTree(child, children, sequencer, settings, area, depth + 1);
        }
    }

    private openAreaMenu(event: MouseEvent, area: KnowledgeArea): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(area.pinned ? t("UNPIN_AREA") : t("PIN_AREA"))
                .setIcon(area.pinned ? "pin-off" : "pin")
                .onClick(() => void this.updateAreaPin(area)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("RENAME_AREA"))
                .setIcon("pencil")
                .onClick(() => this.editKnowledgeArea(area.id)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("NEW_DECK_IN_AREA"))
                .setIcon("folder-plus")
                .onClick(() => this.createDeck(undefined, area.id)),
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(t("REMOVE_AREA"))
                .setIcon("trash-2")
                .onClick(() => void this.removeArea(area.id)),
        );
        menu.showAtMouseEvent(event);
    }

    private openDeckMenu(
        event: MouseEvent,
        deckPath: string,
        currentArea: KnowledgeArea | null,
        allowAreaMove: boolean,
    ): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(t("NEW_CARD"))
                .setIcon("square-pen")
                .onClick(() => this.createCard(deckPath)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("NEW_DECK"))
                .setIcon("folder-plus")
                .onClick(() => this.createDeck(`${deckPath}/`, currentArea?.id)),
        );
        if (allowAreaMove) {
            menu.addSeparator();
            for (const area of this.store.getKnowledgeAreas()) {
                menu.addItem((item) =>
                    item
                        .setTitle(`${t("MOVE_TO_AREA")}: ${area.name}`)
                        .setIcon(area.id === currentArea?.id ? "check" : "library-big")
                        .setDisabled(area.id === currentArea?.id)
                        .onClick(() => void this.moveDeck(deckPath, area.id)),
                );
            }
            if (currentArea) {
                menu.addItem((item) =>
                    item
                        .setTitle(t("UNASSIGNED_DECKS"))
                        .setIcon("undo-2")
                        .onClick(() => void this.unassignDeck(deckPath)),
                );
            }
        }
        menu.showAtMouseEvent(event);
    }

    private async updateAreaPin(area: KnowledgeArea): Promise<void> {
        await this.store.setKnowledgeAreaPinned(area.id, !area.pinned);
        this.redrawCurrent();
    }

    private async removeArea(id: string): Promise<void> {
        await this.store.removeKnowledgeArea(id);
        this.redrawCurrent();
    }

    private async moveDeck(deckPath: string, areaId: string): Promise<void> {
        await this.store.assignDeckToKnowledgeArea(deckPath, areaId);
        this.redrawCurrent();
    }

    private async unassignDeck(deckPath: string): Promise<void> {
        await this.store.unassignDeckFromKnowledgeAreas(deckPath);
        this.redrawCurrent();
    }

    private getVisibleDeckPath(deck: Deck): string {
        const fullPath = deck.getTopicPath().path;
        const rootTag = this.currentSettings?.flashcardTags[0] ?? "#flashcards";
        const rootPath = rootTag.replace(/^#/, "").split("/").filter(Boolean);
        const atRoot = rootPath.every((segment, index) => fullPath[index] === segment);
        return normalizeManagedDeckPath(
            (atRoot ? fullPath.slice(rootPath.length) : fullPath).join("/"),
        );
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
        const start = new ButtonComponent(this.overview)
            .setButtonText(t("START_REVIEW"))
            .setCta()
            .setDisabled(stats.cardsInQueueCount === 0)
            .onClick(() => this.startReviewOfDeck(deck));
        const startIcon = activeDocument.createElement("span");
        setIcon(startIcon, "play");
        start.buttonEl.prepend(startIcon);
        start.buttonEl.addClass("sr-deck-overview-start");
    }

    private createStats(parent: HTMLElement, stats: DeckStats): void {
        const values: [string, number, string][] = [
            [t("DUE_CARDS"), stats.dueCount, "sr-stat-due"],
            [t("NEW_CARDS"), stats.newCount, "sr-stat-new"],
            [t("SEEN_CARDS"), stats.totalCount - stats.newCount - stats.dueCount, "sr-stat-seen"],
            [t("TOTAL_CARDS"), stats.totalCount, "sr-stat-total"],
        ];
        for (const [label, value, className] of values) {
            parent.createDiv({
                cls: `tag-pane-tag-count tree-item-flair sr-tree-stats-count ${className}`,
                text: String(value),
                attr: { "aria-label": label },
            });
        }
    }

    private renderSearchEmpty(): void {
        const empty = this.treeContainer.createDiv("sr-deck-search-empty");
        const icon = empty.createDiv();
        setIcon(icon, "search-x");
        empty.createSpan({ text: t("NO_DECKS_MATCH") });
    }

    private renderEmptyState(showActions: boolean): void {
        const empty = this.treeContainer.createDiv("sr-deck-empty-state");
        const icon = empty.createDiv("sr-deck-empty-state-icon");
        setIcon(icon, "layers-3");
        empty.createEl("h3", { text: t("NO_CARDS_TITLE") });
        empty.createEl("p", { text: t("NO_CARDS_DESCRIPTION") });
        if (!showActions) return;
        const actions = empty.createDiv("sr-deck-empty-state-actions");
        new ButtonComponent(actions)
            .setButtonText(t("CREATE_FIRST_CARD"))
            .setCta()
            .onClick(() => this.createCard());
        new ButtonComponent(actions).setButtonText(t("BROWSE_CARDS")).onClick(this.openCardBrowser);
    }
}
