import {
    BasesView,
    ButtonComponent,
    normalizePath,
    Notice,
    QueryController,
    setIcon,
    TFile,
} from "obsidian";

import type SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { createCardBrowserRecords } from "src/ui/card-browser/card-browser-model";
import { attachObsidianLink } from "src/ui/obsidian-integrations/obsidian-links";
import { aggregateStudyBaseEntries } from "src/ui/obsidian-integrations/study-bases-model";

export const STUDY_BASES_VIEW_TYPE = "personal-spaced-repetition-study";

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
        file = existing;
    } else {
        file = await plugin.app.vault.create(
            path,
            [
                "filters:",
                "  and:",
                "    - 'file.ext == \"md\"'",
                "views:",
                `  - type: ${STUDY_BASES_VIEW_TYPE}`,
                "    name: Study",
                "    showEmpty: false",
                "",
            ].join("\n"),
        );
        new Notice("Study Base created");
    }
    await plugin.app.workspace.getLeaf("tab").openFile(file);
    return file;
}

export class StudyBasesView extends BasesView {
    readonly type = STUDY_BASES_VIEW_TYPE;

    constructor(
        controller: QueryController,
        private readonly containerEl: HTMLElement,
        private readonly plugin: SRPlugin,
    ) {
        super(controller);
        this.containerEl.addClass("sr-bases-study-view");
    }

    onDataUpdated(): void {
        this.render();
    }

    private render(): void {
        this.containerEl.empty();
        const records = this.plugin.dataManager.isOsrCoreLoaded()
            ? createCardBrowserRecords(this.plugin.dataManager.osrCore.getAllCards())
            : [];
        const showEmpty = this.config.get("showEmpty") === true;
        const groups = this.data.groupedData;
        const allSummaries = aggregateStudyBaseEntries(
            this.data.data.map((entry) => ({
                path: entry.file.path,
                basename: entry.file.basename,
            })),
            records,
        );
        const summaryByPath = new Map(allSummaries.map((entry) => [entry.path, entry]));
        const visible = allSummaries.filter((entry) => showEmpty || entry.total > 0);

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
            "New",
            visible.reduce((sum, entry) => sum + entry.newCards, 0),
            "is-new",
        );

        const body = this.containerEl.createDiv("sr-bases-study-body");
        let renderedRows = 0;
        for (const group of groups) {
            const entries = group.entries
                .map((entry) => summaryByPath.get(entry.file.path))
                .filter((entry) => entry && (showEmpty || entry.total > 0));
            if (!entries.length) continue;
            if (group.hasKey()) {
                body.createEl("h3", {
                    cls: "sr-bases-study-group",
                    text: group.key?.toString() ?? "Other",
                });
            }
            for (const entry of entries) {
                if (!entry) continue;
                this.renderRow(body, entry);
                renderedRows++;
            }
        }
        if (!renderedRows) {
            const empty = body.createDiv("sr-bases-study-empty");
            setIcon(empty.createSpan(), "layers");
            empty.createEl("strong", { text: "No cards in this Base" });
            empty.createEl("span", {
                text: "Add flashcards to the notes selected by the Base, or enable “Show notes without cards”.",
            });
        }
    }

    private renderMetric(parent: HTMLElement, label: string, value: number, cls = ""): void {
        const metric = parent.createDiv(`sr-bases-study-metric ${cls}`);
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
    }

    private renderRow(
        parent: HTMLElement,
        entry: ReturnType<typeof aggregateStudyBaseEntries>[number],
    ): void {
        const row = parent.createDiv("sr-bases-study-row");
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

        const actions = row.createDiv("sr-bases-study-actions");
        new ButtonComponent(actions)
            .setIcon("library-big")
            .setTooltip("Browse cards")
            .onClick(() => void this.plugin.uiManager.openCardBrowser(entry.path));
        new ButtonComponent(actions)
            .setIcon("play")
            .setTooltip("Review this note")
            .setCta()
            .onClick(() => {
                const file = this.plugin.app.vault.getFileByPath(entry.path);
                if (file)
                    void this.plugin.uiManager.openDeckContainer(FlashcardReviewMode.Review, file);
            });
    }
}
