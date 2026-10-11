import "src/ui/card-browser/card-browser-view.css";
import {
    App,
    ButtonComponent,
    ItemView,
    MarkdownRenderer,
    Menu,
    Modal,
    Notice,
    Platform,
    SearchComponent,
    setIcon,
    WorkspaceLeaf,
} from "obsidian";

import { CardFlag, CollectionNote, NoteTypeDefinition } from "src/data/collection/collection-types";
import { CARD_BROWSER_VIEW_TYPE } from "src/data/constants";
import { DataStore } from "src/data/data-store/base/data-store";
import { NativeCardStore } from "src/data/native-card-store";
import { SavedCardQuery } from "src/data/plugin-data";
import { t } from "src/lang/helpers";
import { LocaleManagerInstance } from "src/lang/locale-manager";
import SRPlugin from "src/main";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { ISerializedFSRSScheduleData } from "src/scheduling/algorithms/fsrs/serialized-schedule-data";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { buryCardsUntilTomorrow, resetCardProgress, resetCardsProgress } from "src/ui/card-actions";
import {
    annotateCardBrowserDiagnostics,
    CARD_BROWSER_COLUMNS,
    CardBrowserColumn,
    CardBrowserFilter,
    CardBrowserRecord,
    CardBrowserSort,
    CardBrowserSortDirection,
    createCardBrowserRecords,
    filterCardBrowserRecords,
    getCardBrowserDeckNames,
    getCardBrowserTags,
    sortCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";
import { DeckPickerModal } from "src/ui/deck-picker-modal";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";

const DESKTOP_ROW_HEIGHT = 64;
const MOBILE_ROW_HEIGHT = 112;
const VIRTUAL_OVERSCAN = 7;

function uiText(english: string, russian: string): string {
    return LocaleManagerInstance.getInstance().currentLocale.startsWith("ru") ? russian : english;
}

function compactCardText(value: string): string {
    return value
        .replace(/<!--SR:[\s\S]*?-->/g, "")
        .replace(/!\[\[[^\]]+\]\]/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function containsMedia(value: string): boolean {
    return /!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^)]*\)|<(?:img|audio|video)\b/i.test(value);
}

function nextLocalDayStart(): number {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow.getTime();
}

function formatDate(timestamp: number | null | undefined): string {
    if (!timestamp) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(timestamp);
}

class TextInputModal extends Modal {
    constructor(
        app: App,
        private readonly titleText: string,
        private readonly placeholder: string,
        private readonly initialValue: string,
        private readonly onSubmit: (value: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-browser-sheet");
        this.contentEl.createEl("h2", { text: this.titleText });
        const input = this.contentEl.createEl("input", {
            attr: { type: "text", placeholder: this.placeholder, autocomplete: "off" },
        });
        input.value = this.initialValue;
        const actions = this.contentEl.createDiv("sr-browser-sheet-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => this.close());
        const submit = (): void => {
            const value = input.value.trim();
            if (!value) return;
            this.onSubmit(value);
            this.close();
        };
        new ButtonComponent(actions).setButtonText(t("SAVE")).setCta().onClick(submit);
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
        });
        window.setTimeout(() => input.focus(), 0);
    }
}

class SavedQueryModal extends Modal {
    constructor(
        app: App,
        private readonly query: string,
        private readonly onSave: (name: string, dynamic: boolean) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-browser-sheet");
        this.contentEl.createEl("h2", { text: uiText("Save search", "Сохранить поиск") });
        this.contentEl.createEl("p", { cls: "setting-item-description", text: this.query });
        const input = this.contentEl.createEl("input", {
            attr: {
                type: "text",
                placeholder: uiText("Search name", "Название поиска"),
                autocomplete: "off",
            },
        });
        const dynamicLabel = this.contentEl.createEl("label", { cls: "sr-browser-check-row" });
        const dynamic = dynamicLabel.createEl("input", { attr: { type: "checkbox" } });
        dynamic.checked = true;
        dynamicLabel.createSpan({
            text: uiText("Use as a dynamic study deck", "Использовать как динамическую колоду"),
        });
        const actions = this.contentEl.createDiv("sr-browser-sheet-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText(t("SAVE"))
            .setCta()
            .onClick(() => {
                const name = input.value.trim();
                if (!name) return;
                this.onSave(name, dynamic.checked);
                this.close();
            });
        window.setTimeout(() => input.focus(), 0);
    }
}

interface FindReplaceOptions {
    fieldId: string;
    find: string;
    replace: string;
    caseSensitive: boolean;
    regularExpression: boolean;
}

class FindReplaceModal extends Modal {
    constructor(
        app: App,
        private readonly fields: Array<{ id: string; name: string }>,
        private readonly onApply: (options: FindReplaceOptions) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-browser-sheet");
        this.contentEl.createEl("h2", { text: uiText("Find and replace", "Найти и заменить") });
        const field = this.contentEl.createEl("select");
        field.createEl("option", {
            text: uiText("All fields", "Все поля"),
            attr: { value: "*" },
        });
        for (const candidate of this.fields) {
            field.createEl("option", { text: candidate.name, attr: { value: candidate.id } });
        }
        const find = this.contentEl.createEl("input", {
            attr: { type: "text", placeholder: uiText("Find", "Найти") },
        });
        const replace = this.contentEl.createEl("input", {
            attr: { type: "text", placeholder: uiText("Replace with", "Заменить на") },
        });
        const flags = this.contentEl.createDiv("sr-browser-sheet-options");
        const caseLabel = flags.createEl("label", { cls: "sr-browser-check-row" });
        const caseSensitive = caseLabel.createEl("input", { attr: { type: "checkbox" } });
        caseLabel.createSpan({ text: uiText("Match case", "Учитывать регистр") });
        const regexLabel = flags.createEl("label", { cls: "sr-browser-check-row" });
        const regularExpression = regexLabel.createEl("input", { attr: { type: "checkbox" } });
        regexLabel.createSpan({ text: uiText("Regular expression", "Регулярное выражение") });
        const actions = this.contentEl.createDiv("sr-browser-sheet-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText(uiText("Replace", "Заменить"))
            .setCta()
            .onClick(() => {
                if (!find.value) return;
                this.onApply({
                    fieldId: field.value,
                    find: find.value,
                    replace: replace.value,
                    caseSensitive: caseSensitive.checked,
                    regularExpression: regularExpression.checked,
                });
                this.close();
            });
        window.setTimeout(() => find.focus(), 0);
    }
}

class ChoiceModal extends Modal {
    constructor(
        app: App,
        private readonly titleText: string,
        private readonly description: string,
        private readonly choices: Array<{ id: string; name: string; detail?: string }>,
        private readonly onChoose: (id: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-browser-sheet");
        this.contentEl.createEl("h2", { text: this.titleText });
        this.contentEl.createEl("p", { cls: "setting-item-description", text: this.description });
        const list = this.contentEl.createDiv("sr-browser-choice-list");
        for (const choice of this.choices) {
            const button = list.createEl("button", { cls: "sr-browser-choice" });
            button.createSpan({ cls: "sr-browser-choice-title", text: choice.name });
            if (choice.detail)
                button.createSpan({ cls: "sr-browser-choice-detail", text: choice.detail });
            button.addEventListener("click", () => {
                this.onChoose(choice.id);
                this.close();
            });
        }
    }
}

class CardInspectorModal extends Modal {
    constructor(
        app: App,
        private readonly plugin: SRPlugin,
        private readonly record: CardBrowserRecord,
        private readonly onEdit: () => void,
        private readonly onOpenSource: () => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-card-inspector");
        const header = this.contentEl.createDiv("sr-card-inspector-header");
        const titles = header.createDiv();
        titles.createEl("h2", { text: uiText("Card preview", "Предпросмотр карточки") });
        titles.createEl("p", {
            text: [this.record.deckNames[0], this.record.noteTypeName ?? this.record.cardType]
                .filter(Boolean)
                .join(" · "),
        });
        const actions = header.createDiv("sr-card-inspector-actions");
        new ButtonComponent(actions)
            .setIcon("file-input")
            .setTooltip(t("OPEN_SOURCE_NOTE"))
            .onClick(() => {
                this.close();
                this.onOpenSource();
            });
        new ButtonComponent(actions)
            .setIcon("square-pen")
            .setTooltip(t("EDIT_CARD"))
            .onClick(() => {
                this.close();
                this.onEdit();
            });
        const preview = this.contentEl.createDiv("sr-card-inspector-preview");
        this.renderSurface(preview, uiText("Question", "Вопрос"), this.record.front);
        this.renderSurface(preview, uiText("Answer", "Ответ"), this.record.back);
        const stats = this.contentEl.createDiv("sr-card-inspector-stats");
        const values: Array<[string, string]> = [
            [uiText("Reviews", "Повторения"), String(this.record.reps ?? 0)],
            [uiText("Lapses", "Ошибки"), String(this.record.lapses ?? 0)],
            [
                uiText("Interval", "Интервал"),
                this.record.interval ? `${this.record.interval}d` : "—",
            ],
            [
                uiText("Retention", "Сохранение"),
                this.record.retention === null || this.record.retention === undefined
                    ? "—"
                    : `${Math.round(this.record.retention * 100)}%`,
            ],
        ];
        for (const [label, value] of values) {
            const item = stats.createDiv("sr-card-inspector-stat");
            item.createSpan({ text: label });
            item.createEl("strong", { text: value });
        }
        const history = this.contentEl.createDiv("sr-card-inspector-history");
        history.createEl("h3", { text: uiText("Review history", "История повторений") });
        if (!this.record.history?.length) {
            history.createEl("p", {
                cls: "setting-item-description",
                text: uiText("No reviews yet.", "Повторений пока нет."),
            });
            return;
        }
        for (const entry of this.record.history.slice(0, 30)) {
            const row = history.createDiv("sr-card-history-row");
            const marker = row.createSpan(`is-rating-${entry.rating}`);
            marker.setText(["", t("AGAIN"), t("HARD"), t("GOOD"), t("EASY")][entry.rating]);
            row.createSpan({ text: formatDate(entry.reviewedAt) });
            row.createSpan({ text: entry.mode === "cram" ? t("CRAM_MODE") : t("REVIEW_MODE") });
        }
    }

    private renderSurface(parent: HTMLElement, label: string, value: string): void {
        const surface = parent.createDiv("sr-card-inspector-surface");
        surface.createEl("span", { cls: "sr-card-inspector-label", text: label });
        const content = surface.createDiv("sr-card-inspector-content");
        void MarkdownRenderer.render(this.app, value, content, this.record.notePath, this.plugin);
    }
}

export class CardBrowserView extends ItemView {
    private query = "";
    private filter: CardBrowserFilter = "all";
    private deck = "all";
    private sort: CardBrowserSort = "due";
    private sortDirection: CardBrowserSortDirection = "asc";
    private notePath: string | null = null;
    private tag = "all";
    private flag = "all";
    private cardType = "all";
    private resultsEl: HTMLDivElement | null = null;
    private selectionBarEl: HTMLDivElement | null = null;
    private virtualViewportEl: HTMLDivElement | null = null;
    private virtualRowsEl: HTMLDivElement | null = null;
    private records: CardBrowserRecord[] = [];
    private filteredRecords: CardBrowserRecord[] = [];
    private selectedIds = new Set<string>();
    private visibleColumns: CardBrowserColumn[] = [];
    private virtualStart = -1;
    private virtualEnd = -1;
    private virtualObserver: ResizeObserver | null = null;

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

    onClose(): Promise<void> {
        this.virtualObserver?.disconnect();
        this.virtualObserver = null;
        return Promise.resolve();
    }

    setNoteScope(notePath: string | null): void {
        this.notePath = notePath;
        this.render();
    }

    private getRecords(): CardBrowserRecord[] {
        if (!this.plugin.dataManager.isOsrCoreLoaded()) return [];
        const collection = this.plugin.dataManager.collectionStore;
        const snapshot = collection.getCollectionSnapshot();
        const reviewLog = collection.getReviewLogSnapshot();
        const storedByLegacyId = new Map<string, (typeof snapshot.cards)[string]>();
        for (const card of Object.values(snapshot.cards)) {
            if (!card.deletedAt && card.legacyStableId)
                storedByLegacyId.set(card.legacyStableId, card);
        }
        const historyByCard = new Map<string, (typeof reviewLog.entries)[string][]>();
        for (const entry of Object.values(reviewLog.entries)) {
            if (entry.deletedAt) continue;
            const entries = historyByCard.get(entry.cardId) ?? [];
            entries.push(entry);
            historyByCard.set(entry.cardId, entries);
        }
        const areas = this.plugin.dataManager.data.knowledgeAreas;
        const records = createCardBrowserRecords(this.plugin.dataManager.osrCore.getAllCards()).map(
            (record) => {
                const stored = record.card.stableId
                    ? storedByLegacyId.get(record.card.stableId)
                    : undefined;
                const note = stored ? snapshot.notes[stored.noteId] : undefined;
                const noteType = note ? snapshot.noteTypes[note.noteTypeId] : undefined;
                const expired =
                    stored?.state === "buried" &&
                    stored.buriedUntil !== null &&
                    stored.buriedUntil <= Date.now();
                const deckNames = stored?.deckPath ? [stored.deckPath] : record.deckNames;
                const fieldNames = Object.fromEntries(
                    noteType?.fields.map((field) => [field.id, field.name]) ?? [],
                );
                let retention: number | null = null;
                if (stored?.schedule?.algorithm === SRAlgorithmType.FSRS) {
                    const schedule = stored.schedule.scheduleData as ISerializedFSRSScheduleData;
                    const lastReview = Date.parse(schedule.lastReview);
                    if (schedule.stability > 0 && Number.isFinite(lastReview)) {
                        const elapsedDays = Math.max(0, (Date.now() - lastReview) / 86_400_000);
                        retention = Math.pow(
                            1 + (19 / 81) * (elapsedDays / schedule.stability),
                            -0.5,
                        );
                    }
                }
                return {
                    ...record,
                    deckNames,
                    lifecycleState: expired ? "active" : (stored?.state ?? "active"),
                    flag: stored?.flag ?? 0,
                    tags: note?.tags ?? [],
                    collectionCardId: stored?.id ?? null,
                    noteId: note?.id ?? null,
                    noteTypeId: noteType?.id ?? null,
                    noteTypeName: noteType?.name,
                    fields: note?.fields,
                    fieldNames,
                    areaNames: areas
                        .filter((area) => deckNames.some((deck) => area.deckPaths.includes(deck)))
                        .map((area) => area.name),
                    reps: stored?.reps ?? 0,
                    lapses: stored?.lapses ?? 0,
                    retention,
                    lastReviewAt: stored?.lastReviewAt ?? null,
                    hasMedia: containsMedia(
                        `${record.front}\n${record.back}\n${Object.values(note?.fields ?? {}).join("\n")}`,
                    ),
                    history: stored
                        ? [...(historyByCard.get(stored.id) ?? [])].sort(
                              (left, right) => right.reviewedAt - left.reviewedAt,
                          )
                        : [],
                };
            },
        );
        return annotateCardBrowserDiagnostics(records);
    }

    private render(): void {
        this.virtualObserver?.disconnect();
        this.virtualObserver = null;
        this.contentEl.empty();
        this.resultsEl = null;
        this.selectionBarEl = null;
        this.virtualViewportEl = null;
        this.virtualRowsEl = null;
        this.virtualStart = -1;
        this.virtualEnd = -1;
        this.visibleColumns = this.plugin.dataManager.data.cardBrowserColumns.filter(
            (column): column is CardBrowserColumn =>
                CARD_BROWSER_COLUMNS.includes(column as CardBrowserColumn),
        );
        const records = this.getRecords();
        this.records = records;
        const recordIds = new Set(records.map((record) => record.id));
        this.selectedIds = new Set([...this.selectedIds].filter((id) => recordIds.has(id)));
        this.renderHeader(records);
        if (!this.plugin.dataManager.isOsrCoreLoaded()) {
            this.renderEmpty(t("LOADING_CARDS"), "loader-circle", false);
            return;
        }
        if (records.length === 0) {
            this.renderEmpty(t("NO_CARDS_DESCRIPTION"), "layers", true);
            return;
        }
        this.renderInsights(records);
        this.renderToolbar(records);
        this.renderSavedQueries();
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

    private renderHeader(records: CardBrowserRecord[]): void {
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
        const actions = header.createDiv("sr-card-browser-header-actions");
        new ButtonComponent(actions)
            .setIcon("columns-3")
            .setTooltip(uiText("Columns", "Столбцы"))
            .onClick((event) => this.openColumnsMenu(event));
        new ButtonComponent(actions)
            .setIcon("images")
            .setTooltip(t("MEDIA_LIBRARY"))
            .onClick(() => void this.plugin.uiManager.openNativeMediaManager());
        const reviewButton = new ButtonComponent(actions)
            .setButtonText(t("START_REVIEW"))
            .setClass("sr-card-browser-review-button")
            .onClick(() => void this.startFilteredReview());
        const icon = activeDocument.createElement("span");
        setIcon(icon, "play");
        reviewButton.buttonEl.prepend(icon);
        reviewButton.setDisabled(records.length === 0);
        new ButtonComponent(actions)
            .setIcon("plus")
            .setTooltip(t("CREATE_CARD"))
            .onClick(() => void this.plugin.uiManager.openNativeCardCreator());
    }

    private renderInsights(records: CardBrowserRecord[]): void {
        const insights = this.contentEl.createDiv("sr-card-browser-insights");
        const metrics = [
            {
                label: t("ALL_CARDS"),
                value: records.length,
                action: () => this.setStateFilter("all"),
            },
            {
                label: t("DUE"),
                value: records.filter(
                    (record) => record.lifecycleState === "active" && record.state === "due",
                ).length,
                action: () => this.setStateFilter("due"),
            },
            {
                label: uiText("Duplicates", "Дубликаты"),
                value: records.filter((record) => record.diagnostics?.includes("duplicate")).length,
                action: () => this.setQuery("is:duplicate"),
            },
            {
                label: uiText("Empty", "Пустые"),
                value: records.filter((record) => record.diagnostics?.includes("empty")).length,
                action: () => this.setQuery("is:empty"),
            },
        ];
        for (const metric of metrics) {
            const button = new ButtonComponent(insights)
                .setClass("sr-card-browser-insight")
                .setTooltip(metric.label)
                .onClick(metric.action);
            button.buttonEl.empty();
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

    private setStateFilter(filter: CardBrowserFilter): void {
        this.filter = filter;
        this.render();
    }

    private setQuery(query: string): void {
        this.query = query;
        this.render();
    }

    private renderToolbar(records: CardBrowserRecord[]): void {
        const toolbar = this.contentEl.createDiv("sr-card-browser-toolbar");
        const primary = toolbar.createDiv("sr-card-browser-toolbar-primary");
        const search = primary.createDiv("sr-card-browser-search");
        new SearchComponent(search)
            .setPlaceholder(
                uiText(
                    "Search or use deck:, type:, is:due, reps:>10…",
                    "Поиск или deck:, type:, is:due, reps:>10…",
                ),
            )
            .setValue(this.query)
            .onChange((value) => {
                this.query = value;
                this.renderResults(records);
            });
        new ButtonComponent(primary)
            .setIcon("bookmark-plus")
            .setTooltip(uiText("Save search", "Сохранить поиск"))
            .setDisabled(!this.query.trim())
            .onClick(() => this.openSaveQuery());
        const filters = toolbar.createDiv("sr-card-browser-filter-row");
        const knownDecks = new Set([
            ...new NativeCardStore(this.plugin).getDeckPaths(),
            ...getCardBrowserDeckNames(records),
        ]);
        const deckButton = new ButtonComponent(filters)
            .setIcon(this.deck === "all" ? "layers-3" : "folder")
            .setClass("sr-card-browser-filter")
            .setTooltip(this.deck === "all" ? t("ALL_DECKS") : this.deck)
            .onClick(() => {
                new DeckPickerModal(this.app, {
                    decks: [...knownDecks],
                    current: this.deck,
                    allowAll: true,
                    onChoose: (value) => {
                        this.deck = value;
                        this.render();
                    },
                    onCreate: async (value) =>
                        await new NativeCardStore(this.plugin).createDeck(value),
                }).open();
            });
        deckButton.buttonEl.createSpan({
            cls: "sr-card-browser-filter-label",
            text: this.deck === "all" ? t("ALL_DECKS") : this.deck,
        });
        this.createFilterButton(
            filters,
            {
                all: t("ALL_CARD_TYPES"),
                basic: t("CARD_TYPE_BASIC"),
                reversed: t("CARD_TYPE_REVERSED"),
                cloze: t("CARD_TYPE_CLOZE"),
            },
            this.cardType,
            (value) => {
                this.cardType = value;
                this.render();
            },
        );
        this.createFilterButton(
            filters,
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
                this.render();
            },
        );
        const tagOptions: Record<string, string> = { all: t("ALL_TAGS") };
        for (const tag of getCardBrowserTags(records)) tagOptions[tag] = `#${tag}`;
        this.createFilterButton(filters, tagOptions, this.tag, (value) => {
            this.tag = value;
            this.render();
        });
        this.createFilterButton(filters, this.getSortOptions(), this.sort, (value) => {
            const selected = value as CardBrowserSort;
            if (selected === this.sort)
                this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
            else {
                this.sort = selected;
                this.sortDirection = "asc";
            }
            this.render();
        });
    }

    private createFilterButton(
        parent: HTMLElement,
        options: Record<string, string>,
        value: string,
        onChange: (value: string) => void,
    ): void {
        const button = new ButtonComponent(parent)
            .setClass("sr-card-browser-filter")
            .setTooltip(options[value] ?? value);
        button.buttonEl.createSpan({
            cls: "sr-card-browser-filter-label",
            text: options[value] ?? value,
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

    private getSortOptions(): Record<CardBrowserSort, string> {
        return {
            due: t("SORT_BY_DUE"),
            front: t("SORT_BY_FRONT"),
            note: t("SORT_BY_NOTE"),
            interval: t("SORT_BY_INTERVAL"),
            deck: uiText("Sort: deck", "Сортировка: колода"),
            type: uiText("Sort: type", "Сортировка: тип"),
            reps: uiText("Sort: reviews", "Сортировка: повторения"),
            lapses: uiText("Sort: lapses", "Сортировка: ошибки"),
            retention: uiText("Sort: retention", "Сортировка: сохранение"),
            "last-review": uiText("Sort: last review", "Сортировка: последнее повторение"),
        };
    }

    private renderSavedQueries(): void {
        const saved = this.plugin.dataManager.data.savedCardQueries;
        if (saved.length === 0) return;
        const row = this.contentEl.createDiv("sr-card-browser-saved-row");
        for (const query of saved) {
            const chip = row.createDiv("sr-card-browser-saved-query");
            const apply = chip.createEl("button", { text: query.name });
            apply.addEventListener("click", () => this.setQuery(query.query));
            if (query.dynamic) {
                const play = chip.createEl("button", {
                    attr: {
                        "aria-label": uiText("Study dynamic deck", "Изучать динамическую колоду"),
                    },
                });
                setIcon(play, "play");
                play.addEventListener("click", () => void this.studySavedQuery(query));
            }
            const menuButton = chip.createEl("button", { attr: { "aria-label": t("OPEN_MENU") } });
            setIcon(menuButton, "ellipsis");
            menuButton.addEventListener("click", (event) => this.openSavedQueryMenu(event, query));
        }
    }

    private renderResults(records: CardBrowserRecord[]): void {
        if (this.resultsEl === null) return;
        this.resultsEl.empty();
        this.virtualStart = -1;
        this.virtualEnd = -1;
        this.filteredRecords = sortCardBrowserRecords(
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
            this.sortDirection,
        );
        const summary = this.resultsEl.createDiv("sr-card-browser-summary");
        summary.createSpan({
            text: t("CARD_BROWSER_COUNT", {
                shown: this.filteredRecords.length,
                total: this.filteredRecords.length,
            }),
        });
        const allSelected =
            this.filteredRecords.length > 0 &&
            this.filteredRecords.every((record) => this.selectedIds.has(record.id));
        new ButtonComponent(summary)
            .setButtonText(allSelected ? t("DESELECT_ALL_RESULTS") : t("SELECT_ALL_RESULTS"))
            .setDisabled(this.filteredRecords.length === 0)
            .onClick(() => {
                for (const record of this.filteredRecords) {
                    if (allSelected) this.selectedIds.delete(record.id);
                    else this.selectedIds.add(record.id);
                }
                this.renderResults(records);
            });
        this.selectionBarEl = this.resultsEl.createDiv("sr-card-browser-selection-bar");
        this.renderSelectionBar();
        if (this.filteredRecords.length === 0) {
            this.renderEmpty(t("NO_CARDS_MATCH"), "search-x", false, this.resultsEl, () => {
                this.query = "";
                this.filter = "all";
                this.deck = "all";
                this.tag = "all";
                this.flag = "all";
                this.cardType = "all";
                this.notePath = null;
                this.render();
            });
            return;
        }
        const table = this.resultsEl.createDiv("sr-card-browser-table");
        const gridTemplate = this.getGridTemplate();
        const tableHeader = table.createDiv("sr-card-browser-table-header");
        tableHeader.setCssProps({ "grid-template-columns": gridTemplate });
        tableHeader.createSpan({ cls: "sr-card-browser-header-select" });
        for (const column of this.visibleColumns) {
            const cell = tableHeader.createEl("button", {
                cls: "sr-card-browser-header-cell",
                text: this.columnLabel(column),
            });
            cell.addEventListener("click", () => this.sortByColumn(column));
        }
        tableHeader.createSpan({ cls: "sr-card-browser-header-actions" });
        const viewport = table.createDiv("sr-card-browser-virtual-viewport");
        const spacer = viewport.createDiv("sr-card-browser-virtual-spacer");
        const rows = viewport.createDiv("sr-card-browser-virtual-rows");
        this.virtualViewportEl = viewport;
        this.virtualRowsEl = rows;
        spacer.setCssProps({
            height: `${this.filteredRecords.length * this.getRowHeight()}px`,
        });
        viewport.addEventListener("scroll", () => this.renderVirtualWindow());
        this.virtualObserver = new ResizeObserver(() => this.renderVirtualWindow(true));
        this.virtualObserver.observe(viewport);
        window.requestAnimationFrame(() => this.renderVirtualWindow(true));
    }

    private renderVirtualWindow(force = false): void {
        if (!this.virtualViewportEl || !this.virtualRowsEl) return;
        const rowHeight = this.getRowHeight();
        const start = Math.max(
            0,
            Math.floor(this.virtualViewportEl.scrollTop / rowHeight) - VIRTUAL_OVERSCAN,
        );
        const visibleCount = Math.ceil(this.virtualViewportEl.clientHeight / rowHeight);
        const end = Math.min(
            this.filteredRecords.length,
            start + visibleCount + VIRTUAL_OVERSCAN * 2,
        );
        if (!force && start === this.virtualStart && end === this.virtualEnd) return;
        this.virtualStart = start;
        this.virtualEnd = end;
        this.virtualRowsEl.empty();
        this.virtualRowsEl.setCssProps({
            transform: `translateY(${start * rowHeight}px)`,
        });
        const template = this.getGridTemplate();
        for (let index = start; index < end; index++) {
            this.renderCardRow(this.virtualRowsEl, this.filteredRecords[index], template);
        }
    }

    private renderCardRow(parent: HTMLElement, record: CardBrowserRecord, template: string): void {
        const row = parent.createDiv("sr-card-browser-row");
        row.setCssProps({ "grid-template-columns": template });
        const select = row.createEl("label", { cls: "sr-card-browser-select" });
        const checkbox = select.createEl("input", {
            attr: { type: "checkbox", "aria-label": t("SELECT_CARD") },
        });
        checkbox.checked = this.selectedIds.has(record.id);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selectedIds.add(record.id);
            else this.selectedIds.delete(record.id);
            this.renderSelectionBar();
        });
        for (const column of this.visibleColumns) {
            const cell = row.createDiv(`sr-card-browser-cell is-${column}`);
            this.renderCell(cell, record, column);
            cell.addEventListener("click", () => this.openInspector(record));
        }
        const actions = row.createDiv("sr-card-browser-row-actions");
        const flag = new ButtonComponent(actions)
            .setIcon("flag")
            .setTooltip(this.getFlagOptions(false)[String(record.flag)])
            .setClass(`is-flag-${record.flag}`)
            .onClick((event) => this.openFlagMenu(event, [record]));
        flag.buttonEl.toggleClass("is-empty", record.flag === 0);
        new ButtonComponent(actions)
            .setIcon("ellipsis")
            .setTooltip(t("OPEN_MENU"))
            .onClick((event) => this.openCardMenu(event, record));
        row.addEventListener("contextmenu", (event) => this.openCardMenu(event, record));
    }

    private renderCell(
        cell: HTMLElement,
        record: CardBrowserRecord,
        column: CardBrowserColumn,
    ): void {
        if (column === "question" || column === "answer") {
            const raw = column === "question" ? record.front : record.back;
            cell.setText(compactCardText(raw) || (record.hasMedia ? t("MEDIA_CARD") : "—"));
            if (record.diagnostics?.length && column === "question") {
                const badges = cell.createSpan("sr-card-browser-diagnostics");
                for (const diagnostic of record.diagnostics) {
                    badges.createSpan({
                        cls: `is-${diagnostic}`,
                        text:
                            diagnostic === "duplicate"
                                ? uiText("Duplicate", "Дубликат")
                                : uiText("Empty", "Пустая"),
                    });
                }
            }
            return;
        }
        if (column === "deck") cell.setText(record.deckNames.join(", ") || "—");
        if (column === "area") cell.setText(record.areaNames?.join(", ") || "—");
        if (column === "type") cell.setText(record.noteTypeName ?? record.cardType);
        if (column === "state") {
            cell.createSpan({
                cls: `sr-card-browser-state is-${record.lifecycleState === "active" ? record.state : record.lifecycleState}`,
                text: this.getStateLabel(record),
            });
        }
        if (column === "due") cell.setText(record.dueDate ?? "—");
        if (column === "interval")
            cell.setText(record.interval === null ? "—" : `${record.interval}d`);
        if (column === "ease")
            cell.setText(record.ease === null ? "—" : `${Math.round(record.ease)}%`);
        if (column === "reps") cell.setText(String(record.reps ?? 0));
        if (column === "lapses") cell.setText(String(record.lapses ?? 0));
        if (column === "retention") {
            cell.setText(
                record.retention === null || record.retention === undefined
                    ? "—"
                    : `${Math.round(record.retention * 100)}%`,
            );
        }
        if (column === "note") cell.setText(record.notePath || "—");
        if (column === "tags") cell.setText(record.tags.map((tag) => `#${tag}`).join(" ") || "—");
        if (column === "last-review") cell.setText(formatDate(record.lastReviewAt));
    }

    private getRowHeight(): number {
        return Platform.isMobile ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT;
    }

    private getGridTemplate(): string {
        const sizes: Record<CardBrowserColumn, string> = {
            question: "minmax(220px, 2fr)",
            answer: "minmax(180px, 1.5fr)",
            deck: "minmax(150px, 1fr)",
            area: "minmax(140px, 1fr)",
            type: "minmax(110px, .8fr)",
            state: "110px",
            due: "110px",
            interval: "86px",
            ease: "78px",
            reps: "72px",
            lapses: "72px",
            retention: "92px",
            note: "minmax(180px, 1.3fr)",
            tags: "minmax(150px, 1fr)",
            "last-review": "160px",
        };
        return ["42px", ...this.visibleColumns.map((column) => sizes[column]), "84px"].join(" ");
    }

    private columnLabel(column: CardBrowserColumn): string {
        return {
            question: uiText("Question", "Вопрос"),
            answer: uiText("Answer", "Ответ"),
            deck: t("DECK"),
            area: uiText("Knowledge area", "Область знаний"),
            type: uiText("Type", "Тип"),
            state: uiText("State", "Статус"),
            due: t("DUE"),
            interval: uiText("Interval", "Интервал"),
            ease: uiText("Ease", "Лёгкость"),
            reps: uiText("Reviews", "Повторения"),
            lapses: uiText("Lapses", "Ошибки"),
            retention: uiText("Retention", "Сохранение"),
            note: uiText("Source", "Источник"),
            tags: uiText("Tags", "Теги"),
            "last-review": uiText("Last review", "Последнее повторение"),
        }[column];
    }

    private sortByColumn(column: CardBrowserColumn): void {
        const mapping: Partial<Record<CardBrowserColumn, CardBrowserSort>> = {
            question: "front",
            deck: "deck",
            type: "type",
            due: "due",
            interval: "interval",
            reps: "reps",
            lapses: "lapses",
            retention: "retention",
            note: "note",
            "last-review": "last-review",
        };
        const sort = mapping[column];
        if (!sort) return;
        if (this.sort === sort) this.sortDirection = this.sortDirection === "asc" ? "desc" : "asc";
        else {
            this.sort = sort;
            this.sortDirection = "asc";
        }
        this.renderResults(this.records);
    }

    private openColumnsMenu(event: MouseEvent): void {
        const menu = new Menu();
        for (const column of CARD_BROWSER_COLUMNS) {
            menu.addItem((item) =>
                item
                    .setTitle(this.columnLabel(column))
                    .setChecked(this.visibleColumns.includes(column))
                    .onClick(() => void this.toggleColumn(column)),
            );
        }
        menu.showAtMouseEvent(event);
    }

    private async toggleColumn(column: CardBrowserColumn): Promise<void> {
        const current = [...this.visibleColumns];
        if (current.includes(column)) {
            if (current.length === 1) return;
            current.splice(current.indexOf(column), 1);
        } else current.push(column);
        this.plugin.dataManager.data.cardBrowserColumns = current;
        await this.plugin.dataManager.savePluginData();
        this.render();
    }

    private openSaveQuery(): void {
        const query = this.query.trim();
        if (!query) return;
        new SavedQueryModal(
            this.app,
            query,
            (name, dynamic) => void this.saveQuery(name, query, dynamic),
        ).open();
    }

    private async saveQuery(name: string, query: string, dynamic: boolean): Promise<void> {
        const now = Date.now();
        const existing = this.plugin.dataManager.data.savedCardQueries.find(
            (candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        );
        if (existing) {
            existing.query = query;
            existing.dynamic = dynamic;
            existing.updatedAt = now;
        } else {
            this.plugin.dataManager.data.savedCardQueries.push({
                id: `query-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                name,
                query,
                dynamic,
                createdAt: now,
                updatedAt: now,
            });
        }
        await this.plugin.dataManager.savePluginData();
        new Notice(uiText("Search saved.", "Поиск сохранён."));
        this.render();
    }

    private openSavedQueryMenu(event: MouseEvent, query: SavedCardQuery): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(uiText("Apply", "Применить"))
                .setIcon("search")
                .onClick(() => this.setQuery(query.query)),
        );
        if (query.dynamic) {
            menu.addItem((item) =>
                item
                    .setTitle(uiText("Study", "Изучать"))
                    .setIcon("play")
                    .onClick(() => void this.studySavedQuery(query)),
            );
        }
        menu.addItem((item) =>
            item
                .setTitle(uiText("Rename", "Переименовать"))
                .setIcon("pencil")
                .onClick(() => {
                    new TextInputModal(
                        this.app,
                        uiText("Rename search", "Переименовать поиск"),
                        "",
                        query.name,
                        (name) => void this.renameSavedQuery(query.id, name),
                    ).open();
                }),
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(uiText("Delete", "Удалить"))
                .setIcon("trash")
                .setWarning(true)
                .onClick(() => void this.deleteSavedQuery(query.id)),
        );
        menu.showAtMouseEvent(event);
    }

    private async renameSavedQuery(id: string, name: string): Promise<void> {
        const query = this.plugin.dataManager.data.savedCardQueries.find(
            (candidate) => candidate.id === id,
        );
        if (!query) return;
        query.name = name;
        query.updatedAt = Date.now();
        await this.plugin.dataManager.savePluginData();
        this.render();
    }

    private async deleteSavedQuery(id: string): Promise<void> {
        this.plugin.dataManager.data.savedCardQueries =
            this.plugin.dataManager.data.savedCardQueries.filter((query) => query.id !== id);
        await this.plugin.dataManager.savePluginData();
        this.render();
    }

    private async studySavedQuery(query: SavedCardQuery): Promise<void> {
        await this.startRecordsReview(filterCardBrowserRecords(this.records, query.query, "all"));
    }

    private async startFilteredReview(): Promise<void> {
        await this.startRecordsReview(
            this.filteredRecords.length ? this.filteredRecords : this.records,
        );
    }

    private async startRecordsReview(records: CardBrowserRecord[]): Promise<void> {
        const stableIds = records
            .map((record) => record.card.stableId)
            .filter((id): id is string => Boolean(id));
        if (stableIds.length === 0) {
            new Notice(
                uiText(
                    "No indexed cards in this selection.",
                    "В выборке нет проиндексированных карточек.",
                ),
            );
            return;
        }
        await this.plugin.uiManager.openDeckContainer(
            FlashcardReviewMode.Cram,
            undefined,
            stableIds,
        );
    }

    private renderSelectionBar(): void {
        if (!this.selectionBarEl) return;
        this.selectionBarEl.empty();
        const selected = this.records.filter((record) => this.selectedIds.has(record.id));
        this.selectionBarEl.toggleClass("is-empty", selected.length === 0);
        if (selected.length === 0) return;
        this.selectionBarEl.createSpan({ text: t("CARDS_SELECTED", { count: selected.length }) });
        new ButtonComponent(this.selectionBarEl)
            .setIcon("folder-input")
            .setTooltip(t("MOVE_TO_DECK"))
            .onClick(() => this.openMoveDeckPicker(selected));
        new ButtonComponent(this.selectionBarEl)
            .setIcon("replace")
            .setTooltip(uiText("Find and replace", "Найти и заменить"))
            .onClick(() => this.openFindReplace(selected));
        new ButtonComponent(this.selectionBarEl)
            .setIcon("ellipsis")
            .setTooltip(t("MORE_ACTIONS"))
            .onClick((event) => this.openSelectionMenu(event, selected));
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
        const allInactive = records.every((record) => record.lifecycleState !== "active");
        menu.addItem((item) =>
            item
                .setTitle(uiText("Study selection", "Изучать выбранное"))
                .setIcon("play")
                .onClick(() => void this.startRecordsReview(records)),
        );
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
                .setTitle(uiText("Assign knowledge area", "Назначить область знаний"))
                .setIcon("library-big")
                .onClick(() => this.openKnowledgeAreaPicker(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle(uiText("Change note type", "Изменить тип заметки"))
                .setIcon("shapes")
                .onClick(() => this.openNoteTypePicker(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle(uiText("Find and replace", "Найти и заменить"))
                .setIcon("replace")
                .onClick(() => this.openFindReplace(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("EDIT_TAGS"))
                .setIcon("tags")
                .onClick(() => this.openTagsEditor(records)),
        );
        menu.addSeparator();
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

    private openKnowledgeAreaPicker(records: CardBrowserRecord[]): void {
        const store = new NativeCardStore(this.plugin);
        const choices = [
            ...store.getKnowledgeAreas().map((area) => ({
                id: area.id,
                name: area.name,
                detail: area.deckPaths.join(" · "),
            })),
            { id: "__new__", name: uiText("New knowledge area…", "Новая область знаний…") },
            {
                id: "__none__",
                name: uiText("Remove from knowledge areas", "Убрать из областей знаний"),
            },
        ];
        new ChoiceModal(
            this.app,
            uiText("Knowledge area", "Область знаний"),
            uiText(
                "The selected decks will be grouped without moving their cards.",
                "Выбранные колоды будут сгруппированы без перемещения карточек.",
            ),
            choices,
            (id) => {
                if (id === "__new__") {
                    new TextInputModal(
                        this.app,
                        uiText("New knowledge area", "Новая область знаний"),
                        uiText("Name", "Название"),
                        "",
                        (name) => void this.createAndAssignArea(records, name),
                    ).open();
                } else void this.assignKnowledgeArea(records, id === "__none__" ? null : id);
            },
        ).open();
    }

    private async createAndAssignArea(records: CardBrowserRecord[], name: string): Promise<void> {
        const store = new NativeCardStore(this.plugin);
        const area = await store.createKnowledgeArea(name);
        await this.assignKnowledgeArea(records, area.id);
    }

    private async assignKnowledgeArea(
        records: CardBrowserRecord[],
        areaId: string | null,
    ): Promise<void> {
        const store = new NativeCardStore(this.plugin);
        const decks = new Set(records.flatMap((record) => record.deckNames).filter(Boolean));
        for (const deck of decks) {
            if (areaId) await store.assignDeckToKnowledgeArea(deck, areaId);
            else await store.unassignDeckFromKnowledgeAreas(deck);
        }
        new Notice(uiText("Knowledge area updated.", "Область знаний обновлена."));
        this.render();
    }

    private openNoteTypePicker(records: CardBrowserRecord[]): void {
        const noteTypes = this.plugin.dataManager.collectionStore
            .getNoteTypes()
            .filter((noteType) => noteType.kind !== "image-occlusion");
        new ChoiceModal(
            this.app,
            uiText("Change note type", "Изменить тип заметки"),
            uiText(
                "Matching fields are preserved by identifier, name, or position.",
                "Совпадающие поля сохраняются по идентификатору, имени или позиции.",
            ),
            noteTypes.map((type) => ({
                id: type.id,
                name: type.name,
                detail: `${type.fields.length} · ${type.templates.length}`,
            })),
            (id) => void this.changeNoteType(records, id),
        ).open();
    }

    private async changeNoteType(records: CardBrowserRecord[], targetId: string): Promise<void> {
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const target = snapshot.noteTypes[targetId];
        if (!target) return;
        const notes = this.uniqueNotes(records, snapshot.notes);
        let updated = 0;
        for (const note of notes) {
            if (note.noteTypeId === targetId || note.source.kind !== "managed") continue;
            const fields = this.mapFields(note, snapshot.noteTypes[note.noteTypeId], target);
            const deck = records.find((record) => record.noteId === note.id)?.deckNames[0] ?? "";
            try {
                await new NativeCardStore(this.plugin).updateStructuredNote(note, {
                    deckPath: deck,
                    noteTypeId: targetId,
                    fields,
                    tags: note.tags,
                });
                updated++;
            } catch {
                // Invalid conversions remain untouched; the final notice reports the applied count.
            }
        }
        new Notice(uiText(`${updated} notes converted.`, `Преобразовано заметок: ${updated}.`));
        this.selectedIds.clear();
        this.render();
    }

    private mapFields(
        note: CollectionNote,
        source: NoteTypeDefinition | undefined,
        target: NoteTypeDefinition,
    ): Record<string, string> {
        return Object.fromEntries(
            target.fields.map((field) => {
                const byName = source?.fields.find(
                    (candidate) =>
                        candidate.name.toLocaleLowerCase() === field.name.toLocaleLowerCase(),
                );
                const byOrdinal = source?.fields.find(
                    (candidate) => candidate.ordinal === field.ordinal,
                );
                return [
                    field.id,
                    note.fields[field.id] ??
                        note.fields[byName?.id ?? ""] ??
                        note.fields[byOrdinal?.id ?? ""] ??
                        "",
                ];
            }),
        );
    }

    private openFindReplace(records: CardBrowserRecord[]): void {
        const fields = new Map<string, string>();
        for (const record of records) {
            for (const [id, name] of Object.entries(record.fieldNames ?? {})) fields.set(id, name);
        }
        new FindReplaceModal(
            this.app,
            [...fields].map(([id, name]) => ({ id, name })),
            (options) => void this.applyFindReplace(records, options),
        ).open();
    }

    private async applyFindReplace(
        records: CardBrowserRecord[],
        options: FindReplaceOptions,
    ): Promise<void> {
        let matcher: RegExp;
        try {
            const source = options.regularExpression
                ? options.find
                : options.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            matcher = new RegExp(source, options.caseSensitive ? "g" : "gi");
        } catch {
            new Notice(uiText("Invalid regular expression.", "Некорректное регулярное выражение."));
            return;
        }
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const notes = this.uniqueNotes(records, snapshot.notes);
        let changed = 0;
        for (const note of notes) {
            if (note.source.kind !== "managed") continue;
            const fields = { ...note.fields };
            let noteChanged = false;
            for (const id of Object.keys(fields)) {
                if (options.fieldId !== "*" && id !== options.fieldId) continue;
                const next = fields[id].replace(matcher, options.replace);
                if (next === fields[id]) continue;
                fields[id] = next;
                noteChanged = true;
            }
            if (!noteChanged) continue;
            const deck = records.find((record) => record.noteId === note.id)?.deckNames[0] ?? "";
            try {
                await new NativeCardStore(this.plugin).updateStructuredNote(note, {
                    deckPath: deck,
                    noteTypeId: note.noteTypeId,
                    fields,
                    tags: note.tags,
                });
                changed++;
            } catch {
                // Keep processing the remaining selected notes.
            }
        }
        new Notice(uiText(`${changed} notes updated.`, `Обновлено заметок: ${changed}.`));
        this.render();
    }

    private uniqueNotes(
        records: CardBrowserRecord[],
        notes: Record<string, CollectionNote>,
    ): CollectionNote[] {
        return [
            ...new Set(
                records.map((record) => record.noteId).filter((id): id is string => Boolean(id)),
            ),
        ]
            .map((id) => notes[id])
            .filter((note): note is CollectionNote => Boolean(note && !note.deletedAt));
    }

    private openInspector(record: CardBrowserRecord): void {
        new CardInspectorModal(
            this.app,
            this.plugin,
            record,
            () => void this.plugin.uiManager.openNativeCardEditor(record.card, record.deckNames[0]),
            () => void this.openSource(record),
        ).open();
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
        if (clearFilters)
            new ButtonComponent(empty).setButtonText(t("CLEAR_FILTERS")).onClick(clearFilters);
    }

    private cardSources(
        records: CardBrowserRecord[],
    ): Array<{ sourcePath: string; questionId?: string | null }> {
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
        new TextInputModal(
            this.app,
            t("EDIT_TAGS"),
            t("TAGS_PLACEHOLDER"),
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

    private legacyInput(record: CardBrowserRecord) {
        return {
            sourcePath: record.notePath,
            questionId: record.card.storageInfo?.questionId ?? null,
            ordinal: record.card.cardIdx,
            deckPath: record.deckNames[0] ?? "",
            front: record.front,
            back: record.back,
        };
    }

    private async setRecordsFlag(records: CardBrowserRecord[], flag: CardFlag): Promise<void> {
        await this.plugin.dataManager.collectionStore.setLegacyCardsFlag(
            records.map((record) => this.legacyInput(record)),
            flag,
        );
        new Notice(flag === 0 ? t("FLAGS_CLEARED") : t("FLAG_SET"));
        this.render();
    }

    private async burySelection(records: CardBrowserRecord[]): Promise<void> {
        await buryCardsUntilTomorrow(
            records.map((record) => record.card),
            this.plugin.dataManager.osrCore.questionPostponementList,
        );
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            records.map((record) => this.legacyInput(record)),
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
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            records.map((record) => this.legacyInput(record)),
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
        if (!scheduled.length) return;
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

    private openCardMenu(event: MouseEvent, record: CardBrowserRecord): void {
        event.preventDefault();
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(uiText("Preview", "Предпросмотр"))
                .setIcon("eye")
                .onClick(() => this.openInspector(record)),
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
        const inactive = record.lifecycleState !== "active";
        menu.addItem((item) =>
            item
                .setTitle(inactive ? t("RESUME_CARD") : t("SUSPEND_CARD"))
                .setIcon(inactive ? "play" : "pause")
                .onClick(() => void this.setSelectionSuspended([record], !inactive)),
        );
        menu.addItem((item) =>
            item
                .setTitle(t("BURY_UNTIL_TOMORROW"))
                .setIcon("moon")
                .onClick(() => void this.burySelection([record])),
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
