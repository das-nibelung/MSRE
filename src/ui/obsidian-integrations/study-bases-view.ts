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

import { CardFlag } from "src/data/collection/collection-types";
import { NativeCardStore } from "src/data/native-card-store";
import type SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { CardBrowserRecord, compactCardText } from "src/ui/card-browser/card-browser-model";
import { DeckPickerModal } from "src/ui/deck-picker-modal";
import { attachObsidianLink } from "src/ui/obsidian-integrations/obsidian-links";
import { syncStudyProperties } from "src/ui/obsidian-integrations/obsidian-study-integration";
import {
    aggregateStudyBaseEntries,
    filterStudyBaseSummaries,
    StudyBasePreset,
    StudyBaseSummary,
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
    private undoAction: UndoAction | null = null;

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

        this.renderToolbar(visible, records, preset);
        this.renderUndo();
        this.renderSelectionBar(records);
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
    ): void {
        const toolbar = this.containerEl.createDiv("sr-bases-study-toolbar");
        const allSelected =
            visible.length > 0 && visible.every((entry) => this.selectedPaths.has(entry.path));
        new ButtonComponent(toolbar)
            .setIcon(allSelected ? "square-check-big" : "list-checks")
            .setButtonText(allSelected ? "Clear all" : "Select all results")
            .onClick(() => {
                if (allSelected) this.selectedPaths.clear();
                else visible.forEach((entry) => this.selectedPaths.add(entry.path));
                this.render();
            });
        const spacer = toolbar.createDiv("sr-bases-study-toolbar-spacer");
        spacer.setAttr("aria-hidden", "true");
        new ButtonComponent(toolbar)
            .setIcon("download")
            .setTooltip("Export current results as CSV")
            .onClick(() => void this.exportResults(visible));
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
        if (!this.undoAction) return;
        const undo = this.containerEl.createDiv("sr-bases-study-undo");
        undo.createSpan({ text: this.undoAction.label });
        new ButtonComponent(undo)
            .setIcon("undo-2")
            .setButtonText("Undo")
            .onClick(() => void this.runUndo());
        new ButtonComponent(undo)
            .setIcon("x")
            .setTooltip("Dismiss")
            .onClick(() => {
                this.undoAction = null;
                this.render();
            });
    }

    private setUndo(label: string, run: () => Promise<void>): void {
        this.undoAction = { label, run };
    }

    private async runUndo(): Promise<void> {
        const action = this.undoAction;
        if (!action) return;
        this.undoAction = null;
        await action.run();
        new Notice("Change undone");
        refreshStudyBasesViews();
    }

    private renderSelectionBar(records: CardBrowserRecord[]): void {
        if (!this.selectedPaths.size) return;
        const selected = this.selectedRecords(records);
        const bar = this.containerEl.createDiv("sr-bases-study-selection");
        bar.createEl("strong", { text: `${this.selectedPaths.size} notes` });
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
                this.render();
            });
    }

    private renderMetric(parent: HTMLElement, label: string, value: number, cls = ""): void {
        const metric = parent.createDiv(`sr-bases-study-metric ${cls}`);
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
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
        const quote = (value: string | number | null): string =>
            `"${String(value ?? "").replaceAll('"', '""')}"`;
        const rows = [
            ["Note", "Path", "Cards", "Due", "New", "Lapses", "Retention", "Decks", "Areas"],
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
            ]),
        ];
        const csv = `${rows.map((row) => row.map(quote).join(",")).join("\n")}\n`;
        const folder = normalizePath(
            this.plugin.dataManager.data.settings.scheduleDataVaultLocation,
        );
        const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
        const path = normalizePath(`${folder}/Study export ${stamp}.csv`);
        const file = await this.plugin.app.vault.create(path, csv);
        new Notice(`Exported ${entries.length} notes`);
        await this.plugin.app.workspace.getLeaf("tab").openFile(file);
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
