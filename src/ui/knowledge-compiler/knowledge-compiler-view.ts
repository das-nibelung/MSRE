import {
    App,
    ButtonComponent,
    ItemView,
    Modal,
    Notice,
    SearchComponent,
    setIcon,
    TFile,
    WorkspaceLeaf,
} from "obsidian";

import { KNOWLEDGE_COMPILER_VIEW_TYPE } from "src/data/constants";
import { NativeCardDraft, NativeCardStore } from "src/data/native-card-store";
import { AiContextNote, AiProviderDescriptor } from "src/intelligence/ai-types";
import {
    CompiledKnowledgeCard,
    KnowledgeCompilation,
    prepareKnowledgeCompilation,
} from "src/intelligence/knowledge-compiler";
import {
    CompilerHistoryEntry,
    KnowledgeCompilerHistoryStore,
} from "src/intelligence/knowledge-compiler-history";
import {
    CompilerArtifactSnapshot,
    CompilerDiffItem,
    CompilerDiffPlan,
    CompilerOrphanAction,
    CompilerProposalSnapshot,
    planKnowledgeCompilerDiff,
} from "src/intelligence/knowledge-compiler-lifecycle";
import {
    knowledgeCompilerKey,
    knowledgeSourceFingerprint,
    KnowledgeSourceSection,
    splitKnowledgeSource,
} from "src/intelligence/knowledge-provenance";
import type SRPlugin from "src/main";
import { refreshKnowledgeGraphViews } from "src/ui/knowledge-graph/knowledge-graph-view";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";

interface CompilerContext {
    notes: AiContextNote[];
    allowedPaths: string[];
}

interface CompilerArtifact {
    path: string;
    mtime: number;
    key: string;
    conceptId: string;
    fingerprint: string;
    sectionId: string;
    concept: string;
    front: string;
    back: string;
    type: string;
    sourceQuote: string;
    deckPath: string;
    managed: boolean;
    status: "fresh" | "stale";
}

type ProposalDecision = "apply" | "manual" | "skip";

function textExcerpt(value: string, maximum = 700): string {
    return value
        .replace(/---[\s\S]*?---/, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum);
}

function displayError(error: unknown): string {
    if (error instanceof Error) return error.message.replaceAll("-", " ");
    return typeof error === "string" ? error : "Unknown error";
}

function frontmatterLink(value: unknown): string {
    if (Array.isArray(value)) return frontmatterLink(value[0]);
    if (typeof value !== "string") return "";
    return value
        .replace(/^\[\[|\]\]$/g, "")
        .split("|")[0]
        .trim();
}

function frontmatterText(value: unknown, fallback = ""): string {
    return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

class CompilerBatchModal extends Modal {
    private readonly selected = new Set<string>();
    private query = "";

    constructor(
        app: App,
        private readonly files: TFile[],
        private readonly onStart: (paths: string[]) => void,
    ) {
        super(app);
        this.files.forEach((file) => this.selected.add(file.path));
    }

    onOpen(): void {
        this.modalEl.addClass("sr-compiler-sheet");
        this.render();
    }

    private render(): void {
        this.contentEl.empty();
        const header = this.contentEl.createDiv("sr-compiler-sheet-header");
        const copy = header.createDiv();
        copy.createEl("h2", { text: "Batch compilation" });
        copy.createEl("p", {
            text: "Queue notes from a folder or a manual selection. Every note still receives its own diff before writing.",
        });
        const searchHost = this.contentEl.createDiv("sr-compiler-sheet-search");
        new SearchComponent(searchHost)
            .setPlaceholder("Filter by folder or note…")
            .setValue(this.query)
            .onChange((value) => {
                this.query = value;
                this.render();
            });
        const controls = this.contentEl.createDiv("sr-compiler-batch-controls");
        new ButtonComponent(controls).setButtonText("Select visible").onClick(() => {
            this.visibleFiles().forEach((file) => this.selected.add(file.path));
            this.render();
        });
        new ButtonComponent(controls).setButtonText("Clear").onClick(() => {
            this.selected.clear();
            this.render();
        });
        controls.createSpan({ text: `${this.selected.size} queued` });
        const list = this.contentEl.createDiv("sr-compiler-batch-list");
        for (const file of this.visibleFiles().slice(0, 300)) {
            const label = list.createEl("label", { cls: "sr-compiler-batch-row" });
            const input = label.createEl("input", { attr: { type: "checkbox" } });
            input.checked = this.selected.has(file.path);
            const title = label.createDiv();
            title.createEl("strong", { text: file.basename });
            title.createSpan({ text: file.parent?.path || "/" });
            input.addEventListener("change", () => {
                if (input.checked) this.selected.add(file.path);
                else this.selected.delete(file.path);
                this.render();
            });
        }
        const actions = this.contentEl.createDiv("sr-compiler-sheet-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText(`Review ${this.selected.size} notes`)
            .setCta()
            .setDisabled(!this.selected.size)
            .onClick(() => {
                this.onStart([...this.selected]);
                this.close();
            });
    }

    private visibleFiles(): TFile[] {
        const query = this.query.trim().toLocaleLowerCase();
        if (!query) return this.files;
        return this.files.filter((file) => file.path.toLocaleLowerCase().includes(query));
    }
}

class CompilerHistoryModal extends Modal {
    constructor(
        app: App,
        private readonly history: Array<{ path: string; entry: CompilerHistoryEntry }>,
        private readonly onRollback: (path: string, entry: CompilerHistoryEntry) => Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-compiler-sheet");
        this.contentEl.createEl("h2", { text: "Compilation history" });
        this.contentEl.createEl("p", {
            text: "Each operation stores exact before/after snapshots. Rollback refuses to overwrite files changed later by sync or manual edits.",
        });
        const list = this.contentEl.createDiv("sr-compiler-history-list");
        if (!this.history.length) {
            list.createEl("p", { text: "No compilation operations yet." });
            return;
        }
        for (const item of this.history.slice(0, 50)) {
            const row = list.createDiv("sr-compiler-history-row");
            const copy = row.createDiv();
            copy.createEl("strong", { text: item.entry.summary });
            copy.createSpan({
                text: `${new Date(item.entry.createdAt).toLocaleString()} · ${item.entry.files.length} files`,
            });
            const button = new ButtonComponent(row)
                .setButtonText(item.entry.rolledBackAt ? "Rolled back" : "Rollback")
                .setIcon("undo-2")
                .setDisabled(Boolean(item.entry.rolledBackAt))
                .onClick(async () => {
                    button.setDisabled(true);
                    await this.onRollback(item.path, item.entry);
                    this.close();
                });
        }
    }
}

export class KnowledgeCompilerView extends ItemView {
    private readonly store: NativeCardStore;
    private sourcePath = "";
    private sourceText = "";
    private sections: KnowledgeSourceSection[] = [];
    private selectedSectionId = "all";
    private artifacts: CompilerArtifact[] = [];
    private targetDeck = "";
    private providers: AiProviderDescriptor[] = [];
    private providerId = "";
    private context: CompilerContext = { notes: [], allowedPaths: [] };
    private compilation: KnowledgeCompilation | null = null;
    private diffPlan: CompilerDiffPlan | null = null;
    private readonly proposalDecisions = new Map<number, ProposalDecision>();
    private readonly orphanActions = new Map<string, CompilerOrphanAction>();
    private batchQueue: string[] = [];
    private batchActive = false;
    private compiledSourceFingerprint = "";
    private busy = false;
    private error = "";

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
        this.store = new NativeCardStore(plugin);
        this.providerId = plugin.dataManager.data.settings.aiPreferredProvider;
    }

    private get historyStore(): KnowledgeCompilerHistoryStore {
        return new KnowledgeCompilerHistoryStore(
            this.app.vault,
            this.plugin.dataManager.vaultWriter,
        );
    }

    getViewType(): string {
        return KNOWLEDGE_COMPILER_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Knowledge Compiler";
    }

    getIcon(): string {
        return "workflow";
    }

    async onOpen(): Promise<void> {
        this.contentEl.addClass("sr-knowledge-compiler");
        await this.loadProviders();
        const active = this.app.workspace.getActiveFile();
        if (!this.sourcePath && active?.extension === "md") await this.configureSource(active.path);
        else this.render();
    }

    onClose(): Promise<void> {
        this.contentEl.empty();
        return Promise.resolve();
    }

    private get activeSection(): KnowledgeSourceSection {
        return (
            this.sections.find((section) => section.id === this.selectedSectionId) ??
            this.sections[0]
        );
    }

    async configureSource(path?: string): Promise<void> {
        const file = path ? this.app.vault.getFileByPath(path) : this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            this.sourcePath = "";
            this.sourceText = "";
            this.sections = [];
            this.error = "Open a Markdown note and try again.";
            this.render();
            return;
        }
        this.sourcePath = file.path;
        this.sourceText = await this.app.vault.cachedRead(file);
        this.sections = splitKnowledgeSource(this.sourceText);
        if (!this.sections.some((section) => section.id === this.selectedSectionId)) {
            this.selectedSectionId = "all";
        }
        this.compilation = null;
        this.diffPlan = null;
        this.proposalDecisions.clear();
        this.orphanActions.clear();
        this.compiledSourceFingerprint = "";
        this.error = "";
        const suggestions = this.plugin.dataManager.semanticIndex.suggest(this.sourceText);
        this.targetDeck =
            this.targetDeck ||
            suggestions.decks[0]?.value ||
            `Compiled/${file.basename.replace(/[^\p{L}\p{N} -]+/gu, "").trim() || "Knowledge"}`;
        this.context = await this.buildContext(file);
        this.artifacts = this.inspectArtifacts();
        this.render();
    }

    private inspectArtifacts(): CompilerArtifact[] {
        const result: CompilerArtifact[] = [];
        const recordsByPath = new Map(
            createStudyRecords(this.plugin)
                .filter((record) => record.notePath)
                .map((record) => [record.notePath, record]),
        );
        for (const file of this.app.vault.getMarkdownFiles()) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
                Record<string, unknown> | undefined;
            if (frontmatterLink(frontmatter?.["sr-source"]) !== this.sourcePath) continue;
            const record = recordsByPath.get(file.path);
            const concept = frontmatterText(frontmatter?.["sr-concept"], file.basename);
            const sectionId = frontmatterText(frontmatter?.["sr-source-section"], "all");
            const section = this.sections.find((candidate) => candidate.id === sectionId);
            const expected = knowledgeSourceFingerprint(section?.text ?? this.sourceText);
            const fingerprint = frontmatterText(frontmatter?.["sr-source-fingerprint"]);
            result.push({
                path: file.path,
                mtime: file.stat.mtime,
                key: frontmatterText(
                    frontmatter?.["sr-compiler-key"],
                    knowledgeCompilerKey(this.sourcePath, concept),
                ),
                conceptId: frontmatterText(
                    frontmatter?.["sr-concept-id"],
                    knowledgeCompilerKey(this.sourcePath, concept),
                ),
                fingerprint,
                sectionId,
                concept,
                front: record?.front ?? "",
                back: record?.back ?? "",
                type: record?.cardType ?? "basic",
                sourceQuote: frontmatterText(frontmatter?.["sr-source-quote"]),
                deckPath: record?.deckNames[0] ?? "",
                managed:
                    frontmatter?.["sr-compiler-managed"] !== false &&
                    frontmatterText(frontmatter?.["sr-compiler-mode"]) !== "manual",
                status: fingerprint === expected ? "fresh" : "stale",
            });
        }
        return result.sort((left, right) => left.path.localeCompare(right.path));
    }

    private async loadProviders(): Promise<void> {
        try {
            this.providers = await this.plugin.ai.listProviders();
            if (!this.providers.some((provider) => provider.id === this.providerId)) {
                this.providerId = this.providers.find((provider) => provider.available)?.id ?? "";
            }
        } catch (error) {
            this.error = displayError(error);
        }
    }

    private openBatch(): void {
        const dataRoot = this.plugin.dataManager.data.settings.scheduleDataVaultLocation;
        const files = this.app.vault
            .getMarkdownFiles()
            .filter((file) => {
                if (file.path.startsWith(`${dataRoot}/Cards/`)) return false;
                const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
                    Record<string, unknown> | undefined;
                return !frontmatter?.["sr-source"] && !frontmatter?.["sr-compiler-version"];
            })
            .sort((left, right) => left.path.localeCompare(right.path));
        new CompilerBatchModal(this.app, files, (paths) => void this.startBatch(paths)).open();
    }

    private async startBatch(paths: string[]): Promise<void> {
        this.batchQueue = [...new Set(paths)];
        this.batchActive = this.batchQueue.length > 0;
        await this.openNextBatchSource();
    }

    private async openNextBatchSource(): Promise<void> {
        const next = this.batchQueue.shift();
        if (!next) {
            this.batchActive = false;
            new Notice("Batch compilation complete");
            return;
        }
        this.selectedSectionId = "all";
        await this.configureSource(next);
        await this.compile();
    }

    private async queueStaleSources(): Promise<void> {
        const stale = new Set<string>();
        for (const file of this.app.vault.getMarkdownFiles()) {
            const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
                Record<string, unknown> | undefined;
            const sourcePath = frontmatterLink(frontmatter?.["sr-source"]);
            if (!sourcePath || frontmatter?.["sr-compiler-managed"] === false) continue;
            const source = this.app.vault.getFileByPath(sourcePath);
            if (!(source instanceof TFile)) continue;
            const text = await this.app.vault.cachedRead(source);
            const sectionId = frontmatterText(frontmatter?.["sr-source-section"], "all");
            const section = splitKnowledgeSource(text).find(
                (candidate) => candidate.id === sectionId,
            );
            const fingerprint = frontmatterText(frontmatter?.["sr-source-fingerprint"]);
            if (!section || knowledgeSourceFingerprint(section.text) !== fingerprint) {
                stale.add(sourcePath);
            }
        }
        if (!stale.size) {
            new Notice("All compiled sources are current");
            return;
        }
        await this.startBatch([...stale]);
    }

    private async openHistory(): Promise<void> {
        const history = await this.historyStore.list();
        new CompilerHistoryModal(this.app, history, async (path, entry) => {
            const result = await this.historyStore.rollback(path, entry);
            await this.plugin.dataManager.sync();
            refreshKnowledgeGraphViews();
            if (result.conflicts.length) {
                new Notice(
                    `Rollback stopped for ${result.conflicts.length} files changed after compilation`,
                );
            } else {
                new Notice(
                    `Compilation rolled back: ${result.restored} restored, ${result.removed} removed`,
                );
            }
            if (this.sourcePath) await this.configureSource(this.sourcePath);
        }).open();
    }

    private async buildContext(source: TFile): Promise<CompilerContext> {
        const candidates = new Map<string, { title: string; excerpt?: string }>();
        for (const match of this.plugin.dataManager.semanticIndex.search(this.sourceText, 8)) {
            if (match.item.sourcePath && match.item.sourcePath !== source.path) {
                candidates.set(match.item.sourcePath, {
                    title: match.item.title,
                    excerpt: textExcerpt(match.item.text),
                });
            }
        }
        for (const path of Object.keys(this.app.metadataCache.resolvedLinks[source.path] ?? {})) {
            if (path !== source.path && !candidates.has(path)) {
                candidates.set(path, {
                    title: path.split("/").pop()?.replace(/\.md$/i, "") ?? path,
                });
            }
        }
        const notes: AiContextNote[] = [];
        for (const [path, candidate] of [...candidates].slice(0, 8)) {
            const file = this.app.vault.getFileByPath(path);
            if (!(file instanceof TFile)) continue;
            const excerpt = candidate.excerpt || textExcerpt(await this.app.vault.cachedRead(file));
            notes.push({ path, title: candidate.title, excerpt });
        }
        return { notes, allowedPaths: notes.map((note) => note.path) };
    }

    private render(): void {
        this.contentEl.empty();
        this.renderHeader();
        if (!this.sourcePath) {
            this.renderEmpty();
            return;
        }
        this.renderSourceStrip();
        if (this.error) this.contentEl.createDiv({ cls: "sr-compiler-error", text: this.error });
        if (this.compilation) this.renderCompilation(this.compilation);
        else this.renderBrief();
    }

    private renderHeader(): void {
        const header = this.contentEl.createDiv("sr-compiler-header");
        const title = header.createDiv("sr-compiler-title");
        const mark = title.createSpan("sr-compiler-mark");
        setIcon(mark, "workflow");
        const copy = title.createDiv();
        copy.createEl("h2", { text: "Knowledge Compiler" });
        copy.createSpan({ text: "Markdown → concepts → explainable study graph" });
        const actions = header.createDiv("sr-compiler-header-actions");
        const provider = actions.createEl("select", {
            cls: "dropdown sr-compiler-provider",
            attr: { "aria-label": "AI provider" },
        });
        for (const item of this.providers) {
            const option = provider.createEl("option", {
                value: item.id,
                text: `${item.label}${item.available ? "" : " · unavailable"}`,
            });
            option.disabled = !item.available;
        }
        provider.value = this.providerId;
        provider.addEventListener("change", () => {
            this.providerId = provider.value;
            this.plugin.dataManager.data.settings.aiPreferredProvider = provider.value;
            void this.plugin.dataManager.savePluginData();
        });
        new ButtonComponent(actions)
            .setIcon("history")
            .setTooltip("Compilation history")
            .onClick(() => void this.openHistory());
        new ButtonComponent(actions)
            .setIcon("list-checks")
            .setTooltip("Batch compile notes")
            .onClick(() => this.openBatch());
        new ButtonComponent(actions)
            .setIcon("refresh-ccw-dot")
            .setTooltip("Recompile stale sources")
            .onClick(() => void this.queueStaleSources());
        new ButtonComponent(actions)
            .setButtonText(this.busy ? "Compiling…" : "Compile")
            .setIcon("sparkles")
            .setCta()
            .setDisabled(this.busy || !this.activeSection?.text || !this.providerId)
            .onClick(() => void this.compile());
    }

    private renderEmpty(): void {
        const empty = this.contentEl.createDiv("sr-compiler-empty");
        const icon = empty.createSpan();
        setIcon(icon, "file-search");
        empty.createEl("h3", { text: "Choose a source note" });
        empty.createEl("p", {
            text: "The compiler reads Markdown, proposes atomic cards, and shows every dependency before writing anything.",
        });
        new ButtonComponent(empty)
            .setButtonText("Use active note")
            .setCta()
            .onClick(() => void this.configureSource());
        if (this.error) empty.createDiv({ cls: "sr-compiler-error", text: this.error });
    }

    private renderSourceStrip(): void {
        const strip = this.contentEl.createDiv("sr-compiler-source-strip");
        const source = strip.createDiv("sr-compiler-source-main");
        const icon = source.createSpan();
        setIcon(icon, "file-text");
        const copy = source.createDiv();
        copy.createEl("strong", {
            text: this.sourcePath.split("/").pop()?.replace(/\.md$/i, "") ?? this.sourcePath,
        });
        copy.createSpan({ text: this.sourcePath });

        const section = strip.createDiv("sr-compiler-section-picker");
        section.createEl("label", { text: "Scope" });
        const select = section.createEl("select", {
            cls: "dropdown",
            attr: { "aria-label": "Compilation scope" },
        });
        this.sections.forEach((item) =>
            select.createEl("option", { value: item.id, text: item.title }),
        );
        select.value = this.selectedSectionId;
        select.addEventListener("change", () => {
            this.selectedSectionId = select.value;
            this.compilation = null;
            this.diffPlan = null;
            this.artifacts = this.inspectArtifacts();
            this.render();
        });

        const lineage = strip.createDiv("sr-compiler-lineage");
        const scoped = this.artifacts.filter(
            (artifact) =>
                this.selectedSectionId === "all" || artifact.sectionId === this.selectedSectionId,
        );
        lineage.createEl("strong", { text: String(scoped.length) });
        lineage.createSpan({
            text: scoped.some((artifact) => artifact.status === "stale")
                ? "outputs · changes detected"
                : "traceable outputs",
            cls: scoped.some((artifact) => artifact.status === "stale") ? "is-stale" : "",
        });
        new ButtonComponent(strip)
            .setIcon("refresh-cw")
            .setTooltip("Reload source")
            .onClick(() => void this.configureSource(this.sourcePath));
    }

    private renderBrief(): void {
        const brief = this.contentEl.createDiv("sr-compiler-brief");
        const editorial = brief.createDiv("sr-compiler-brief-column");
        editorial.createEl("span", {
            cls: "sr-compiler-kicker",
            text: "V2 compilation contract",
        });
        editorial.createEl("h3", { text: "Recompile knowledge, not duplicate it." });
        const list = editorial.createEl("ul");
        list.createEl("li", { text: "Each card keeps its exact quote and source fingerprint." });
        list.createEl("li", { text: "Stable concept keys update previous output in place." });
        list.createEl("li", {
            text: "Every dependency remains editable in Markdown and the graph.",
        });

        const context = brief.createDiv("sr-compiler-brief-column is-context");
        context.createEl("span", { cls: "sr-compiler-kicker", text: "Compilation scope" });
        context.createEl("h3", { text: this.activeSection?.title ?? "Entire note" });
        context.createEl("p", {
            text: `${this.activeSection?.startLine ?? 1}–${this.activeSection?.endLine ?? 1} · ${this.context.notes.length} related notes`,
        });
        if (this.artifacts.length) {
            const statuses = context.createDiv("sr-compiler-artifact-statuses");
            for (const status of ["fresh", "stale"] as const) {
                const count = this.artifacts.filter(
                    (artifact) => artifact.status === status,
                ).length;
                if (count) {
                    statuses.createSpan({ text: `${count} ${status}`, cls: `is-${status}` });
                }
            }
        }
    }

    private rebuildDiffPlan(compilation: KnowledgeCompilation): CompilerDiffPlan {
        const proposals: CompilerProposalSnapshot[] = compilation.cards.map((card) => ({
            sourceIndex: card.sourceIndex,
            concept: card.concept.trim() || card.front.trim(),
            front: card.front,
            back: card.back,
            type: card.type,
            sourceQuote: card.sourceQuote ?? "",
            deckPath: this.targetDeck,
        }));
        const artifacts: CompilerArtifactSnapshot[] = this.artifacts
            .filter(
                (artifact) =>
                    this.selectedSectionId === "all" ||
                    artifact.sectionId === this.selectedSectionId,
            )
            .map((artifact) => ({
                path: artifact.path,
                key: artifact.key,
                conceptId: artifact.conceptId,
                concept: artifact.concept,
                front: artifact.front,
                back: artifact.back,
                type: artifact.type,
                sourceQuote: artifact.sourceQuote,
                deckPath: artifact.deckPath,
                sectionId: artifact.sectionId,
                managed: artifact.managed,
            }));
        return planKnowledgeCompilerDiff(this.sourcePath, proposals, artifacts);
    }

    private initialiseDiffDecisions(plan: CompilerDiffPlan): void {
        this.proposalDecisions.clear();
        this.orphanActions.clear();
        for (const item of plan.items) {
            if (item.proposalIndex !== null) {
                const card = this.compilation?.cards[item.proposalIndex];
                const applicable = item.kind !== "unchanged" && card?.selected;
                this.proposalDecisions.set(item.proposalIndex, applicable ? "apply" : "skip");
                if (card) card.selected = applicable;
            }
            if (item.kind === "orphan" && item.artifactPath) {
                this.orphanActions.set(item.artifactPath, "archive");
            }
        }
    }

    private diffForCard(card: CompiledKnowledgeCard): CompilerDiffItem | undefined {
        return this.diffPlan?.items.find((item) => item.proposalIndex === card.sourceIndex);
    }

    private renderCompilation(compilation: KnowledgeCompilation): void {
        if (!this.diffPlan) {
            this.diffPlan = this.rebuildDiffPlan(compilation);
            this.initialiseDiffDecisions(this.diffPlan);
        }
        const metrics = this.contentEl.createDiv("sr-compiler-metrics");
        this.metric(metrics, String(this.diffPlan.counts.create), "create");
        this.metric(metrics, String(this.diffPlan.counts.update), "update");
        this.metric(metrics, String(this.diffPlan.counts.rename), "rename");
        this.metric(metrics, String(this.diffPlan.counts.orphan), "orphaned");

        const summary = this.contentEl.createDiv("sr-compiler-summary");
        summary.createSpan({ cls: "sr-compiler-kicker", text: "Editable blueprint" });
        summary.createEl("h3", { text: compilation.summary });
        if (compilation.warnings.length) {
            summary.createSpan({
                text: `${compilation.warnings.length} checks need attention`,
                cls: "sr-compiler-warning-count",
            });
        }

        const workbench = this.contentEl.createDiv("sr-compiler-workbench");
        compilation.cards.forEach((card) => this.renderCard(workbench, card, compilation.cards));
        this.renderOrphans(workbench);
        this.renderApplyBar(compilation);
    }

    private metric(container: HTMLElement, value: string, label: string): void {
        const metric = container.createDiv("sr-compiler-metric");
        metric.createEl("strong", { text: value });
        metric.createSpan({ text: label });
    }

    private renderCard(
        container: HTMLElement,
        card: CompiledKnowledgeCard,
        allCards: CompiledKnowledgeCard[],
    ): void {
        const diff = this.diffForCard(card);
        const decision = this.proposalDecisions.get(card.sourceIndex) ?? "skip";
        const row = container.createDiv("sr-compiler-card");
        row.toggleClass("is-unselected", decision !== "apply");
        const rail = row.createDiv("sr-compiler-card-rail");
        const checkbox = rail.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = decision === "apply";
        checkbox.disabled = diff?.kind === "unchanged";
        checkbox.addEventListener("change", () => {
            card.selected = checkbox.checked;
            this.proposalDecisions.set(card.sourceIndex, checkbox.checked ? "apply" : "skip");
            row.toggleClass("is-unselected", !card.selected);
            this.updateApplyCount();
        });
        rail.createSpan({ text: String(card.sourceIndex + 1) });

        const body = row.createDiv("sr-compiler-card-body");
        const heading = body.createDiv("sr-compiler-card-heading");
        const concept = heading.createEl("input", {
            cls: "sr-compiler-concept-input",
            attr: { type: "text", "aria-label": "Concept" },
        });
        concept.value = card.concept || card.front;
        concept.addEventListener("input", () => (card.concept = concept.value));
        const badges = heading.createDiv("sr-compiler-card-badges");
        if (diff) {
            badges.createSpan({
                cls: `sr-compiler-badge is-diff-${diff.kind}`,
                text: diff.kind,
            });
        }
        badges.createSpan({
            cls: `sr-compiler-badge ${card.grounded ? "is-grounded" : "is-warning"}`,
            text: card.grounded ? "grounded" : "quote missing",
        });
        badges.createSpan({
            cls: "sr-compiler-badge",
            text: `${Math.round((card.confidence ?? 0) * 100)}% confidence`,
        });
        if (diff?.artifactPath && diff.kind !== "unchanged") {
            const manual = badges.createEl("button", {
                cls: "sr-compiler-manual-button",
                text: decision === "manual" ? "manual copy" : "keep manual",
                attr: { type: "button" },
            });
            manual.addEventListener("click", () => {
                const next =
                    this.proposalDecisions.get(card.sourceIndex) === "manual" ? "skip" : "manual";
                this.proposalDecisions.set(card.sourceIndex, next);
                card.selected = false;
                this.render();
            });
        }

        const fields = body.createDiv("sr-compiler-card-fields");
        const front = fields.createEl("textarea", {
            attr: { "aria-label": "Question", rows: "2" },
        });
        front.value = card.front;
        front.addEventListener("input", () => (card.front = front.value));
        const back = fields.createEl("textarea", {
            attr: { "aria-label": "Answer", rows: "2" },
        });
        back.value = card.back;
        back.addEventListener("input", () => (card.back = back.value));

        const evidence = body.createDiv("sr-compiler-evidence");
        evidence.createSpan({ text: "SOURCE", cls: "sr-compiler-kicker" });
        evidence.createEl("q", { text: card.sourceQuote || "No exact quote supplied" });
        this.renderDependencies(body, card, allCards);

        if (diff?.changes.length) {
            const changes = body.createDiv("sr-compiler-field-changes");
            changes.createSpan({ text: "WILL CHANGE", cls: "sr-compiler-kicker" });
            const list = changes.createDiv();
            for (const change of diff.changes) {
                const line = list.createDiv("sr-compiler-field-change");
                line.createEl("strong", { text: change.field });
                line.createEl("del", { text: change.before || "empty" });
                line.createEl("ins", { text: change.after || "empty" });
            }
        }

        if (card.issues.length) {
            const issues = body.createDiv("sr-compiler-issues");
            issues.createSpan({ text: `${card.qualityScore}/100` });
            issues.createSpan({
                text: card.issues
                    .map((issue) => issue.detail || issue.code.replaceAll("-", " "))
                    .join(" · "),
            });
        }
    }

    private renderOrphans(container: HTMLElement): void {
        const orphans = this.diffPlan?.items.filter((item) => item.kind === "orphan") ?? [];
        if (!orphans.length) return;
        const section = container.createDiv("sr-compiler-orphans");
        const header = section.createDiv("sr-compiler-orphans-header");
        const copy = header.createDiv();
        copy.createEl("h3", { text: "No longer generated" });
        copy.createEl("p", {
            text: "These cards disappeared from the source result. Archive is safe and reversible; delete moves the file to trash.",
        });
        header.createSpan({ text: String(orphans.length) });
        for (const item of orphans) {
            if (!item.artifactPath) continue;
            const artifactPath = item.artifactPath;
            const artifact = this.artifacts.find((candidate) => candidate.path === artifactPath);
            const row = section.createDiv("sr-compiler-orphan-row");
            const title = row.createDiv();
            title.createEl("strong", { text: artifact?.concept || artifactPath });
            title.createSpan({ text: artifactPath });
            const select = row.createEl("select", {
                cls: "dropdown",
                attr: { "aria-label": "Orphan action" },
            });
            for (const [value, label] of [
                ["archive", "Archive card"],
                ["manual", "Keep manual"],
                ["delete", "Move to trash"],
                ["ignore", "Do nothing"],
            ] as const) {
                select.createEl("option", { value, text: label });
            }
            select.value = this.orphanActions.get(artifactPath) ?? "archive";
            select.addEventListener("change", () => {
                this.orphanActions.set(artifactPath, select.value as CompilerOrphanAction);
                this.updateApplyCount();
            });
        }
    }

    private renderDependencies(
        body: HTMLElement,
        card: CompiledKnowledgeCard,
        allCards: CompiledKnowledgeCard[],
    ): void {
        const dependencies = body.createDiv("sr-compiler-dependencies");
        dependencies.createSpan({ text: "PREREQUISITES", cls: "sr-compiler-kicker" });
        const chips = dependencies.createDiv("sr-compiler-dependency-chips");
        const rerender = (): void => this.render();
        for (const index of card.prerequisiteCardIndexes) {
            const chip = chips.createEl("button", { cls: "sr-compiler-dependency-chip" });
            chip.createSpan({
                text: `#${index + 1} ${allCards[index]?.concept || allCards[index]?.front || "card"}`,
            });
            setIcon(chip.createSpan(), "x");
            chip.addEventListener("click", () => {
                card.prerequisiteCardIndexes = card.prerequisiteCardIndexes.filter(
                    (item) => item !== index,
                );
                rerender();
            });
        }
        for (const path of card.prerequisitePaths) {
            const chip = chips.createEl("button", { cls: "sr-compiler-dependency-chip" });
            chip.createSpan({ text: path });
            setIcon(chip.createSpan(), "x");
            chip.addEventListener("click", () => {
                card.prerequisitePaths = card.prerequisitePaths.filter((item) => item !== path);
                rerender();
            });
        }
        if (!card.prerequisiteCardIndexes.length && !card.prerequisitePaths.length) {
            chips.createSpan({ text: "foundation", cls: "is-foundation" });
        }
        const availableCards = allCards.filter(
            (candidate) => candidate.sourceIndex < card.sourceIndex,
        );
        if (availableCards.length || this.context.notes.length) {
            const add = dependencies.createDiv("sr-compiler-dependency-add");
            const select = add.createEl("select", {
                cls: "dropdown",
                attr: { "aria-label": "Add prerequisite" },
            });
            select.createEl("option", { value: "", text: "Add prerequisite…" });
            availableCards.forEach((candidate) =>
                select.createEl("option", {
                    value: `card:${candidate.sourceIndex}`,
                    text: `#${candidate.sourceIndex + 1} ${candidate.concept || candidate.front}`,
                }),
            );
            this.context.notes.forEach((note) =>
                select.createEl("option", { value: `path:${note.path}`, text: note.title }),
            );
            select.addEventListener("change", () => {
                if (select.value.startsWith("card:")) {
                    const index = Number(select.value.slice(5));
                    card.prerequisiteCardIndexes = [
                        ...new Set([...card.prerequisiteCardIndexes, index]),
                    ];
                } else if (select.value.startsWith("path:")) {
                    const path = select.value.slice(5);
                    card.prerequisitePaths = [...new Set([...card.prerequisitePaths, path])];
                }
                rerender();
            });
        }
    }

    private renderApplyBar(compilation: KnowledgeCompilation): void {
        const bar = this.contentEl.createDiv("sr-compiler-apply");
        const destination = bar.createDiv("sr-compiler-destination");
        destination.createEl("label", { text: "Destination deck" });
        const input = destination.createEl("input", {
            attr: { type: "text", placeholder: "Knowledge/Topic" },
        });
        input.value = this.targetDeck;
        input.addEventListener("input", () => (this.targetDeck = input.value));
        input.addEventListener("change", () => {
            this.diffPlan = this.rebuildDiffPlan(compilation);
            this.render();
        });
        if (this.batchActive) {
            destination.createSpan({
                cls: "sr-compiler-batch-progress",
                text: `${this.batchQueue.length} notes remain after this one`,
            });
        }
        if (this.batchActive) {
            new ButtonComponent(bar)
                .setButtonText("Skip note")
                .setIcon("skip-forward")
                .onClick(() => void this.openNextBatchSource());
        }
        const action = new ButtonComponent(bar)
            .setButtonText("Apply selected")
            .setIcon("check")
            .setCta()
            .onClick(() => void this.applyCompilation(compilation));
        action.buttonEl.addClass("sr-compiler-apply-button");
        action.buttonEl.dataset.countTarget = "compiler-selection";
        this.updateApplyCount();
    }

    private updateApplyCount(): void {
        const button = this.contentEl.querySelector<HTMLButtonElement>(
            '[data-count-target="compiler-selection"]',
        );
        if (!button || !this.compilation) return;
        const proposals = [...this.proposalDecisions.values()].filter(
            (decision) => decision === "apply" || decision === "manual",
        ).length;
        const orphans = [...this.orphanActions.values()].filter(
            (action) => action !== "ignore",
        ).length;
        const count = proposals + orphans;
        button.setText(`Apply ${count} changes`);
        button.disabled = count === 0 || this.busy;
    }

    private async compile(): Promise<void> {
        const source = this.app.vault.getFileByPath(this.sourcePath);
        if (!(source instanceof TFile)) return;
        const latestText = await this.app.vault.cachedRead(source);
        const latestSections = splitKnowledgeSource(latestText);
        const latestSection = latestSections.find(
            (section) => section.id === this.selectedSectionId,
        );
        if (!latestSection) {
            this.error =
                "The selected source section changed. Reload the source and compile again.";
            this.render();
            return;
        }
        this.sourceText = latestText;
        this.sections = latestSections;
        this.artifacts = this.inspectArtifacts();
        const sourceText = latestSection.text;
        if (!sourceText || !this.providerId) return;
        this.busy = true;
        this.error = "";
        this.compilation = null;
        this.diffPlan = null;
        this.proposalDecisions.clear();
        this.orphanActions.clear();
        this.compiledSourceFingerprint = "";
        this.render();
        try {
            const result = await this.plugin.ai.run(this.providerId, {
                task: "compile-knowledge",
                locale: this.plugin.dataManager.data.settings.preferredLocale,
                sourceText,
                maximumCards: 12,
                contextNotes: this.context.notes,
            });
            this.compilation = prepareKnowledgeCompilation(
                result,
                sourceText,
                this.context.allowedPaths,
            );
            this.compiledSourceFingerprint = knowledgeSourceFingerprint(sourceText);
            this.diffPlan = this.rebuildDiffPlan(this.compilation);
            this.initialiseDiffDecisions(this.diffPlan);
        } catch (error) {
            this.error = displayError(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async applyCompilation(compilation: KnowledgeCompilation): Promise<void> {
        const plan = this.rebuildDiffPlan(compilation);
        this.diffPlan = plan;
        const selected = compilation.cards.filter(
            (card) => this.proposalDecisions.get(card.sourceIndex) === "apply",
        );
        const manual = compilation.cards.filter(
            (card) => this.proposalDecisions.get(card.sourceIndex) === "manual",
        );
        const section = this.activeSection;
        const orphanOperations = [...this.orphanActions].filter(
            ([, action]) => action !== "ignore",
        );
        if ((!selected.length && !manual.length && !orphanOperations.length) || !section) return;
        if (!this.targetDeck.trim()) {
            this.error = "Choose a destination deck.";
            this.render();
            return;
        }
        const selectedKeys = selected.map((card) =>
            knowledgeCompilerKey(this.sourcePath, card.concept.trim() || card.front.trim()),
        );
        if (new Set(selectedKeys).size !== selectedKeys.length) {
            this.error = "Give every selected proposal a unique concept before applying it.";
            this.render();
            return;
        }
        this.busy = true;
        this.updateApplyCount();
        let advanceBatch = false;
        try {
            const currentSource = this.app.vault.getFileByPath(this.sourcePath);
            if (!(currentSource instanceof TFile)) throw new Error("source-note-missing");
            const currentText = await this.app.vault.cachedRead(currentSource);
            const currentSection = splitKnowledgeSource(currentText).find(
                (candidate) => candidate.id === this.selectedSectionId,
            );
            if (
                !currentSection ||
                knowledgeSourceFingerprint(currentSection.text) !== this.compiledSourceFingerprint
            ) {
                throw new Error("source-changed-during-compilation");
            }
            await this.plugin.dataManager.collectionStore.createBackup(
                "before-knowledge-compile-v2",
            );
            const before = new Map<string, string | null>();
            const capture = async (path: string): Promise<void> => {
                if (before.has(path)) return;
                const file = this.app.vault.getFileByPath(path);
                before.set(path, file instanceof TFile ? await this.app.vault.read(file) : null);
            };
            const recordsByPath = new Map(
                createStudyRecords(this.plugin)
                    .filter((record) => record.notePath)
                    .map((record) => [record.notePath, record]),
            );
            const fileBySourceIndex = new Map<number, TFile>();
            let created = 0;
            let updated = 0;
            let renamed = 0;
            let archived = 0;
            let released = 0;
            let deleted = 0;

            await capture(this.sourcePath);
            for (const item of plan.items) {
                if (item.proposalIndex === null || !item.artifactPath) continue;
                const existing = this.app.vault.getFileByPath(item.artifactPath);
                if (existing instanceof TFile) fileBySourceIndex.set(item.proposalIndex, existing);
            }

            for (const card of manual) {
                const item = plan.items.find(
                    (candidate) => candidate.proposalIndex === card.sourceIndex,
                );
                if (!item?.artifactPath) continue;
                const file = this.app.vault.getFileByPath(item.artifactPath);
                if (!(file instanceof TFile)) continue;
                await capture(file.path);
                await this.markArtifactManual(file, "manual");
                released++;
            }

            for (const card of selected) {
                const draft: NativeCardDraft = {
                    deckPath: this.targetDeck,
                    type: card.type,
                    front: card.front,
                    back: card.back,
                    tags: [...new Set([...(card.tags ?? []), "compiled-knowledge"])],
                };
                const item = plan.items.find(
                    (candidate) => candidate.proposalIndex === card.sourceIndex,
                );
                const artifact = item?.artifactPath
                    ? this.artifacts.find((candidate) => candidate.path === item.artifactPath)
                    : undefined;
                const existing = artifact ? this.app.vault.getFileByPath(artifact.path) : null;
                const record = artifact ? recordsByPath.get(artifact.path) : undefined;
                let file: TFile;
                if (existing instanceof TFile && record) {
                    if (existing.stat.mtime !== artifact.mtime) {
                        throw new Error(`sync-conflict-${existing.path}`);
                    }
                    await capture(existing.path);
                    await this.store.updateCard(record.card, draft);
                    file = existing;
                    updated++;
                    if (item?.kind === "rename") renamed++;
                } else {
                    file = await this.store.createCard(draft);
                    before.set(file.path, null);
                    created++;
                }
                fileBySourceIndex.set(card.sourceIndex, file);
            }

            const fingerprint = knowledgeSourceFingerprint(section.text);
            for (const card of selected) {
                const file = fileBySourceIndex.get(card.sourceIndex);
                if (!file) continue;
                const paths = [
                    ...card.prerequisitePaths,
                    ...card.prerequisiteCardIndexes
                        .map((sourceIndex) => fileBySourceIndex.get(sourceIndex)?.path ?? "")
                        .filter(Boolean),
                ];
                const uniquePaths = [...new Set(paths)];
                const concept = card.concept.trim() || card.front.trim();
                const item = plan.items.find(
                    (candidate) => candidate.proposalIndex === card.sourceIndex,
                );
                const previousArtifact = item?.artifactPath
                    ? this.artifacts.find((artifact) => artifact.path === item.artifactPath)
                    : undefined;
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    const data = frontmatter as Record<string, unknown>;
                    data["sr-source"] = `[[${this.sourcePath}]]`;
                    data["sr-source-section"] = section.id;
                    data["sr-source-section-title"] = section.title;
                    data["sr-source-lines"] = `${section.startLine}-${section.endLine}`;
                    data["sr-source-fingerprint"] = fingerprint;
                    data["sr-concept"] = concept;
                    data["sr-concept-id"] =
                        previousArtifact?.conceptId ??
                        knowledgeCompilerKey(this.sourcePath, concept);
                    data["sr-source-quote"] = card.sourceQuote ?? "";
                    data["sr-prerequisites"] = uniquePaths.map((path) => `[[${path}]]`);
                    data["sr-dependency-reasons"] = Object.fromEntries(
                        uniquePaths.map((path) => [path, `Required before ${concept}`]),
                    );
                    data["sr-compiler-key"] = knowledgeCompilerKey(this.sourcePath, concept);
                    data["sr-compiler-version"] = 2;
                    data["sr-compiler-confidence"] = card.confidence ?? 0;
                    data["sr-compiler-managed"] = true;
                    data["sr-compiler-mode"] = "managed";
                    delete data["sr-compiler-status"];
                });
            }

            for (const [path, action] of orphanOperations) {
                const file = this.app.vault.getFileByPath(path);
                if (!(file instanceof TFile)) continue;
                const artifact = this.artifacts.find((candidate) => candidate.path === path);
                if (artifact && file.stat.mtime !== artifact.mtime) {
                    throw new Error(`sync-conflict-${file.path}`);
                }
                await capture(path);
                if (action === "delete") {
                    await this.app.vault.trash(file, true);
                    await this.plugin.dataManager.collectionStore.deleteNoteBySource(path);
                    deleted++;
                    continue;
                }
                if (action === "manual") {
                    await this.markArtifactManual(file, "manual");
                    released++;
                    continue;
                }
                const record = recordsByPath.get(path);
                if (record) {
                    await this.store.updateCard(record.card, {
                        deckPath: `Compiler Archive/${this.sourcePath
                            .split("/")
                            .pop()
                            ?.replace(/\.md$/i, "")}`,
                        type: record.cardType,
                        front: record.front,
                        back: record.back,
                        tags: [...new Set([...record.tags, "compiled-orphan"])],
                    });
                }
                await this.markArtifactManual(file, "archived");
                archived++;
            }

            const source = this.app.vault.getFileByPath(this.sourcePath);
            if (source instanceof TFile) {
                await this.app.fileManager.processFrontMatter(source, (frontmatter) => {
                    const data = frontmatter as Record<string, unknown>;
                    const previous = Array.isArray(data["sr-generated-cards"])
                        ? data["sr-generated-cards"].filter(
                              (value): value is string => typeof value === "string",
                          )
                        : [];
                    const removed = new Set(
                        orphanOperations
                            .filter(([, action]) => action === "archive" || action === "delete")
                            .map(([path]) => `[[${path}]]`),
                    );
                    data["sr-generated-cards"] = [
                        ...new Set([
                            ...previous.filter((path) => !removed.has(path)),
                            ...[...fileBySourceIndex.values()].map((file) => `[[${file.path}]]`),
                        ]),
                    ];
                    data["sr-compiler-last-version"] = 2;
                    data["sr-compiler-last-run"] = new Date().toISOString();
                });
            }
            await this.historyStore.record(
                [this.sourcePath],
                `${created} created · ${updated} updated · ${renamed} renamed · ${archived} archived · ${released} manual · ${deleted} deleted`,
                before,
            );
            await this.plugin.dataManager.sync();
            refreshKnowledgeGraphViews();
            new Notice(
                `Knowledge graph updated: ${created} created, ${updated} refreshed, ${renamed} renamed, ${archived} archived`,
            );
            this.compilation = null;
            this.diffPlan = null;
            if (this.batchActive) advanceBatch = true;
            else await this.configureSource(this.sourcePath);
        } catch (error) {
            this.error = displayError(error);
            new Notice(`Knowledge compilation failed: ${this.error}`);
            this.render();
        } finally {
            this.busy = false;
            this.updateApplyCount();
            if (advanceBatch) await this.openNextBatchSource();
        }
    }

    private async markArtifactManual(file: TFile, status: "manual" | "archived"): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            const data = frontmatter as Record<string, unknown>;
            data["sr-compiler-managed"] = false;
            data["sr-compiler-mode"] = "manual";
            data["sr-compiler-status"] = status;
            data["sr-compiler-detached-at"] = new Date().toISOString();
        });
    }
}
