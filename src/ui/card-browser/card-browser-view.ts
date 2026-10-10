import "src/ui/card-browser/card-browser-view.css";
import {
    ButtonComponent,
    DropdownComponent,
    ItemView,
    Menu,
    SearchComponent,
    setIcon,
    TFile,
    WorkspaceLeaf,
} from "obsidian";

import { CARD_BROWSER_VIEW_TYPE } from "src/data/constants";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { editCardFromBrowser, resetCardProgress, resetCardsProgress } from "src/ui/card-actions";
import {
    CardBrowserFilter,
    CardBrowserRecord,
    CardBrowserSort,
    createCardBrowserRecords,
    filterCardBrowserRecords,
    getCardBrowserDeckNames,
    sortCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";

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
    private selectionBarEl: HTMLDivElement | null = null;
    private records: CardBrowserRecord[] = [];
    private selectedIds = new Set<string>();

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
        this.selectionBarEl = null;
        this.contentEl.addClass("sr-card-browser-view");

        const header = this.contentEl.createDiv("sr-card-browser-header");
        header.createEl("h2", { text: t("CARD_BROWSER") });
        new ButtonComponent(header)
            .setIcon("play")
            .setTooltip(this.notePath === null ? t("START_REVIEW") : t("REVIEW_CARDS_IN_NOTE"))
            .onClick(() => void this.startReview());
        new ButtonComponent(header)
            .setIcon("plus")
            .setTooltip(t("CREATE_CARD"))
            .onClick(() => void this.plugin.uiManager.createStarterCardNote());

        const records = this.getRecords();
        this.records = records;
        const recordIds = new Set(records.map((record) => record.id));
        this.selectedIds = new Set([...this.selectedIds].filter((id) => recordIds.has(id)));
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
                interval: t("SORT_BY_INTERVAL"),
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
        const summary = this.resultsEl.createDiv("sr-card-browser-summary");
        summary.createSpan({
            text: t("CARD_BROWSER_COUNT", {
                shown: Math.min(filtered.length, this.visibleLimit),
                total: filtered.length,
            }),
        });
        const allResultsSelected =
            filtered.length > 0 && filtered.every((record) => this.selectedIds.has(record.id));
        new ButtonComponent(summary)
            .setButtonText(allResultsSelected ? t("DESELECT_ALL_RESULTS") : t("SELECT_ALL_RESULTS"))
            .setDisabled(filtered.length === 0)
            .onClick(() => {
                for (const record of filtered) {
                    if (allResultsSelected) this.selectedIds.delete(record.id);
                    else this.selectedIds.add(record.id);
                }
                this.renderResults(records);
            });

        this.selectionBarEl = this.resultsEl.createDiv("sr-card-browser-selection-bar");
        this.renderSelectionBar();

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
        const row = parent.createDiv({
            cls: "sr-card-browser-row",
        });
        const checkbox = row.createEl("input", {
            cls: "sr-card-browser-checkbox",
            attr: { type: "checkbox", "aria-label": t("SELECT_CARD") },
        });
        checkbox.checked = this.selectedIds.has(record.id);
        checkbox.addEventListener("click", (event) => event.stopPropagation());
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selectedIds.add(record.id);
            else this.selectedIds.delete(record.id);
            this.renderSelectionBar();
        });

        const body = row.createDiv({
            cls: "sr-card-browser-row-body",
            attr: {
                role: "button",
                tabindex: "0",
                "aria-label": t("OPEN_SOURCE_NOTE"),
            },
        });
        const main = body.createDiv("sr-card-browser-row-main");
        main.createDiv("sr-card-browser-front").setText(compactCardText(record.front));
        main.createDiv("sr-card-browser-back").setText(compactCardText(record.back));

        const meta = body.createDiv("sr-card-browser-row-meta");
        const state = meta.createSpan(`sr-card-browser-state is-${record.state}`);
        state.setText(this.getStateLabel(record));
        if (record.interval !== null) {
            meta.createSpan("sr-card-browser-schedule").setText(
                t("CARD_INTERVAL", { interval: record.interval }),
            );
        }
        if (record.ease !== null) {
            meta.createSpan("sr-card-browser-schedule").setText(
                t("CARD_EASE", { ease: Math.round(record.ease) }),
            );
        }
        const location = [record.deckNames.join(", "), record.notePath].filter(Boolean).join(" · ");
        meta.createSpan("sr-card-browser-path").setText(location);

        const editButton = new ButtonComponent(row)
            .setIcon("pencil")
            .setTooltip(t("EDIT_CARD"))
            .setClass("sr-card-browser-edit")
            .onClick(() => void this.editCard(record));
        editButton.buttonEl.addEventListener("click", (event) => event.stopPropagation());

        body.addEventListener("click", () => void this.openSource(record));
        body.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            void this.openSource(record);
        });
        row.addEventListener("contextmenu", (event) => this.openCardMenu(event, record));
    }

    private renderSelectionBar(): void {
        if (this.selectionBarEl === null) return;
        this.selectionBarEl.empty();
        const selectedRecords = this.records.filter((record) => this.selectedIds.has(record.id));
        if (selectedRecords.length === 0) {
            this.selectionBarEl.addClass("is-empty");
            return;
        }
        this.selectionBarEl.removeClass("is-empty");
        this.selectionBarEl.createSpan({
            text: t("CARDS_SELECTED", { count: selectedRecords.length }),
        });
        new ButtonComponent(this.selectionBarEl)
            .setIcon("history")
            .setButtonText(t("RESET_SELECTED_PROGRESS"))
            .setDisabled(selectedRecords.every((record) => record.card.isNew))
            .onClick(() => this.confirmResetSelection(selectedRecords));
        new ButtonComponent(this.selectionBarEl)
            .setIcon("x")
            .setTooltip(t("CLEAR_SELECTION"))
            .onClick(() => {
                this.selectedIds.clear();
                this.renderResults(this.records);
            });
    }

    private confirmResetSelection(records: CardBrowserRecord[]): void {
        const scheduled = records.filter((record) => record.card.hasSchedule);
        if (scheduled.length === 0) return;
        new ConfirmationModal(
            this.app,
            t("RESET_SELECTED_PROGRESS"),
            t("CONFIRM_SELECTED_PROGRESS_RESET", { count: scheduled.length }),
            undefined,
            async () => {
                await resetCardsProgress(scheduled.map((record) => record.card));
                this.selectedIds.clear();
                this.render();
            },
        ).open();
    }

    private async startReview(): Promise<void> {
        const scopedFile = this.notePath
            ? this.app.vault.getAbstractFileByPath(this.notePath)
            : null;
        const file = scopedFile instanceof TFile ? scopedFile : undefined;
        await this.plugin.uiManager.openDeckContainer(FlashcardReviewMode.Review, file);
    }

    private async editCard(record: CardBrowserRecord): Promise<void> {
        if (
            await editCardFromBrowser(this.app, this.plugin.dataManager.data.settings, record.card)
        ) {
            this.render();
        }
    }

    private openCardMenu(event: MouseEvent, record: CardBrowserRecord): void {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(t("EDIT_CARD"))
                .setIcon("pencil")
                .onClick(() => void this.editCard(record)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("OPEN_SOURCE_NOTE"))
                .setIcon("file-input")
                .onClick(() => void this.openSource(record)),
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(t("RESET_CARD_PROGRESS"))
                .setIcon("history")
                .setDisabled(record.card.isNew)
                .onClick(() => this.confirmReset(record)),
        );
        menu.showAtMouseEvent(event);
    }

    private confirmReset(record: CardBrowserRecord): void {
        new ConfirmationModal(
            this.app,
            t("DELETE_SCHEDULING_DATA_OF_CURRENT_CARD"),
            t("CONFIRM_SCHEDULING_DATA_DELETION_OF_CURRENT_CARD"),
            t("CANCEL"),
            async () => {
                await resetCardProgress(record.card);
                this.render();
            },
        ).open();
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
