import "src/ui/card-browser/card-browser-view.css";
import {
    App,
    ButtonComponent,
    ItemView,
    Menu,
    Modal,
    Notice,
    SearchComponent,
    setIcon,
    TFile,
    WorkspaceLeaf,
} from "obsidian";

import { CardFlag, LegacyCardInput } from "src/data/collection/collection-types";
import { CARD_BROWSER_VIEW_TYPE } from "src/data/constants";
import { DataStore } from "src/data/data-store/base/data-store";
import { NativeCardStore } from "src/data/native-card-store";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { buryCardsUntilTomorrow, resetCardProgress, resetCardsProgress } from "src/ui/card-actions";
import {
    CardBrowserFilter,
    CardBrowserRecord,
    CardBrowserSort,
    createCardBrowserRecords,
    filterCardBrowserRecords,
    getCardBrowserDeckNames,
    getCardBrowserTags,
    sortCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";
import { DeckPickerModal } from "src/ui/deck-picker-modal";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";

const PAGE_SIZE = 100;

function compactCardText(value: string): string {
    return value
        .replace(/<!--SR:[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function nextLocalDayStart(): number {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime();
}

function recordToLegacyInput(record: CardBrowserRecord): LegacyCardInput {
    return {
        sourcePath: record.notePath,
        questionId: record.card.storageInfo?.questionId ?? null,
        ordinal: record.card.cardIdx,
        deckPath: record.deckNames[0] ?? "",
        front: record.front,
        back: record.back,
    };
}

class TagsEditorModal extends Modal {
    constructor(
        app: App,
        private readonly initialValue: string,
        private readonly onSave: (value: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-card-browser-tags-modal");
        this.contentEl.createEl("h2", { text: t("EDIT_TAGS") });
        const input = this.contentEl.createEl("input", {
            attr: {
                type: "text",
                placeholder: t("TAGS_PLACEHOLDER"),
                autocomplete: "off",
                autocapitalize: "none",
            },
        });
        input.value = this.initialValue;
        const actions = this.contentEl.createDiv("sr-card-browser-tags-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText(t("SAVE"))
            .setCta()
            .onClick(() => {
                this.onSave(input.value);
                this.close();
            });
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            this.onSave(input.value);
            this.close();
        });
        window.setTimeout(() => input.focus(), 0);
    }
}

export class CardBrowserView extends ItemView {
    private query = "";
    private filter: CardBrowserFilter = "all";
    private deck = "all";
    private sort: CardBrowserSort = "due";
    private notePath: string | null = null;
    private tag = "all";
    private flag = "all";
    private cardType = "all";
    private visibleLimit = PAGE_SIZE;
    private resultsEl: HTMLDivElement | null = null;
    private selectionBarEl: HTMLDivElement | null = null;
    private records: CardBrowserRecord[] = [];
    private selectedIds = new Set<string>();
    private editingId: string | null = null;

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
        const collection = this.plugin.dataManager.collectionStore;
        const snapshot = collection.getCollectionSnapshot();
        const storedByLegacyId = new Map<string, (typeof snapshot.cards)[string]>();
        for (const card of Object.values(snapshot.cards)) {
            if (!card.deletedAt && card.legacyStableId) {
                storedByLegacyId.set(card.legacyStableId, card);
            }
        }
        return createCardBrowserRecords(this.plugin.dataManager.osrCore.getAllCards()).map(
            (record) => {
                const stored = record.card.stableId
                    ? storedByLegacyId.get(record.card.stableId)
                    : undefined;
                const expired =
                    stored?.state === "buried" &&
                    stored.buriedUntil !== null &&
                    stored.buriedUntil <= Date.now();
                return {
                    ...record,
                    deckNames: stored?.deckPath ? [stored.deckPath] : record.deckNames,
                    lifecycleState: expired ? "active" : (stored?.state ?? "active"),
                    flag: stored?.flag ?? 0,
                    tags: stored ? (snapshot.notes[stored.noteId]?.tags ?? []) : [],
                };
            },
        );
    }

    private render(): void {
        this.contentEl.empty();
        this.resultsEl = null;
        this.selectionBarEl = null;
        this.contentEl.addClass("sr-card-browser-view");

        const records = this.getRecords();
        this.records = records;
        const recordIds = new Set(records.map((record) => record.id));
        this.selectedIds = new Set([...this.selectedIds].filter((id) => recordIds.has(id)));

        const header = this.contentEl.createDiv("sr-card-browser-header");
        const titleBlock = header.createDiv("sr-card-browser-title-block");
        titleBlock.createEl("p", {
            text: t("CARD_BROWSER_SUMMARY", {
                total: records.length,
                due: records.filter(
                    (record) => record.lifecycleState === "active" && record.state === "due",
                ).length,
            }),
        });
        const headerActions = header.createDiv("sr-card-browser-header-actions");
        const mediaButton = new ButtonComponent(headerActions)
            .setIcon("images")
            .setTooltip(t("MEDIA_LIBRARY"))
            .onClick(() => void this.plugin.uiManager.openNativeMediaManager());
        mediaButton.buttonEl.addClass("sr-card-browser-create-button");
        const reviewButton = new ButtonComponent(headerActions)
            .setButtonText(t("START_REVIEW"))
            .setTooltip(this.notePath === null ? t("START_REVIEW") : t("REVIEW_CARDS_IN_NOTE"))
            .onClick(() => void this.startReview());
        reviewButton.buttonEl.addClass("sr-card-browser-review-button");
        const reviewIcon = activeDocument.createElement("span");
        reviewIcon.addClass("sr-card-browser-review-icon");
        setIcon(reviewIcon, "play");
        reviewButton.buttonEl.prepend(reviewIcon);
        reviewButton.setDisabled(records.length === 0);
        const createButton = new ButtonComponent(headerActions)
            .setIcon("plus")
            .setTooltip(t("CREATE_CARD"))
            .onClick(() => void this.plugin.uiManager.openNativeCardCreator());
        createButton.buttonEl.addClass("sr-card-browser-create-button");
        if (!this.plugin.dataManager.isOsrCoreLoaded()) {
            this.renderEmpty(t("LOADING_CARDS"), "loader-circle", false);
            return;
        }
        if (records.length === 0) {
            this.renderEmpty(t("NO_CARDS_DESCRIPTION"), "layers", true);
            return;
        }

        this.renderInsights(records);

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
        const knownDecks = new Set([
            ...new NativeCardStore(this.plugin).getDeckPaths(),
            ...getCardBrowserDeckNames(records),
        ]);
        const deckRow = toolbar.createDiv("sr-card-browser-deck-row");
        deckRow.createSpan({ cls: "sr-card-browser-deck-label", text: t("DECK") });
        const deckButton = new ButtonComponent(deckRow)
            .setButtonText(this.deck === "all" ? t("ALL_DECKS") : this.deck)
            .setIcon("folder")
            .setClass("sr-card-browser-filter")
            .onClick(() => {
                new DeckPickerModal(this.app, {
                    decks: [...knownDecks],
                    current: this.deck,
                    allowAll: true,
                    onChoose: (value) => {
                        this.deck = value;
                        this.visibleLimit = PAGE_SIZE;
                        this.render();
                    },
                    onCreate: async (value) =>
                        await new NativeCardStore(this.plugin).createDeck(value),
                }).open();
            });
        deckButton.buttonEl.toggleClass("is-filtered", this.deck !== "all");

        const filterRow = toolbar.createDiv("sr-card-browser-filter-row");
        this.createFilterButton(
            filterRow,
            {
                all: t("ALL_CARD_TYPES"),
                basic: t("CARD_TYPE_BASIC"),
                reversed: t("CARD_TYPE_REVERSED"),
                cloze: t("CARD_TYPE_CLOZE"),
            },
            this.cardType,
            (value) => {
                this.cardType = value;
                this.visibleLimit = PAGE_SIZE;
                this.render();
            },
            this.cardType !== "all",
        );
        this.createFilterButton(
            filterRow,
            {
                all: t("ALL_CARDS"),
                new: t("NEW_CARDS"),
                due: t("DUE_CARDS"),
                scheduled: t("SCHEDULED_CARDS"),
                suspended: t("SUSPENDED_CARDS"),
                buried: t("BURIED_CARDS"),
            },
            this.filter,
            (value) => {
                this.filter = value as CardBrowserFilter;
                this.visibleLimit = PAGE_SIZE;
                this.render();
            },
            this.filter !== "all",
        );

        const tagOptions: Record<string, string> = { all: t("ALL_TAGS") };
        for (const tag of getCardBrowserTags(records)) tagOptions[tag] = tag;
        this.createFilterButton(
            filterRow,
            tagOptions,
            this.tag,
            (value) => {
                this.tag = value;
                this.visibleLimit = PAGE_SIZE;
                this.render();
            },
            this.tag !== "all",
        );

        this.createFilterButton(
            filterRow,
            this.getFlagOptions(true),
            this.flag,
            (value) => {
                this.flag = value;
                this.visibleLimit = PAGE_SIZE;
                this.render();
            },
            this.flag !== "all",
        );

        this.createFilterButton(
            filterRow,
            {
                due: t("SORT_BY_DUE"),
                front: t("SORT_BY_FRONT"),
                note: t("SORT_BY_NOTE"),
                interval: t("SORT_BY_INTERVAL"),
            },
            this.sort,
            (value) => {
                this.sort = value as CardBrowserSort;
                this.visibleLimit = PAGE_SIZE;
                this.render();
            },
            this.sort !== "due",
        );

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

    private renderInsights(records: CardBrowserRecord[]): void {
        const insights = this.contentEl.createDiv("sr-card-browser-insights");
        const metrics: Array<{ filter: CardBrowserFilter; label: string; value: number }> = [
            { filter: "all", label: t("ALL_CARDS"), value: records.length },
            {
                filter: "due",
                label: t("DUE"),
                value: records.filter(
                    (record) => record.lifecycleState === "active" && record.state === "due",
                ).length,
            },
            {
                filter: "new",
                label: t("NEW_CARDS"),
                value: records.filter(
                    (record) => record.lifecycleState === "active" && record.state === "new",
                ).length,
            },
            {
                filter: "scheduled",
                label: t("SCHEDULED_CARDS"),
                value: records.filter(
                    (record) => record.lifecycleState === "active" && record.state === "scheduled",
                ).length,
            },
        ];

        for (const metric of metrics) {
            const button = new ButtonComponent(insights)
                .setClass("sr-card-browser-insight")
                .setTooltip(metric.label)
                .onClick(() => {
                    this.filter = metric.filter;
                    this.visibleLimit = PAGE_SIZE;
                    this.render();
                });
            button.buttonEl.empty();
            button.buttonEl.toggleClass("is-active", this.filter === metric.filter);
            button.buttonEl.setAttribute("aria-pressed", String(this.filter === metric.filter));
            button.buttonEl.createSpan({
                cls: "sr-card-browser-insight-value",
                text: String(metric.value),
            });
            button.buttonEl.createSpan({
                cls: "sr-card-browser-insight-label",
                text: metric.label,
            });
        }
    }

    private createFilterButton(
        parent: HTMLElement,
        options: Record<string, string>,
        value: string,
        onChange: (value: string) => void,
        isFiltered: boolean,
    ): void {
        const currentLabel = options[value] ?? value;
        const button = new ButtonComponent(parent)
            .setTooltip(currentLabel)
            .setClass("sr-card-browser-filter");
        button.buttonEl.toggleClass("is-filtered", isFiltered);
        button.buttonEl.setAttribute("aria-haspopup", "menu");
        button.buttonEl.createSpan({
            cls: "sr-card-browser-filter-label",
            text: currentLabel,
        });

        const icon = button.buttonEl.createSpan("sr-card-browser-filter-icon");
        setIcon(icon, "chevron-down");

        button.onClick((event) => {
            const menu = new Menu();
            for (const [optionValue, label] of Object.entries(options)) {
                menu.addItem((item) =>
                    item
                        .setTitle(label)
                        .setChecked(optionValue === value)
                        .onClick(() => onChange(optionValue)),
                );
            }
            menu.showAtMouseEvent(event);
        });
    }

    private renderResults(records: CardBrowserRecord[]): void {
        if (this.resultsEl === null) return;
        this.resultsEl.empty();

        const filtered = sortCardBrowserRecords(
            filterCardBrowserRecords(
                records,
                this.query,
                this.filter,
                this.deck,
                this.notePath,
                this.tag,
                this.flag,
                this.cardType,
            ),
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
            this.renderEmpty(t("NO_CARDS_MATCH"), "search-x", false, this.resultsEl, () => {
                this.query = "";
                this.filter = "all";
                this.deck = "all";
                this.tag = "all";
                this.flag = "all";
                this.cardType = "all";
                this.notePath = null;
                this.visibleLimit = PAGE_SIZE;
                this.render();
            });
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
        clearFilters?: () => void,
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
                .onClick(() => void this.plugin.uiManager.openNativeCardCreator());
        }
        if (clearFilters !== undefined) {
            new ButtonComponent(empty).setButtonText(t("CLEAR_FILTERS")).onClick(clearFilters);
        }
    }

    private renderCardRow(parent: HTMLElement, record: CardBrowserRecord): void {
        const row = parent.createDiv({
            cls: "sr-card-browser-row",
        });
        const selectControl = row.createEl("label", {
            cls: "sr-card-browser-select",
        });
        const checkbox = selectControl.createEl("input", {
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
                "aria-label": t("EDIT_CARD"),
            },
        });
        const main = body.createDiv("sr-card-browser-row-main");
        main.createDiv("sr-card-browser-front").setText(
            compactCardText(record.front) || t("MEDIA_CARD"),
        );
        main.createDiv("sr-card-browser-back").setText(compactCardText(record.back));

        const meta = body.createDiv("sr-card-browser-row-meta");
        const visualState =
            record.lifecycleState === "active" ? record.state : record.lifecycleState;
        const state = meta.createSpan(`sr-card-browser-state is-${visualState}`);
        state.setText(this.getStateLabel(record));
        meta.createSpan("sr-card-browser-type").setText(
            record.cardType === "cloze"
                ? t("CARD_TYPE_CLOZE")
                : record.cardType === "reversed"
                  ? t("CARD_TYPE_REVERSED")
                  : t("CARD_TYPE_BASIC"),
        );
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
        for (const tag of record.tags.slice(0, 2)) {
            meta.createSpan("sr-card-browser-tag").setText(`#${tag}`);
        }

        const flagButton = new ButtonComponent(row)
            .setIcon("flag")
            .setTooltip(this.getFlagOptions(false)[String(record.flag)])
            .setClass("sr-card-browser-flag")
            .onClick((event) => this.openFlagMenu(event, [record]));
        flagButton.buttonEl.addClass(`is-flag-${record.flag}`);
        flagButton.buttonEl.toggleClass("is-empty", record.flag === 0);
        flagButton.buttonEl.addEventListener("click", (event) => event.stopPropagation());

        const actionsButton = new ButtonComponent(row)
            .setIcon("ellipsis")
            .setTooltip(t("OPEN_MENU"))
            .setClass("sr-card-browser-actions")
            .onClick((event) => this.openCardMenu(event, record));
        actionsButton.buttonEl.addEventListener("click", (event) => event.stopPropagation());

        body.addEventListener("click", () => void this.editCard(record));
        body.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            void this.editCard(record);
        });
        row.addEventListener("contextmenu", (event) => this.openCardMenu(event, record));
        if (this.editingId === record.id) this.renderInlineEditor(row, record);
    }

    private renderInlineEditor(parent: HTMLElement, record: CardBrowserRecord): void {
        const editor = parent.createDiv("sr-card-browser-inline-editor");
        editor.addEventListener("click", (event) => event.stopPropagation());
        const front = editor.createDiv({
            cls: "sr-card-browser-inline-field",
            attr: { contenteditable: "true", role: "textbox", "aria-label": t("CARD_FRONT") },
        });
        front.append(front.ownerDocument.createRange().createContextualFragment(record.front));
        const back = editor.createDiv({
            cls: "sr-card-browser-inline-field",
            attr: { contenteditable: "true", role: "textbox", "aria-label": t("CARD_BACK") },
        });
        back.append(back.ownerDocument.createRange().createContextualFragment(record.back));
        const actions = editor.createDiv("sr-card-browser-inline-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => {
            this.editingId = null;
            this.renderResults(this.records);
        });
        new ButtonComponent(actions)
            .setButtonText(t("SAVE"))
            .setCta()
            .onClick(async () => {
                const note = this.plugin.dataManager.collectionStore.findNoteBySource(
                    record.notePath,
                    record.card.storageInfo?.questionId,
                );
                await new NativeCardStore(this.plugin).updateCard(record.card, {
                    deckPath: record.deckNames[0] ?? "",
                    type: record.cardType,
                    front: front.innerHTML.trim(),
                    back: back.innerHTML.trim(),
                    answerMode: note?.answerMode ?? "reveal",
                    tags: note?.tags ?? record.tags,
                });
                this.editingId = null;
                new Notice(t("CARD_UPDATED"));
                this.render();
            });
        window.setTimeout(() => front.focus(), 0);
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
            .setIcon("folder-input")
            .setTooltip(t("MOVE_TO_DECK"))
            .onClick(() => this.openMoveDeckPicker(selectedRecords));
        new ButtonComponent(this.selectionBarEl)
            .setIcon("tags")
            .setTooltip(t("EDIT_TAGS"))
            .onClick(() => this.openTagsEditor(selectedRecords));
        new ButtonComponent(this.selectionBarEl)
            .setIcon("ellipsis")
            .setTooltip(t("MORE_ACTIONS"))
            .onClick((event) => this.openSelectionMenu(event, selectedRecords));
        new ButtonComponent(this.selectionBarEl)
            .setIcon("x")
            .setTooltip(t("CLEAR_SELECTION"))
            .onClick(() => {
                this.selectedIds.clear();
                this.renderResults(this.records);
            });
    }

    private openSelectionMenu(event: MouseEvent, records: CardBrowserRecord[]): void {
        const menu = new Menu();
        const postponementList = this.plugin.dataManager.osrCore.questionPostponementList;
        const allBuried = records.every((record) =>
            postponementList.includes(record.card.question),
        );
        const allInactive = records.every((record) => record.lifecycleState !== "active");
        menu.addItem((item) =>
            item
                .setTitle(t("SET_FLAG"))
                .setIcon("flag")
                .onClick(() => window.setTimeout(() => this.openFlagMenu(event, records), 0)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("MOVE_TO_DECK"))
                .setIcon("folder-input")
                .onClick(() => this.openMoveDeckPicker(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("EDIT_TAGS"))
                .setIcon("tags")
                .onClick(() => this.openTagsEditor(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle(allInactive ? t("RESUME_SELECTED_CARDS") : t("SUSPEND_SELECTED_CARDS"))
                .setIcon(allInactive ? "play" : "pause")
                .onClick(() => void this.setSelectionSuspended(records, !allInactive)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("BURY_SELECTED_UNTIL_TOMORROW"))
                .setIcon("moon")
                .setDisabled(allBuried)
                .onClick(() => void this.burySelection(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("RESET_SELECTED_PROGRESS"))
                .setIcon("history")
                .setDisabled(records.every((record) => record.card.isNew))
                .onClick(() => this.confirmResetSelection(records)),
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(t("DELETE_SELECTED_CARDS"))
                .setIcon("trash")
                .setWarning(true)
                .onClick(() => this.confirmDeleteSelection(records)),
        );
        menu.showAtMouseEvent(event);
    }

    private cardSources(records: CardBrowserRecord[]): Array<{
        sourcePath: string;
        questionId?: string | null;
    }> {
        return records.map((record) => ({
            sourcePath: record.notePath,
            questionId: record.card.storageInfo?.questionId,
        }));
    }

    private openMoveDeckPicker(records: CardBrowserRecord[]): void {
        const store = new NativeCardStore(this.plugin);
        new DeckPickerModal(this.app, {
            decks: store.getDeckPaths(),
            current: records[0]?.deckNames[0] ?? "",
            onChoose: (deckPath) => void this.moveRecords(records, deckPath),
            onCreate: async (deckPath) => await store.createDeck(deckPath),
        }).open();
    }

    private async moveRecords(records: CardBrowserRecord[], deckPath: string): Promise<void> {
        await new NativeCardStore(this.plugin).moveCards(this.cardSources(records), deckPath);
        this.selectedIds.clear();
        new Notice(t("CARDS_MOVED"));
        this.render();
    }

    private openTagsEditor(records: CardBrowserRecord[]): void {
        const shared = records.every(
            (record) => record.tags.join("\u0000") === records[0]?.tags.join("\u0000"),
        );
        new TagsEditorModal(
            this.app,
            shared ? (records[0]?.tags.join(", ") ?? "") : "",
            (value) => {
                const tags = value
                    .split(/[\s,]+/)
                    .map((tag) => tag.trim().replace(/^#+/, ""))
                    .filter(Boolean);
                void this.updateTags(records, tags);
            },
        ).open();
    }

    private async updateTags(records: CardBrowserRecord[], tags: string[]): Promise<void> {
        await new NativeCardStore(this.plugin).setCardTags(this.cardSources(records), tags);
        this.selectedIds.clear();
        new Notice(t("TAGS_UPDATED"));
        this.render();
    }

    private confirmDeleteSelection(records: CardBrowserRecord[]): void {
        new ConfirmationModal(
            this.app,
            t("DELETE_SELECTED_CARDS"),
            t("CONFIRM_SELECTED_CARDS_DELETE", { count: records.length }),
            t("CANCEL"),
            async () => {
                const questions = new Set(records.map((record) => record.card.question));
                for (const question of questions) await DataStore.getInstance().delete(question);
                await this.plugin.dataManager.sync();
                this.selectedIds.clear();
                new Notice(t("CARDS_DELETED"));
                this.render();
            },
        ).open();
    }

    private openFlagMenu(event: MouseEvent, records: CardBrowserRecord[]): void {
        const menu = new Menu();
        const options = this.getFlagOptions(false);
        const sharedFlag = records.every((record) => record.flag === records[0]?.flag)
            ? records[0]?.flag
            : null;
        for (const value of [0, 1, 2, 3, 4, 5, 6, 7] as CardFlag[]) {
            menu.addItem((item) =>
                item
                    .setTitle(options[String(value)])
                    .setIcon(value === 0 ? "x" : "flag")
                    .setChecked(sharedFlag === value)
                    .onClick(() => void this.setRecordsFlag(records, value)),
            );
        }
        menu.showAtMouseEvent(event);
    }

    private async setRecordsFlag(records: CardBrowserRecord[], flag: CardFlag): Promise<void> {
        await this.plugin.dataManager.collectionStore.setLegacyCardsFlag(
            records.map(recordToLegacyInput),
            flag,
        );
        new Notice(flag === 0 ? t("FLAGS_CLEARED") : t("FLAG_SET"));
        this.render();
    }

    private getFlagOptions(includeAll: boolean): Record<string, string> {
        return {
            ...(includeAll ? { all: t("ALL_FLAGS") } : {}),
            "0": t("NO_FLAG"),
            "1": t("FLAG_RED"),
            "2": t("FLAG_ORANGE"),
            "3": t("FLAG_GREEN"),
            "4": t("FLAG_BLUE"),
            "5": t("FLAG_PINK"),
            "6": t("FLAG_TURQUOISE"),
            "7": t("FLAG_PURPLE"),
        };
    }

    private async burySelection(records: CardBrowserRecord[]): Promise<void> {
        const questions = new Set(records.map((record) => record.card.question));
        const siblings = this.records.filter((record) => questions.has(record.card.question));
        await buryCardsUntilTomorrow(
            records.map((record) => record.card),
            this.plugin.dataManager.osrCore.questionPostponementList,
        );
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            siblings.map(recordToLegacyInput),
            "buried",
            nextLocalDayStart(),
        );
        this.selectedIds.clear();
        this.render();
    }

    private async setSelectionSuspended(
        records: CardBrowserRecord[],
        suspended: boolean,
    ): Promise<void> {
        if (!suspended) await this.removeBuriedQuestions(records);
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            records.map(recordToLegacyInput),
            suspended ? "suspended" : "active",
        );
        new Notice(
            suspended
                ? t("CARDS_SUSPENDED", { count: records.length })
                : t("CARDS_RESUMED", { count: records.length }),
        );
        this.selectedIds.clear();
        this.render();
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

    private editCard(record: CardBrowserRecord): void {
        this.editingId = this.editingId === record.id ? null : record.id;
        this.renderResults(this.records);
    }

    private openCardMenu(event: MouseEvent, record: CardBrowserRecord): void {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(t("QUICK_EDIT"))
                .setIcon("pencil")
                .onClick(() => void this.editCard(record)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("EDIT_CARD"))
                .setIcon("square-pen")
                .onClick(
                    () =>
                        void this.plugin.uiManager.openNativeCardEditor(
                            record.card,
                            record.deckNames[0],
                        ),
                ),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("DUPLICATE_CARD"))
                .setIcon("copy")
                .onClick(
                    () =>
                        void this.plugin.uiManager.openNativeCardCloner(
                            record.card,
                            record.deckNames[0],
                        ),
                ),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("OPEN_SOURCE_NOTE"))
                .setIcon("file-input")
                .onClick(() => void this.openSource(record)),
        );
        menu.addSeparator();
        const postponementList = this.plugin.dataManager.osrCore.questionPostponementList;
        const inactive = record.lifecycleState !== "active";
        menu.addItem((item) =>
            item
                .setTitle(inactive ? t("RESUME_CARD") : t("SUSPEND_CARD"))
                .setIcon(inactive ? "play" : "pause")
                .onClick(() => void this.setRecordSuspended(record, !inactive)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("BURY_UNTIL_TOMORROW"))
                .setIcon("moon")
                .setDisabled(
                    record.lifecycleState === "buried" ||
                        postponementList.includes(record.card.question),
                )
                .onClick(() => void this.buryRecord(record)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("RESET_CARD_PROGRESS"))
                .setIcon("history")
                .setDisabled(record.card.isNew)
                .onClick(() => this.confirmReset(record)),
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(t("DELETE_CARD_SOURCE"))
                .setIcon("trash")
                .setWarning(true)
                .onClick(() => this.confirmDelete(record)),
        );
        menu.showAtMouseEvent(event);
    }

    private async buryRecord(record: CardBrowserRecord): Promise<void> {
        const siblings = this.records.filter(
            (candidate) => candidate.card.question === record.card.question,
        );
        await buryCardsUntilTomorrow(
            [record.card],
            this.plugin.dataManager.osrCore.questionPostponementList,
        );
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            siblings.map(recordToLegacyInput),
            "buried",
            nextLocalDayStart(),
        );
        this.render();
    }

    private async setRecordSuspended(record: CardBrowserRecord, suspended: boolean): Promise<void> {
        if (!suspended) await this.removeBuriedQuestions([record]);
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            [recordToLegacyInput(record)],
            suspended ? "suspended" : "active",
        );
        new Notice(suspended ? t("CARD_SUSPENDED") : t("CARD_RESUMED"));
        this.render();
    }

    private async removeBuriedQuestions(records: CardBrowserRecord[]): Promise<void> {
        const postponementList = this.plugin.dataManager.osrCore.questionPostponementList;
        const questions = new Set(
            records
                .filter((record) => record.lifecycleState === "buried")
                .map((record) => record.card.question),
        );
        if (questions.size === 0) return;
        for (const question of questions) postponementList.remove(question);
        await postponementList.write();
    }

    private confirmDelete(record: CardBrowserRecord): void {
        new ConfirmationModal(
            this.app,
            t("DELETE_CARD_SOURCE"),
            t("DELETE_CARD_SOURCE_CONFIRMATION"),
            undefined,
            async () => {
                await DataStore.getInstance().delete(record.card.question);
                await this.plugin.dataManager.sync();
                this.selectedIds.delete(record.id);
                new Notice(t("CARD_SOURCE_DELETED"));
                this.render();
            },
        ).open();
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
        if (record.lifecycleState === "suspended") return t("SUSPENDED");
        if (record.lifecycleState === "buried") return t("BURIED");
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
