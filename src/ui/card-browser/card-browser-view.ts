import "src/ui/card-browser/card-browser-view.css";
import {
    ButtonComponent,
    DropdownComponent,
    ItemView,
    SearchComponent,
    setIcon,
    WorkspaceLeaf,
} from "obsidian";

import { CARD_BROWSER_VIEW_TYPE } from "src/data/constants";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import {
    CardBrowserFilter,
    CardBrowserRecord,
    CardBrowserSort,
    createCardBrowserRecords,
    filterCardBrowserRecords,
    getCardBrowserDeckNames,
    sortCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";

const PAGE_SIZE = 100;

function compactCardText(value: string): string {
    return value
        .replace(/<!--SR:[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export class CardBrowserView extends ItemView {
    private query = "";
    private filter: CardBrowserFilter = "all";
    private deck = "all";
    private sort: CardBrowserSort = "due";
    private notePath: string | null = null;
    private visibleLimit = PAGE_SIZE;
    private resultsEl: HTMLDivElement | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
    }

    getViewType(): string {
        return CARD_BROWSER_VIEW_TYPE;
    }

    getDisplayText(): string {
        return t("CARD_BROWSER");
    }

    getIcon(): string {
        return "library-big";
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass("sr-card-browser-view");
        this.render();
        return Promise.resolve();
    }

    refresh(): void {
        if (this.contentEl.isShown()) this.render();
    }

    setNoteScope(notePath: string | null): void {
        this.notePath = notePath;
        this.visibleLimit = PAGE_SIZE;
        this.render();
    }

    private getRecords(): CardBrowserRecord[] {
        if (!this.plugin.dataManager.isOsrCoreLoaded()) return [];
        return createCardBrowserRecords(this.plugin.dataManager.osrCore.getAllCards());
    }

    private render(): void {
        this.contentEl.empty();
        this.resultsEl = null;
        this.contentEl.addClass("sr-card-browser-view");

        const header = this.contentEl.createDiv("sr-card-browser-header");
        header.createEl("h2", { text: t("CARD_BROWSER") });
        new ButtonComponent(header)
            .setIcon("play")
            .setTooltip(t("START_REVIEW"))
            .onClick(
                () => void this.plugin.uiManager.openDeckContainer(FlashcardReviewMode.Review),
            );
        new ButtonComponent(header)
            .setIcon("plus")
            .setTooltip(t("CREATE_CARD"))
            .onClick(() => void this.plugin.uiManager.createStarterCardNote());

        const records = this.getRecords();
        if (!this.plugin.dataManager.isOsrCoreLoaded()) {
            this.renderEmpty(t("LOADING_CARDS"), "loader-circle", false);
            return;
        }
        if (records.length === 0) {
            this.renderEmpty(t("NO_CARDS_DESCRIPTION"), "layers", true);
            return;
        }

        const toolbar = this.contentEl.createDiv("sr-card-browser-toolbar");
        const searchWrapper = toolbar.createDiv("sr-card-browser-search");
        new SearchComponent(searchWrapper)
            .setPlaceholder(t("SEARCH_CARDS"))
            .setValue(this.query)
            .onChange((value) => {
                this.query = value;
                this.visibleLimit = PAGE_SIZE;
                this.renderResults(records);
            });
        new DropdownComponent(toolbar)
            .addOptions({
                all: t("ALL_CARDS"),
                new: t("NEW_CARDS"),
                due: t("DUE_CARDS"),
                scheduled: t("SCHEDULED_CARDS"),
            })
            .setValue(this.filter)
            .onChange((value) => {
                this.filter = value as CardBrowserFilter;
                this.visibleLimit = PAGE_SIZE;
                this.renderResults(records);
            });

        const deckDropdown = new DropdownComponent(toolbar).addOption("all", t("ALL_DECKS"));
        for (const deckName of getCardBrowserDeckNames(records)) {
            deckDropdown.addOption(deckName, deckName);
        }
        deckDropdown.setValue(this.deck).onChange((value) => {
            this.deck = value;
            this.visibleLimit = PAGE_SIZE;
            this.renderResults(records);
        });

        new DropdownComponent(toolbar)
            .addOptions({
                due: t("SORT_BY_DUE"),
                front: t("SORT_BY_FRONT"),
                note: t("SORT_BY_NOTE"),
            })
            .setValue(this.sort)
            .onChange((value) => {
                this.sort = value as CardBrowserSort;
                this.visibleLimit = PAGE_SIZE;
                this.renderResults(records);
            });

        if (this.notePath !== null) {
            const scope = this.contentEl.createDiv("sr-card-browser-scope");
            scope.createSpan({ text: t("CARDS_IN_NOTE", { note: this.notePath }) });
            new ButtonComponent(scope)
                .setIcon("x")
                .setTooltip(t("CLEAR_NOTE_FILTER"))
                .onClick(() => this.setNoteScope(null));
        }

        this.resultsEl = this.contentEl.createDiv("sr-card-browser-results");
        this.renderResults(records);
    }

    private renderResults(records: CardBrowserRecord[]): void {
        if (this.resultsEl === null) return;
        this.resultsEl.empty();

        const filtered = sortCardBrowserRecords(
            filterCardBrowserRecords(records, this.query, this.filter, this.deck, this.notePath),
            this.sort,
        );
        this.resultsEl.createDiv("sr-card-browser-summary").setText(
            t("CARD_BROWSER_COUNT", {
                shown: Math.min(filtered.length, this.visibleLimit),
                total: filtered.length,
            }),
        );

        if (filtered.length === 0) {
            this.renderEmpty(t("NO_CARDS_MATCH"), "search-x", false, this.resultsEl);
            return;
        }

        const list = this.resultsEl.createDiv("sr-card-browser-list");
        for (const record of filtered.slice(0, this.visibleLimit)) {
            this.renderCardRow(list, record);
        }
        if (filtered.length > this.visibleLimit) {
            new ButtonComponent(list)
                .setButtonText(t("LOAD_MORE_CARDS"))
                .setClass("sr-card-browser-load-more")
                .onClick(() => {
                    this.visibleLimit += PAGE_SIZE;
                    this.renderResults(records);
                });
        }
    }

    private renderEmpty(
        message: string,
        icon: string,
        showCreateButton: boolean,
        parent: HTMLElement = this.contentEl,
    ): void {
        const empty = parent.createDiv("sr-card-browser-empty");
        const iconEl = empty.createDiv("sr-card-browser-empty-icon");
        setIcon(iconEl, icon);
        empty.createEl("h3", { text: showCreateButton ? t("NO_CARDS_TITLE") : message });
        if (showCreateButton) empty.createEl("p", { text: message });
        if (showCreateButton) {
            new ButtonComponent(empty)
                .setButtonText(t("CREATE_FIRST_CARD"))
                .setCta()
                .onClick(() => void this.plugin.uiManager.createStarterCardNote());
        }
    }

    private renderCardRow(parent: HTMLElement, record: CardBrowserRecord): void {
        const row = parent.createEl("button", {
            cls: "sr-card-browser-row",
            attr: { type: "button", "aria-label": t("OPEN_SOURCE_NOTE") },
        });
        const main = row.createDiv("sr-card-browser-row-main");
        main.createDiv("sr-card-browser-front").setText(compactCardText(record.front));
        main.createDiv("sr-card-browser-back").setText(compactCardText(record.back));

        const meta = row.createDiv("sr-card-browser-row-meta");
        const state = meta.createSpan(`sr-card-browser-state is-${record.state}`);
        state.setText(this.getStateLabel(record));
        const location = [record.deckNames.join(", "), record.notePath].filter(Boolean).join(" · ");
        meta.createSpan("sr-card-browser-path").setText(location);
        row.addEventListener("click", () => void this.openSource(record));
    }

    private getStateLabel(record: CardBrowserRecord): string {
        if (record.state === "new") return t("NEW");
        if (record.state === "due") return t("DUE");
        return record.dueDate ?? t("SCHEDULED");
    }

    private async openSource(record: CardBrowserRecord): Promise<void> {
        const blockId = record.card.question.questionText.obsidianBlockId;
        const target = blockId ? `${record.notePath}#${blockId}` : record.notePath;
        await this.app.workspace.openLinkText(target, record.notePath, false);
    }
}
