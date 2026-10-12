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
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";
import { DeckPickerModal } from "src/ui/deck-picker-modal";
import { attachObsidianLink } from "src/ui/obsidian-integrations/obsidian-links";
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
        await new NativeCardStore(this.plugin).moveCards(this.sources(records), deckPath);
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
        await new NativeCardStore(this.plugin).setCardTags(this.sources(records), tags);
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
        await this.plugin.dataManager.collectionStore.setLegacyCardsFlag(
            this.legacyInputs(records),
            flag,
        );
        this.selectedPaths.clear();
        new Notice(flag ? "Flag set" : "Flags cleared");
        refreshStudyBasesViews();
    }

    private async setSuspended(records: CardBrowserRecord[], suspended: boolean): Promise<void> {
        await this.plugin.dataManager.collectionStore.setLegacyCardsState(
            this.legacyInputs(records),
            suspended ? "suspended" : "active",
        );
        this.selectedPaths.clear();
        new Notice(suspended ? "Cards suspended" : "Cards resumed");
        refreshStudyBasesViews();
    }
}
