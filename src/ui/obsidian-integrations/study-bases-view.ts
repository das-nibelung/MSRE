import {
    BasesView,
    ButtonComponent,
    Menu,
    Modal,
    normalizePath,
    Notice,
    QueryController,
    setIcon,
    Setting,
    TFile,
} from "obsidian";

import { CardFlag, CollectionNote, NoteTypeDefinition } from "src/data/collection/collection-types";
import { NativeCardStore } from "src/data/native-card-store";
import type SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { CardBrowserRecord, compactCardText } from "src/ui/card-browser/card-browser-model";
import { DeckPickerModal } from "src/ui/deck-picker-modal";
import { attachObsidianLink } from "src/ui/obsidian-integrations/obsidian-links";
import { syncStudyProperties } from "src/ui/obsidian-integrations/obsidian-study-integration";
import {
    aggregateStudyBaseEntries,
    filterStudyBaseRecords,
    filterStudyBaseSummaries,
    parseStudyCsv,
    StudyBasePreset,
    StudyBaseSummary,
    StudyCsvRow,
} from "src/ui/obsidian-integrations/study-bases-model";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";

export const STUDY_BASES_VIEW_TYPE = "personal-spaced-repetition-study";
const activeStudyViews = new Set<StudyBasesView>();

const OLD_STUDY_BASE = [
    "filters:",
    "  and:",
    "    - 'file.ext == \"md\"'",
    "views:",
    `  - type: ${STUDY_BASES_VIEW_TYPE}`,
    "    name: Study",
    "    showEmpty: false",
    "",
].join("\n");

const STUDY_BASE = [
    "filters:",
    "  and:",
    "    - 'file.ext == \"md\"'",
    "views:",
    ...[
        ["All cards", "all"],
        ["Today", "today"],
        ["Errors", "errors"],
        ["Weak", "weak"],
        ["No area", "no-area"],
    ].flatMap(([name, preset], index) => [
        `  - type: ${STUDY_BASES_VIEW_TYPE}`,
        `    name: ${name}`,
        `    preset: ${preset}`,
        ...(index === 0 ? ["    showEmpty: false"] : []),
    ]),
    "",
].join("\n");

class StudyTextPrompt extends Modal {
    constructor(
        plugin: SRPlugin,
        private readonly title: string,
        private readonly value: string,
        private readonly onSubmit: (value: string) => void,
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.contentEl.createEl("h2", { text: this.title });
        let value = this.value;
        new Setting(this.contentEl).addText((text) =>
            text.setValue(value).onChange((next) => (value = next)),
        );
        const actions = this.contentEl.createDiv("sr-bases-prompt-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText("Apply")
            .setCta()
            .onClick(() => {
                this.close();
                this.onSubmit(value);
            });
    }
}

interface StudyChoice {
    id: string;
    label: string;
}

class StudyChoicePrompt extends Modal {
    constructor(
        plugin: SRPlugin,
        private readonly title: string,
        private readonly choices: StudyChoice[],
        private readonly onSubmit: (id: string) => void,
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.contentEl.createEl("h2", { text: this.title });
        let selected = this.choices[0]?.id ?? "";
        new Setting(this.contentEl).addDropdown((dropdown) => {
            for (const choice of this.choices) dropdown.addOption(choice.id, choice.label);
            dropdown.onChange((value) => (selected = value));
        });
        const actions = this.contentEl.createDiv("sr-bases-prompt-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText("Apply")
            .setCta()
            .onClick(() => {
                this.close();
                if (selected) this.onSubmit(selected);
            });
    }
}

class StudyAreaPicker extends Modal {
    constructor(
        plugin: SRPlugin,
        private readonly onChoose: (id: string | null) => void,
    ) {
        super(plugin.app);
        this.plugin = plugin;
    }

    private readonly plugin: SRPlugin;

    onOpen(): void {
        this.contentEl.createEl("h2", { text: "Assign knowledge area" });
        let selected = "";
        new Setting(this.contentEl).setName("Knowledge area").addDropdown((dropdown) => {
            dropdown.addOption("", "No knowledge area");
            for (const area of this.plugin.dataManager.data.knowledgeAreas.filter(
                (candidate) => !candidate.archivedAt,
            )) {
                dropdown.addOption(area.id, `${area.icon ? `${area.icon} ` : ""}${area.name}`);
            }
            dropdown.onChange((value) => (selected = value));
        });
        const actions = this.contentEl.createDiv("sr-bases-prompt-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText("Assign")
            .setCta()
            .onClick(() => {
                this.close();
                this.onChoose(selected || null);
            });
    }
}

interface UndoAction {
    label: string;
    run: () => Promise<void>;
}

function csvCell(value: string | number | null | undefined): string {
    return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function refreshStudyBasesViews(): void {
    activeStudyViews.forEach((view) => view.refresh());
}

export async function createStudyBase(plugin: SRPlugin): Promise<TFile> {
    const folder = normalizePath(plugin.dataManager.data.settings.scheduleDataVaultLocation);
    const parts = folder.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!plugin.app.vault.getAbstractFileByPath(current)) {
            await plugin.app.vault.createFolder(current);
        }
    }
    const path = normalizePath(`${folder}/Study.base`);
    const existing = plugin.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
        const content = await plugin.app.vault.read(existing);
        if (content === OLD_STUDY_BASE) await plugin.app.vault.process(existing, () => STUDY_BASE);
        file = existing;
    } else {
        file = await plugin.app.vault.create(path, STUDY_BASE);
        new Notice("Study Base created");
    }
    await plugin.app.workspace.getLeaf("tab").openFile(file);
    return file;
}

export class StudyBasesView extends BasesView {
    readonly type = STUDY_BASES_VIEW_TYPE;
    private selectedPaths = new Set<string>();
    private expandedPaths = new Set<string>();
    private undoHistory: UndoAction[] = [];
    private selectedCardIds = new Set<string>();

    constructor(
        controller: QueryController,
        private readonly containerEl: HTMLElement,
        private readonly plugin: SRPlugin,
    ) {
        super(controller);
        this.containerEl.addClass("sr-bases-study-view");
        activeStudyViews.add(this);
    }

    onunload(): void {
        activeStudyViews.delete(this);
    }

    onDataUpdated(): void {
        this.render();
    }

    refresh(): void {
        if (this.containerEl.isShown()) this.render();
    }

    private render(): void {
        this.containerEl.empty();
        this.containerEl.toggleClass(
            "is-comfortable",
            this.config.get("density") === "comfortable",
        );
        const records = createStudyRecords(this.plugin);
        const showEmpty = this.config.get("showEmpty") === true;
        const configuredPreset = this.config.get("preset");
        const preset: StudyBasePreset =
            typeof configuredPreset === "string" ? (configuredPreset as StudyBasePreset) : "all";
        const groups = this.data.groupedData;
        const allSummaries = aggregateStudyBaseEntries(
            this.data.data.map((entry) => ({
                path: entry.file.path,
                basename: entry.file.basename,
            })),
            records,
        );
        const visible = filterStudyBaseSummaries(
            allSummaries.filter((entry) => showEmpty || entry.total > 0),
            preset,
        );
        const visiblePaths = new Set(visible.map((entry) => entry.path));
        this.selectedPaths = new Set(
            [...this.selectedPaths].filter((path) => visiblePaths.has(path)),
        );
        const summaryByPath = new Map(visible.map((entry) => [entry.path, entry]));
        const rowMode = this.config.get("rowMode") === "cards" ? "cards" : "notes";
        const visibleCards = this.sortCards(
            filterStudyBaseRecords(
                records.filter((record) => visiblePaths.has(record.notePath)),
                preset,
            ),
        );
        const visibleCardIds = new Set(visibleCards.map((record) => record.id));
        this.selectedCardIds = new Set(
            [...this.selectedCardIds].filter((id) => visibleCardIds.has(id)),
        );

        this.renderToolbar(visible, visibleCards, preset, rowMode);
        this.renderUndo();
        this.renderSelectionBar(records, rowMode);
        const overview = this.containerEl.createDiv("sr-bases-study-overview");
        this.renderMetric(overview, "Notes", visible.length);
        this.renderMetric(
            overview,
            "Cards",
            visible.reduce((sum, entry) => sum + entry.total, 0),
        );
        this.renderMetric(
            overview,
            "Due",
            visible.reduce((sum, entry) => sum + entry.due, 0),
            "is-due",
        );
        this.renderMetric(
            overview,
            "Lapses",
            visible.reduce((sum, entry) => sum + entry.lapses, 0),
            "is-warning",
        );

        const body = this.containerEl.createDiv("sr-bases-study-body");
        if (rowMode === "cards") {
            this.renderCardTable(body, visibleCards);
            if (!visibleCards.length) this.renderEmpty(body, preset);
            return;
        }
        let renderedRows = 0;
        for (const group of groups) {
            const entries = group.entries
                .map((entry) => summaryByPath.get(entry.file.path))
                .filter((entry): entry is StudyBaseSummary => Boolean(entry));
            if (!entries.length) continue;
            if (group.hasKey()) {
                body.createEl("h3", {
                    cls: "sr-bases-study-group",
                    text: group.key?.toString() ?? "Other",
                });
            }
            for (const entry of entries) {
                this.renderRow(body, entry, records);
                renderedRows++;
            }
        }
        if (!renderedRows) this.renderEmpty(body, preset);
    }

    private renderToolbar(
        visible: StudyBaseSummary[],
        records: CardBrowserRecord[],
        preset: StudyBasePreset,
        rowMode: "notes" | "cards",
    ): void {
        const toolbar = this.containerEl.createDiv("sr-bases-study-toolbar");
        const allSelected =
            rowMode === "cards"
                ? records.length > 0 &&
                  records.every((record) => this.selectedCardIds.has(record.id))
                : visible.length > 0 &&
                  visible.every((entry) => this.selectedPaths.has(entry.path));
        new ButtonComponent(toolbar)
            .setIcon(allSelected ? "square-check-big" : "list-checks")
            .setButtonText(allSelected ? "Clear all" : "Select all results")
            .onClick(() => {
                if (rowMode === "cards") {
                    if (allSelected) this.selectedCardIds.clear();
                    else records.forEach((record) => this.selectedCardIds.add(record.id));
                } else if (allSelected) this.selectedPaths.clear();
                else visible.forEach((entry) => this.selectedPaths.add(entry.path));
                this.render();
            });
        const spacer = toolbar.createDiv("sr-bases-study-toolbar-spacer");
        spacer.setAttr("aria-hidden", "true");
        new ButtonComponent(toolbar)
            .setIcon("download")
            .setTooltip("Export current results as CSV")
            .onClick(
                () =>
                    void (rowMode === "cards"
                        ? this.exportCards(records)
                        : this.exportResults(visible)),
            );
        new ButtonComponent(toolbar)
            .setIcon("upload")
            .setTooltip("Import edits from a Study CSV")
            .onClick(() => this.openCsvImport());
        new ButtonComponent(toolbar)
            .setIcon("copy-plus")
            .setTooltip("Save this study view as a separate Base")
            .onClick(() => this.promptSaveView(preset));
        if (records.length) {
            new ButtonComponent(toolbar)
                .setIcon("refresh-cw")
                .setTooltip("Refresh study data")
                .onClick(() => this.render());
        }
    }

    private renderUndo(): void {
        const action = this.undoHistory[this.undoHistory.length - 1];
        if (!action) return;
        const undo = this.containerEl.createDiv("sr-bases-study-undo");
        undo.createSpan({ text: `${action.label} · ${this.undoHistory.length} in history` });
        new ButtonComponent(undo)
            .setIcon("undo-2")
            .setButtonText("Undo")
            .onClick(() => void this.runUndo());
        new ButtonComponent(undo)
            .setIcon("x")
            .setTooltip("Clear Undo history")
            .onClick(() => {
                this.undoHistory = [];
                this.render();
            });
    }

    private setUndo(label: string, run: () => Promise<void>): void {
        this.undoHistory.push({ label, run });
        if (this.undoHistory.length > 20) this.undoHistory.shift();
    }

    private async runUndo(): Promise<void> {
        const action = this.undoHistory.pop();
        if (!action) return;
        await action.run();
        new Notice("Change undone");
        refreshStudyBasesViews();
    }

    private renderSelectionBar(records: CardBrowserRecord[], rowMode: "notes" | "cards"): void {
        if (rowMode === "cards" ? !this.selectedCardIds.size : !this.selectedPaths.size) return;
        const selected =
            rowMode === "cards"
                ? records.filter((record) => this.selectedCardIds.has(record.id))
                : this.selectedRecords(records);
        const bar = this.containerEl.createDiv("sr-bases-study-selection");
        bar.createEl("strong", {
            text:
                rowMode === "cards"
                    ? `${this.selectedCardIds.size} cards`
                    : `${this.selectedPaths.size} notes`,
        });
        bar.createSpan({ text: `${selected.length} cards selected` });
        const actions = bar.createDiv("sr-bases-study-selection-actions");
        new ButtonComponent(actions)
            .setIcon("play")
            .setTooltip("Review selected cards")
            .setCta()
            .onClick(() => void this.reviewRecords(selected));
        new ButtonComponent(actions)
            .setIcon("folder-input")
            .setTooltip("Move to deck")
            .onClick(() => this.openDeckPicker(selected));
        new ButtonComponent(actions)
            .setIcon("tags")
            .setTooltip("Set tags")
            .onClick(() => this.openTags(selected));
        new ButtonComponent(actions)
            .setIcon("library-big")
            .setTooltip("Assign knowledge area")
            .onClick(() => this.openAreaPicker(selected));
        new ButtonComponent(actions)
            .setIcon("ellipsis")
            .setTooltip("More actions")
            .onClick((event) => this.openMoreActions(event, selected));
        new ButtonComponent(actions)
            .setIcon("x")
            .setTooltip("Clear selection")
            .onClick(() => {
                this.selectedPaths.clear();
                this.selectedCardIds.clear();
                this.render();
            });
    }

    private renderMetric(parent: HTMLElement, label: string, value: number, cls = ""): void {
        const metric = parent.createDiv(`sr-bases-study-metric ${cls}`);
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
    }

    private sortCards(records: CardBrowserRecord[]): CardBrowserRecord[] {
        const configuredSort = this.config.get("sort");
        const sort = typeof configuredSort === "string" ? configuredSort : "due";
        return [...records].sort((left, right) => {
            if (sort === "question")
                return compactCardText(left.front).localeCompare(compactCardText(right.front));
            if (sort === "deck")
                return (left.deckNames[0] ?? "").localeCompare(right.deckNames[0] ?? "");
            if (sort === "retention") return (left.retention ?? 1) - (right.retention ?? 1);
            if (sort === "lapses") return (right.lapses ?? 0) - (left.lapses ?? 0);
            const rank = (record: CardBrowserRecord): number =>
                record.state === "due" ? 0 : record.state === "new" ? 1 : 2;
            return (
                rank(left) - rank(right) || (left.dueDate ?? "").localeCompare(right.dueDate ?? "")
            );
        });
    }

    private renderCardTable(parent: HTMLElement, records: CardBrowserRecord[]): void {
        const configuredColumns = this.config.get("columns");
        const columnSet = typeof configuredColumns === "string" ? configuredColumns : "learning";
        parent.addClass("is-card-table", `is-columns-${columnSet}`);
        const header = parent.createDiv("sr-bases-card-header");
        header.createSpan();
        header.createSpan({ text: "Card" });
        header.createSpan({ text: "Deck" });
        if (columnSet !== "compact") header.createSpan({ text: "State" });
        if (columnSet === "full") header.createSpan({ text: "Learning" });
        header.createSpan({ text: "Edit" });
        for (const record of records) this.renderCardTableRow(parent, record, columnSet);
    }

    private renderCardTableRow(
        parent: HTMLElement,
        record: CardBrowserRecord,
        columnSet: string,
    ): void {
        const row = parent.createDiv("sr-bases-card-table-row");
        row.dataset.cardId = record.id;
        const checkbox = row.createEl("input", {
            attr: { type: "checkbox", "aria-label": `Select ${compactCardText(record.front)}` },
        });
        checkbox.checked = this.selectedCardIds.has(record.id);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selectedCardIds.add(record.id);
            else this.selectedCardIds.delete(record.id);
            this.render();
        });
        const card = row.createDiv("sr-bases-card-primary");
        const question = card.createEl("button", {
            cls: "sr-bases-inline-value",
            text: compactCardText(record.front) || "Media card",
        });
        question.addEventListener(
            "click",
            () => void this.plugin.uiManager.openNativeCardEditor(record.card, record.deckNames[0]),
        );
        card.createSpan({ text: compactCardText(record.back) || record.notePath });

        const deck = row.createEl("button", {
            cls: "sr-bases-inline-value is-deck",
            text: record.deckNames[0] ?? "No deck",
        });
        deck.addEventListener("click", () => this.openDeckPicker([record]));

        if (columnSet !== "compact") {
            const state = row.createDiv("sr-bases-card-state-cell");
            state.createSpan({ cls: `is-${record.state}`, text: record.state });
            if (record.dueDate) state.createEl("small", { text: record.dueDate });
            const tags = state.createEl("button", {
                cls: "sr-bases-inline-tags",
                text: record.tags.length ? record.tags.join(" · ") : "+ tags",
            });
            tags.addEventListener("click", () => this.openTags([record]));
        }

        if (columnSet === "full") {
            const learning = row.createDiv("sr-bases-card-learning");
            learning.createSpan({
                text:
                    record.retention === null || record.retention === undefined
                        ? "— retention"
                        : `${Math.round(record.retention * 100)}% retention`,
            });
            learning.createSpan({
                text: `${record.lapses ?? 0} lapses · ${record.stability ? `${Math.round(record.stability)}d` : "—"}`,
            });
        }

        const actions = row.createDiv("sr-bases-card-actions");
        const area = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Assign knowledge area" },
        });
        setIcon(area, "library-big");
        area.addEventListener("click", () => this.openAreaPicker([record]));
        const type = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Change note type" },
        });
        setIcon(type, "shapes");
        type.addEventListener("click", () => this.openNoteTypePicker([record]));
        const edit = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Edit card" },
        });
        setIcon(edit, "pencil");
        edit.addEventListener(
            "click",
            () => void this.plugin.uiManager.openNativeCardEditor(record.card, record.deckNames[0]),
        );
    }

    private renderRow(
        parent: HTMLElement,
        entry: StudyBaseSummary,
        records: CardBrowserRecord[],
    ): void {
        const row = parent.createDiv("sr-bases-study-row");
        const checkbox = row.createEl("input", {
            cls: "sr-bases-study-checkbox",
            attr: { type: "checkbox", "aria-label": `Select ${entry.basename}` },
        });
        checkbox.checked = this.selectedPaths.has(entry.path);
        checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selectedPaths.add(entry.path);
            else this.selectedPaths.delete(entry.path);
            this.render();
        });

        const main = row.createDiv("sr-bases-study-main");
        const title = main.createEl("a", { text: entry.basename, href: entry.path });
        attachObsidianLink(this.plugin, title, entry.path, entry.path);
        main.createSpan({
            cls: "sr-bases-study-decks",
            text: entry.decks.length ? entry.decks.join(" · ") : "No deck",
        });

        const stats = row.createDiv("sr-bases-study-stats");
        stats.createSpan({ text: `${entry.total} cards` });
        if (entry.due) stats.createSpan({ cls: "is-due", text: `${entry.due} due` });
        if (entry.newCards) stats.createSpan({ cls: "is-new", text: `${entry.newCards} new` });
        if (entry.retention !== null) {
            stats.createSpan({ text: `${Math.round(entry.retention * 100)}% retention` });
        }
        if (entry.stability !== null) {
            stats.createSpan({ text: `${Math.round(entry.stability)}d stability` });
        }
        if (entry.difficulty !== null) {
            stats.createSpan({ text: `${entry.difficulty.toFixed(1)} difficulty` });
        }
        if (entry.lastReviewAt) {
            stats.createSpan({
                text: `Reviewed ${new Date(entry.lastReviewAt).toLocaleDateString()}`,
            });
        }

        const actions = row.createDiv("sr-bases-study-actions");
        const noteRecords = records.filter((record) => record.notePath === entry.path);
        const expanded =
            this.expandedPaths.has(entry.path) || this.config.get("showCards") === true;
        new ButtonComponent(actions)
            .setIcon(expanded ? "chevron-up" : "chevron-down")
            .setTooltip(expanded ? "Hide cards" : "Show cards")
            .onClick(() => {
                if (expanded) this.expandedPaths.delete(entry.path);
                else this.expandedPaths.add(entry.path);
                this.render();
            });
        new ButtonComponent(actions)
            .setIcon("library-big")
            .setTooltip("Browse cards")
            .onClick(() => void this.plugin.uiManager.openCardBrowser(entry.path));
        new ButtonComponent(actions)
            .setIcon("play")
            .setTooltip("Review this note")
            .setCta()
            .onClick(
                () =>
                    void this.reviewRecords(
                        records.filter((record) => record.notePath === entry.path),
                    ),
            );
        new ButtonComponent(actions)
            .setIcon("ellipsis")
            .setTooltip("Edit note study data")
            .onClick((event) => this.openRowMenu(event, entry, noteRecords));

        if (expanded) this.renderCardRows(parent, entry.path, noteRecords);
    }

    private renderCardRows(
        parent: HTMLElement,
        notePath: string,
        records: CardBrowserRecord[],
    ): void {
        const children = parent.createDiv("sr-bases-study-card-list");
        children.setAttr("data-note", notePath);
        for (const record of records) {
            const card = children.createDiv("sr-bases-study-card-row");
            const state = card.createSpan({
                cls: `sr-bases-study-card-state is-${record.state}`,
                text: record.state,
            });
            state.setAttr("aria-label", `Card state: ${record.state}`);
            const text = card.createDiv("sr-bases-study-card-copy");
            text.createEl("strong", { text: compactCardText(record.front) || "Media card" });
            text.createSpan({ text: compactCardText(record.back) || "No text answer" });
            card.createSpan({
                cls: "sr-bases-study-card-deck",
                text: record.deckNames[0] ?? "No deck",
            });
            new ButtonComponent(card)
                .setIcon("pencil")
                .setTooltip("Edit card")
                .onClick(
                    () =>
                        void this.plugin.uiManager.openNativeCardEditor(
                            record.card,
                            record.deckNames[0],
                        ),
                );
        }
    }

    private openRowMenu(
        event: MouseEvent,
        entry: StudyBaseSummary,
        records: CardBrowserRecord[],
    ): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle("Rename source note")
                .setIcon("pencil-line")
                .onClick(() => this.promptRenameNote(entry)),
        );
        menu.addItem((item) =>
            item
                .setTitle("Move cards to deck")
                .setIcon("folder-input")
                .onClick(() => this.openDeckPicker(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle("Edit tags")
                .setIcon("tags")
                .onClick(() => this.openTags(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle("Assign knowledge area")
                .setIcon("library-big")
                .onClick(() => this.openAreaPicker(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle("Update Obsidian Properties")
                .setIcon("list-checks")
                .onClick(() => {
                    const file = this.plugin.app.vault.getFileByPath(entry.path);
                    if (file) void syncStudyProperties(this.plugin, [file]);
                }),
        );
        menu.showAtMouseEvent(event);
    }

    private renderEmpty(parent: HTMLElement, preset: StudyBasePreset): void {
        const empty = parent.createDiv("sr-bases-study-empty");
        setIcon(empty.createSpan(), preset === "all" ? "layers" : "filter-x");
        empty.createEl("strong", { text: "No matching study notes" });
        empty.createEl("span", {
            text:
                preset === "all"
                    ? "Add flashcards to the notes selected by this Base."
                    : "This study view is clear. Choose another view or adjust the Base filters.",
        });
    }

    private async exportResults(entries: StudyBaseSummary[]): Promise<void> {
        const rows = [
            [
                "Note",
                "Path",
                "Cards",
                "Due",
                "New",
                "Lapses",
                "Retention",
                "Decks",
                "Areas",
                "Tags",
            ],
            ...entries.map((entry) => [
                entry.basename,
                entry.path,
                entry.total,
                entry.due,
                entry.newCards,
                entry.lapses,
                entry.retention === null ? "" : Math.round(entry.retention * 1000) / 1000,
                entry.decks.join(" | "),
                entry.areas.join(" | "),
                entry.tags.join(" | "),
            ]),
        ];
        const csv = `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
        await this.writeCsvExport(csv, entries.length, "notes");
    }

    private async exportCards(records: CardBrowserRecord[]): Promise<void> {
        const rows = [
            [
                "Card ID",
                "Question",
                "Answer",
                "Path",
                "Deck",
                "Tags",
                "Area",
                "State",
                "Due",
                "Retention",
                "Lapses",
            ],
            ...records.map((record) => [
                record.id,
                compactCardText(record.front),
                compactCardText(record.back),
                record.notePath,
                record.deckNames[0] ?? "",
                record.tags.join(" | "),
                record.areaNames?.join(" | ") ?? "",
                record.state,
                record.dueDate ?? "",
                record.retention === null || record.retention === undefined
                    ? ""
                    : Math.round(record.retention * 1000) / 1000,
                record.lapses ?? 0,
            ]),
        ];
        const csv = `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
        await this.writeCsvExport(csv, records.length, "cards");
    }

    private async writeCsvExport(csv: string, count: number, unit: string): Promise<void> {
        const folder = normalizePath(
            this.plugin.dataManager.data.settings.scheduleDataVaultLocation,
        );
        const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
        const path = normalizePath(`${folder}/Study export ${stamp}.csv`);
        const file = await this.plugin.app.vault.create(path, csv);
        new Notice(`Exported ${count} ${unit}`);
        await this.plugin.app.workspace.getLeaf("tab").openFile(file);
    }

    private openCsvImport(): void {
        const files = this.plugin.app.vault
            .getFiles()
            .filter((file) => file.extension.toLocaleLowerCase() === "csv")
            .sort((left, right) => right.stat.mtime - left.stat.mtime);
        if (!files.length) {
            new Notice("No CSV files found in this vault");
            return;
        }
        new StudyChoicePrompt(
            this.plugin,
            "Import Study CSV",
            files.map((file) => ({ id: file.path, label: file.path })),
            (path) => void this.importCsv(path),
        ).open();
    }

    private async importCsv(path: string): Promise<void> {
        const file = this.plugin.app.vault.getFileByPath(path);
        if (!file) return;
        const rows = parseStudyCsv(await this.plugin.app.vault.read(file));
        if (!rows.length || !("Card ID" in rows[0])) {
            new Notice("This CSV has no editable card rows");
            return;
        }
        const records = createStudyRecords(this.plugin);
        const byId = new Map(records.map((record) => [record.id, record]));
        const matched = rows
            .map((row) => ({ row, record: byId.get(row["Card ID"]) }))
            .filter((entry): entry is { row: StudyCsvRow; record: CardBrowserRecord } =>
                Boolean(entry.record),
            );
        if (!matched.length) {
            new Notice("No exported card IDs match the current collection");
            return;
        }

        const store = new NativeCardStore(this.plugin);
        const areaSnapshot = this.plugin.dataManager.data.knowledgeAreas.map((area) => ({
            id: area.id,
            deckPaths: [...area.deckPaths],
        }));
        const previousDecks = new Map<string, CardBrowserRecord[]>();
        const previousTags = new Map<string, CardBrowserRecord[]>();
        for (const { row, record } of matched) {
            const deck = record.deckNames[0] ?? "";
            previousDecks.set(deck, [...(previousDecks.get(deck) ?? []), record]);
            const tagKey = JSON.stringify(record.tags);
            previousTags.set(tagKey, [...(previousTags.get(tagKey) ?? []), record]);
            if (row.Deck !== undefined && row.Deck !== deck) {
                await store.moveCards(this.sources([record]), row.Deck);
            }
            const tags = row.Tags?.split(/[|,]/)
                .map((tag) => tag.trim().replace(/^#+/, ""))
                .filter(Boolean);
            if (tags && JSON.stringify(tags) !== JSON.stringify(record.tags)) {
                await store.setCardTags(this.sources([record]), tags);
            }
            if (row.Area !== undefined) {
                const areaName = row.Area.split("|")[0]?.trim();
                const target = this.plugin.dataManager.data.knowledgeAreas.find(
                    (area) => area.name.toLocaleLowerCase() === areaName?.toLocaleLowerCase(),
                );
                const effectiveDeck = row.Deck || deck;
                if (effectiveDeck) {
                    if (target) await store.assignDeckToKnowledgeArea(effectiveDeck, target.id);
                    else if (!areaName) await store.unassignDeckFromKnowledgeAreas(effectiveDeck);
                }
            }
        }
        this.setUndo("CSV import", async () => {
            for (const [deck, group] of previousDecks) {
                await store.moveCards(this.sources(group), deck);
            }
            for (const [tags, group] of previousTags) {
                await store.setCardTags(this.sources(group), JSON.parse(tags) as string[]);
            }
            for (const saved of areaSnapshot) {
                const area = this.plugin.dataManager.data.knowledgeAreas.find(
                    (candidate) => candidate.id === saved.id,
                );
                if (area) area.deckPaths = [...saved.deckPaths];
            }
            await this.plugin.dataManager.savePluginData();
        });
        this.selectedCardIds.clear();
        new Notice(`Imported edits for ${matched.length} cards`);
        refreshStudyBasesViews();
    }

    private promptSaveView(preset: StudyBasePreset): void {
        const defaultName = `Study ${preset === "all" ? "view" : preset}`;
        new StudyTextPrompt(this.plugin, "Save study view", defaultName, (name) => {
            void this.saveView(name, preset);
        }).open();
    }

    private async saveView(name: string, preset: StudyBasePreset): Promise<void> {
        const safeName = name.trim().replace(/[\\/:*?"<>|]/g, "-") || "Study view";
        const folder = normalizePath(
            this.plugin.dataManager.data.settings.scheduleDataVaultLocation,
        );
        let path = normalizePath(`${folder}/${safeName}.base`);
        let suffix = 2;
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = normalizePath(`${folder}/${safeName} ${suffix}.base`);
            suffix++;
        }
        const configuredSort = this.config.get("sort");
        const configuredColumns = this.config.get("columns");
        const content = [
            "filters:",
            "  and:",
            "    - 'file.ext == \"md\"'",
            "views:",
            `  - type: ${STUDY_BASES_VIEW_TYPE}`,
            `    name: ${safeName}`,
            `    preset: ${preset}`,
            `    showEmpty: ${this.config.get("showEmpty") === true}`,
            `    density: ${this.config.get("density") === "comfortable" ? "comfortable" : "compact"}`,
            `    rowMode: ${this.config.get("rowMode") === "cards" ? "cards" : "notes"}`,
            `    sort: ${typeof configuredSort === "string" ? configuredSort : "due"}`,
            `    columns: ${typeof configuredColumns === "string" ? configuredColumns : "learning"}`,
            `    showCards: ${this.config.get("showCards") === true}`,
            "",
        ].join("\n");
        const file = await this.plugin.app.vault.create(path, content);
        new Notice("Study Base view saved");
        await this.plugin.app.workspace.getLeaf("tab").openFile(file);
    }

    private promptRenameNote(entry: StudyBaseSummary): void {
        new StudyTextPrompt(this.plugin, "Rename source note", entry.basename, (name) => {
            void this.renameNote(entry.path, name);
        }).open();
    }

    private async renameNote(path: string, name: string): Promise<void> {
        const file = this.plugin.app.vault.getFileByPath(path);
        const safeName = name.trim().replace(/[\\/:*?"<>|]/g, "-");
        if (!file || !safeName || safeName === file.basename) return;
        const folder = file.parent?.path;
        const nextPath = normalizePath(
            `${folder && folder !== "/" ? `${folder}/` : ""}${safeName}.md`,
        );
        if (this.plugin.app.vault.getAbstractFileByPath(nextPath)) {
            new Notice("A note with this name already exists");
            return;
        }
        await this.plugin.app.fileManager.renameFile(file, nextPath);
        this.setUndo("Source note renamed", async () => {
            const renamed = this.plugin.app.vault.getFileByPath(nextPath);
            if (renamed) await this.plugin.app.fileManager.renameFile(renamed, path);
        });
        refreshStudyBasesViews();
    }

    private openAreaPicker(records: CardBrowserRecord[]): void {
        if (!records.length) return;
        new StudyAreaPicker(this.plugin, (areaId) => void this.assignArea(records, areaId)).open();
    }

    private async assignArea(records: CardBrowserRecord[], areaId: string | null): Promise<void> {
        const store = new NativeCardStore(this.plugin);
        const decks = [...new Set(records.flatMap((record) => record.deckNames).filter(Boolean))];
        const snapshot = this.plugin.dataManager.data.knowledgeAreas.map((area) => ({
            id: area.id,
            deckPaths: [...area.deckPaths],
        }));
        for (const deck of decks) {
            if (areaId) await store.assignDeckToKnowledgeArea(deck, areaId);
            else await store.unassignDeckFromKnowledgeAreas(deck);
        }
        this.setUndo("Knowledge area updated", async () => {
            for (const saved of snapshot) {
                const area = this.plugin.dataManager.data.knowledgeAreas.find(
                    (candidate) => candidate.id === saved.id,
                );
                if (area) area.deckPaths = [...saved.deckPaths];
            }
            await this.plugin.dataManager.savePluginData();
        });
        this.selectedPaths.clear();
        new Notice("Knowledge area updated");
        refreshStudyBasesViews();
    }

    private selectedRecords(records: CardBrowserRecord[]): CardBrowserRecord[] {
        return records.filter((record) => this.selectedPaths.has(record.notePath));
    }

    private async reviewRecords(records: CardBrowserRecord[]): Promise<void> {
        const stableIds = records
            .map((record) => record.card.stableId)
            .filter((id): id is string => Boolean(id));
        if (!stableIds.length) {
            new Notice("No indexed cards in the selection");
            return;
        }
        await this.plugin.uiManager.openDeckContainer(
            FlashcardReviewMode.Review,
            undefined,
            stableIds,
        );
    }

    private sources(records: CardBrowserRecord[]) {
        return records.map((record) => ({
            sourcePath: record.notePath,
            questionId: record.card.storageInfo?.questionId,
        }));
    }

    private legacyInputs(records: CardBrowserRecord[]) {
        return records.map((record) => ({
            sourcePath: record.notePath,
            questionId: record.card.storageInfo?.questionId ?? null,
            ordinal: record.card.cardIdx,
            deckPath: record.deckNames[0] ?? "",
            front: record.front,
            back: record.back,
        }));
    }

    private openDeckPicker(records: CardBrowserRecord[]): void {
        const store = new NativeCardStore(this.plugin);
        new DeckPickerModal(this.app, {
            decks: store.getDeckPaths(),
            current: records[0]?.deckNames[0] ?? "",
            onChoose: (deckPath) => void this.moveRecords(records, deckPath),
            onCreate: async (deckPath) => await store.createDeck(deckPath),
        }).open();
    }

    private async moveRecords(records: CardBrowserRecord[], deckPath: string): Promise<void> {
        const store = new NativeCardStore(this.plugin);
        const previous = new Map<string, CardBrowserRecord[]>();
        for (const record of records) {
            const deck = record.deckNames[0] ?? "";
            previous.set(deck, [...(previous.get(deck) ?? []), record]);
        }
        await store.moveCards(this.sources(records), deckPath);
        this.setUndo("Cards moved", async () => {
            for (const [deck, group] of previous) await store.moveCards(this.sources(group), deck);
        });
        this.selectedPaths.clear();
        new Notice("Cards moved");
        refreshStudyBasesViews();
    }

    private openTags(records: CardBrowserRecord[]): void {
        const shared = records.every(
            (record) => record.tags.join("\u0000") === records[0]?.tags.join("\u0000"),
        );
        new StudyTextPrompt(
            this.plugin,
            "Tags",
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
        const store = new NativeCardStore(this.plugin);
        const previous = new Map<string, CardBrowserRecord[]>();
        for (const record of records) {
            const key = JSON.stringify(record.tags);
            previous.set(key, [...(previous.get(key) ?? []), record]);
        }
        await store.setCardTags(this.sources(records), tags);
        this.setUndo("Tags updated", async () => {
            for (const [key, group] of previous) {
                await store.setCardTags(this.sources(group), JSON.parse(key) as string[]);
            }
        });
        this.selectedPaths.clear();
        new Notice("Tags updated");
        refreshStudyBasesViews();
    }

    private openMoreActions(event: MouseEvent, records: CardBrowserRecord[]): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle("Change note type")
                .setIcon("shapes")
                .onClick(() => this.openNoteTypePicker(records)),
        );
        menu.addItem((item) =>
            item
                .setTitle("Choose card template")
                .setIcon("layout-template")
                .onClick(() => this.openTemplatePicker(records)),
        );
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle("Set flag")
                .setIcon("flag")
                .onClick(() => window.setTimeout(() => this.openFlagMenu(event, records), 0)),
        );
        const allInactive = records.every((record) => record.lifecycleState !== "active");
        menu.addItem((item) =>
            item
                .setTitle(allInactive ? "Resume cards" : "Suspend cards")
                .setIcon(allInactive ? "play" : "pause")
                .onClick(() => void this.setSuspended(records, !allInactive)),
        );
        menu.showAtMouseEvent(event);
    }

    private openNoteTypePicker(records: CardBrowserRecord[]): void {
        const noteTypes = this.plugin.dataManager.collectionStore
            .getNoteTypes()
            .filter((type) => type.kind !== "image-occlusion" && !type.deletedAt);
        if (!noteTypes.length) {
            new Notice("No editable note types");
            return;
        }
        new StudyChoicePrompt(
            this.plugin,
            "Change note type",
            noteTypes.map((type) => ({
                id: type.id,
                label: `${type.name} · ${type.fields.length} fields · ${type.templates.length} templates`,
            })),
            (id) => void this.changeNoteType(records, id),
        ).open();
    }

    private async changeNoteType(records: CardBrowserRecord[], targetId: string): Promise<void> {
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const target = snapshot.noteTypes[targetId];
        if (!target) return;
        const notes = this.uniqueNotes(records, snapshot.notes).filter(
            (note) => note.source.kind === "managed" && note.noteTypeId !== targetId,
        );
        const previous = notes.map((note) => ({
            note: structuredClone(note),
            deck: records.find((record) => record.noteId === note.id)?.deckNames[0] ?? "",
        }));
        const store = new NativeCardStore(this.plugin);
        let changed = 0;
        for (const note of notes) {
            const fields = this.mapFields(note, snapshot.noteTypes[note.noteTypeId], target);
            const deck = records.find((record) => record.noteId === note.id)?.deckNames[0] ?? "";
            try {
                await store.updateStructuredNote(note, {
                    deckPath: deck,
                    noteTypeId: targetId,
                    fields,
                    tags: note.tags,
                    externalData: note.externalData,
                });
                changed++;
            } catch {
                // Continue with compatible managed notes and leave unsupported sources untouched.
            }
        }
        if (changed) {
            this.setUndo("Note type changed", async () => {
                for (const saved of previous) {
                    const current =
                        this.plugin.dataManager.collectionStore.getCollectionSnapshot().notes[
                            saved.note.id
                        ];
                    if (!current) continue;
                    await store.updateStructuredNote(current, {
                        deckPath: saved.deck,
                        noteTypeId: saved.note.noteTypeId,
                        fields: saved.note.fields,
                        tags: saved.note.tags,
                        externalData: saved.note.externalData,
                    });
                }
            });
        }
        this.selectedCardIds.clear();
        this.selectedPaths.clear();
        new Notice(`${changed} notes converted`);
        refreshStudyBasesViews();
    }

    private openTemplatePicker(records: CardBrowserRecord[]): void {
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const typeIds = new Set(records.map((record) => record.noteTypeId).filter(Boolean));
        const types = [...typeIds]
            .map((id) => snapshot.noteTypes[id ?? ""])
            .filter((type): type is NoteTypeDefinition => Boolean(type && !type.deletedAt));
        const choices = types.flatMap((type) => [
            { id: `${type.id}\u0000*`, label: `All templates · ${type.name}` },
            ...type.templates
                .filter((template) => template.enabled)
                .map((template) => ({
                    id: `${type.id}\u0000${template.id}`,
                    label: `${template.name} · ${type.name}`,
                })),
        ]);
        if (!choices.length) {
            new Notice("No compatible templates in the selection");
            return;
        }
        new StudyChoicePrompt(this.plugin, "Card template", choices, (id) => {
            const [noteTypeId, templateId] = id.split("\u0000");
            void this.changeTemplates(records, noteTypeId, templateId);
        }).open();
    }

    private async changeTemplates(
        records: CardBrowserRecord[],
        noteTypeId: string,
        templateId: string,
    ): Promise<void> {
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const notes = this.uniqueNotes(records, snapshot.notes).filter(
            (note) => note.source.kind === "managed" && note.noteTypeId === noteTypeId,
        );
        const previous = notes.map((note) => ({
            note: structuredClone(note),
            deck: records.find((record) => record.noteId === note.id)?.deckNames[0] ?? "",
        }));
        const store = new NativeCardStore(this.plugin);
        let changed = 0;
        for (const note of notes) {
            const externalData = { ...(note.externalData ?? {}) };
            if (templateId === "*") delete externalData.msreTemplateIds;
            else externalData.msreTemplateIds = [templateId];
            const deck = records.find((record) => record.noteId === note.id)?.deckNames[0] ?? "";
            await store.updateStructuredNote(note, {
                deckPath: deck,
                noteTypeId,
                fields: note.fields,
                tags: note.tags,
                externalData,
            });
            changed++;
        }
        if (changed) {
            this.setUndo("Card template changed", async () => {
                for (const saved of previous) {
                    const current =
                        this.plugin.dataManager.collectionStore.getCollectionSnapshot().notes[
                            saved.note.id
                        ];
                    if (!current) continue;
                    await store.updateStructuredNote(current, {
                        deckPath: saved.deck,
                        noteTypeId: saved.note.noteTypeId,
                        fields: saved.note.fields,
                        tags: saved.note.tags,
                        externalData: saved.note.externalData,
                    });
                }
            });
        }
        this.selectedCardIds.clear();
        this.selectedPaths.clear();
        new Notice(`${changed} notes updated`);
        refreshStudyBasesViews();
    }

    private uniqueNotes(
        records: CardBrowserRecord[],
        notes: Record<string, CollectionNote>,
    ): CollectionNote[] {
        return [...new Set(records.map((record) => record.noteId).filter(Boolean))]
            .map((id) => notes[id ?? ""])
            .filter((note): note is CollectionNote => Boolean(note && !note.deletedAt));
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

    private openFlagMenu(event: MouseEvent, records: CardBrowserRecord[]): void {
        const menu = new Menu();
        const labels = ["No flag", "Red", "Orange", "Green", "Blue", "Pink", "Turquoise", "Purple"];
        for (const flag of [0, 1, 2, 3, 4, 5, 6, 7] as CardFlag[]) {
            menu.addItem((item) =>
                item
                    .setTitle(labels[flag])
                    .setIcon(flag ? "flag" : "x")
                    .onClick(() => void this.setFlag(records, flag)),
            );
        }
        menu.showAtMouseEvent(event);
    }

    private async setFlag(records: CardBrowserRecord[], flag: CardFlag): Promise<void> {
        const previous = new Map<CardFlag, CardBrowserRecord[]>();
        for (const record of records) {
            previous.set(record.flag, [...(previous.get(record.flag) ?? []), record]);
        }
        await this.plugin.dataManager.collectionStore.setLegacyCardsFlag(
            this.legacyInputs(records),
            flag,
        );
        this.setUndo(flag ? "Flag set" : "Flags cleared", async () => {
            for (const [oldFlag, group] of previous) {
                await this.plugin.dataManager.collectionStore.setLegacyCardsFlag(
                    this.legacyInputs(group),
                    oldFlag,
                );
            }
        });
        this.selectedPaths.clear();
        new Notice(flag ? "Flag set" : "Flags cleared");
        refreshStudyBasesViews();
    }

    private async setSuspended(records: CardBrowserRecord[], suspended: boolean): Promise<void> {
        const previous = new Map<CardBrowserRecord["lifecycleState"], CardBrowserRecord[]>();
        for (const record of records) {
            previous.set(record.lifecycleState, [
                ...(previous.get(record.lifecycleState) ?? []),
                record,
            ]);
        }
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            this.legacyInputs(records),
            suspended ? "suspended" : "active",
        );
        this.setUndo(suspended ? "Cards suspended" : "Cards resumed", async () => {
            for (const [state, group] of previous) {
                await this.plugin.dataManager.collectionStore.setLegacyCardsState(
                    this.legacyInputs(group),
                    state,
                );
            }
        });
        this.selectedPaths.clear();
        new Notice(suspended ? "Cards suspended" : "Cards resumed");
        refreshStudyBasesViews();
    }
}
