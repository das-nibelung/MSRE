import { ButtonComponent, ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import { KNOWLEDGE_COMPILER_VIEW_TYPE } from "src/data/constants";
import { NativeCardDraft, NativeCardStore } from "src/data/native-card-store";
import { AiContextNote, AiProviderDescriptor } from "src/intelligence/ai-types";
import {
    CompiledKnowledgeCard,
    KnowledgeCompilation,
    prepareKnowledgeCompilation,
} from "src/intelligence/knowledge-compiler";
import type SRPlugin from "src/main";
import { refreshKnowledgeGraphViews } from "src/ui/knowledge-graph/knowledge-graph-view";

interface CompilerContext {
    notes: AiContextNote[];
    allowedPaths: string[];
}

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

export class KnowledgeCompilerView extends ItemView {
    private readonly store: NativeCardStore;
    private sourcePath = "";
    private sourceText = "";
    private targetDeck = "";
    private providers: AiProviderDescriptor[] = [];
    private providerId = "";
    private context: CompilerContext = { notes: [], allowedPaths: [] };
    private compilation: KnowledgeCompilation | null = null;
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

    async configureSource(path?: string): Promise<void> {
        const file = path ? this.app.vault.getFileByPath(path) : this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            this.sourcePath = "";
            this.sourceText = "";
            this.error = "Open a Markdown note and try again.";
            this.render();
            return;
        }
        this.sourcePath = file.path;
        this.sourceText = await this.app.vault.cachedRead(file);
        this.compilation = null;
        this.error = "";
        const suggestions = this.plugin.dataManager.semanticIndex.suggest(this.sourceText);
        this.targetDeck =
            suggestions.decks[0]?.value ||
            `Compiled/${file.basename.replace(/[^\p{L}\p{N} -]+/gu, "").trim() || "Knowledge"}`;
        this.context = await this.buildContext(file);
        this.render();
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
        copy.createSpan({ text: "Source → atomic cards → explicit prerequisites" });
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
            .setButtonText(this.busy ? "Compiling…" : "Compile")
            .setIcon("sparkles")
            .setCta()
            .setDisabled(this.busy || !this.sourceText || !this.providerId)
            .onClick(() => void this.compile());
    }

    private renderEmpty(): void {
        const empty = this.contentEl.createDiv("sr-compiler-empty");
        const icon = empty.createSpan();
        setIcon(icon, "file-search");
        empty.createEl("h3", { text: "Choose a source note" });
        empty.createEl("p", {
            text: "The compiler reads one Markdown note, proposes atomic cards, and shows every dependency before writing anything.",
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
        const context = strip.createDiv("sr-compiler-context-count");
        context.createEl("strong", { text: String(this.context.notes.length) });
        context.createSpan({ text: "related notes" });
        new ButtonComponent(strip)
            .setIcon("refresh-cw")
            .setTooltip("Reload active source")
            .onClick(() => void this.configureSource());
    }

    private renderBrief(): void {
        const brief = this.contentEl.createDiv("sr-compiler-brief");
        const editorial = brief.createDiv("sr-compiler-brief-column");
        editorial.createEl("span", { cls: "sr-compiler-kicker", text: "Compilation rules" });
        editorial.createEl("h3", { text: "One claim. One test. One traceable source." });
        const list = editorial.createEl("ul");
        list.createEl("li", { text: "Every proposal carries an exact source quote." });
        list.createEl("li", {
            text: "Prerequisites point only backward or to related vault notes.",
        });
        list.createEl("li", { text: "Nothing is written until you accept the blueprint." });

        const context = brief.createDiv("sr-compiler-brief-column is-context");
        context.createEl("span", { cls: "sr-compiler-kicker", text: "Local context" });
        context.createEl("h3", { text: "Candidate prerequisites" });
        if (!this.context.notes.length) {
            context.createEl("p", {
                text: "No related indexed notes. The compiler can still build dependencies inside this source.",
            });
        } else {
            const links = context.createDiv("sr-compiler-context-list");
            this.context.notes.forEach((note) => {
                const item = links.createEl("button", { cls: "clickable-icon" });
                setIcon(item.createSpan(), "file-symlink");
                item.createSpan({ text: note.title });
                item.addEventListener(
                    "click",
                    () => void this.app.workspace.openLinkText(note.path, this.sourcePath, false),
                );
            });
        }
    }

    private renderCompilation(compilation: KnowledgeCompilation): void {
        const metrics = this.contentEl.createDiv("sr-compiler-metrics");
        this.metric(metrics, String(compilation.cards.length), "atomic units");
        this.metric(
            metrics,
            String(compilation.cards.filter((card) => card.grounded).length),
            "grounded",
        );
        this.metric(metrics, String(compilation.dependencyCount), "dependencies");
        this.metric(metrics, `${Math.round(compilation.sourceCoverage * 100)}%`, "quote coverage");

        const summary = this.contentEl.createDiv("sr-compiler-summary");
        summary.createSpan({ cls: "sr-compiler-kicker", text: "Blueprint" });
        summary.createEl("h3", { text: compilation.summary });
        if (compilation.warnings.length) {
            summary.createSpan({
                text: `${compilation.warnings.length} checks need attention`,
                cls: "sr-compiler-warning-count",
            });
        }

        const workbench = this.contentEl.createDiv("sr-compiler-workbench");
        compilation.cards.forEach((card) => this.renderCard(workbench, card, compilation.cards));
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
        const row = container.createDiv("sr-compiler-card");
        row.toggleClass("is-unselected", !card.selected);
        const rail = row.createDiv("sr-compiler-card-rail");
        const checkbox = rail.createEl("input", { attr: { type: "checkbox" } });
        checkbox.checked = card.selected;
        checkbox.addEventListener("change", () => {
            card.selected = checkbox.checked;
            row.toggleClass("is-unselected", !card.selected);
            this.updateApplyCount();
        });
        rail.createSpan({ text: String(card.sourceIndex + 1) });

        const body = row.createDiv("sr-compiler-card-body");
        const heading = body.createDiv("sr-compiler-card-heading");
        const concept = heading.createDiv();
        concept.createEl("strong", { text: card.concept || card.front });
        const badges = heading.createDiv("sr-compiler-card-badges");
        badges.createSpan({
            cls: `sr-compiler-badge ${card.grounded ? "is-grounded" : "is-warning"}`,
            text: card.grounded ? "grounded" : "quote missing",
        });
        badges.createSpan({
            cls: "sr-compiler-badge",
            text: `${Math.round((card.confidence ?? 0) * 100)}% confidence`,
        });

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

        const dependencies = body.createDiv("sr-compiler-dependencies");
        dependencies.createSpan({ text: "PREREQUISITES", cls: "sr-compiler-kicker" });
        const chips = dependencies.createDiv("sr-compiler-dependency-chips");
        for (const index of card.prerequisiteCardIndexes) {
            chips.createSpan({
                text: `#${index + 1} ${allCards[index]?.concept || allCards[index]?.front || "card"}`,
            });
        }
        for (const path of card.prerequisitePaths) chips.createSpan({ text: path });
        if (!card.prerequisiteCardIndexes.length && !card.prerequisitePaths.length) {
            chips.createSpan({ text: "foundation", cls: "is-foundation" });
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

    private renderApplyBar(compilation: KnowledgeCompilation): void {
        const bar = this.contentEl.createDiv("sr-compiler-apply");
        const destination = bar.createDiv("sr-compiler-destination");
        destination.createEl("label", { text: "Destination deck" });
        const input = destination.createEl("input", {
            attr: { type: "text", placeholder: "Knowledge/Topic" },
        });
        input.value = this.targetDeck;
        input.addEventListener("input", () => (this.targetDeck = input.value));
        const action = new ButtonComponent(bar)
            .setButtonText("Create selected")
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
        const count = this.compilation.cards.filter((card) => card.selected).length;
        button.setText(`Create ${count} selected`);
        button.disabled = count === 0 || this.busy;
    }

    private async compile(): Promise<void> {
        if (!this.sourceText || !this.providerId) return;
        this.busy = true;
        this.error = "";
        this.render();
        try {
            const result = await this.plugin.ai.run(this.providerId, {
                task: "compile-knowledge",
                locale: this.plugin.dataManager.data.settings.preferredLocale,
                sourceText: this.sourceText,
                maximumCards: 12,
                contextNotes: this.context.notes,
            });
            this.compilation = prepareKnowledgeCompilation(
                result,
                this.sourceText,
                this.context.allowedPaths,
            );
        } catch (error) {
            this.error = displayError(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async applyCompilation(compilation: KnowledgeCompilation): Promise<void> {
        const selected = compilation.cards.filter((card) => card.selected);
        if (!selected.length) return;
        if (!this.targetDeck.trim()) {
            this.error = "Choose a destination deck.";
            this.render();
            return;
        }
        this.busy = true;
        this.updateApplyCount();
        try {
            await this.plugin.dataManager.collectionStore.createBackup("before-knowledge-compile");
            const drafts: NativeCardDraft[] = selected.map((card) => ({
                deckPath: this.targetDeck,
                type: card.type,
                front: card.front,
                back: card.back,
                tags: [...new Set([...(card.tags ?? []), "compiled-knowledge"])],
            }));
            const files = await this.store.createCards(drafts);
            const pathBySourceIndex = new Map(
                selected.map((card, index) => [card.sourceIndex, files[index]?.path ?? ""]),
            );
            for (let index = 0; index < selected.length; index++) {
                const card = selected[index];
                const file = files[index];
                if (!(file instanceof TFile)) continue;
                const paths = [
                    ...card.prerequisitePaths,
                    ...card.prerequisiteCardIndexes
                        .map((sourceIndex) => pathBySourceIndex.get(sourceIndex) ?? "")
                        .filter(Boolean),
                ];
                await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    const data = frontmatter as Record<string, unknown>;
                    data["sr-source"] = `[[${this.sourcePath}]]`;
                    data["sr-concept"] = card.concept || card.front;
                    data["sr-source-quote"] = card.sourceQuote ?? "";
                    data["sr-prerequisites"] = [...new Set(paths)].map((path) => `[[${path}]]`);
                    data["sr-dependency-reasons"] = Object.fromEntries(
                        [...new Set(paths)].map((path) => [
                            path,
                            `Required before ${card.concept || card.front}`,
                        ]),
                    );
                    data["sr-compiler-version"] = 1;
                    data["sr-compiler-confidence"] = card.confidence ?? 0;
                });
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
                    data["sr-generated-cards"] = [
                        ...new Set([...previous, ...files.map((file) => `[[${file.path}]]`)]),
                    ];
                });
            }
            await this.plugin.dataManager.sync();
            refreshKnowledgeGraphViews();
            new Notice(`Created ${files.length} knowledge cards with traceable source metadata`);
            this.compilation = null;
            this.sourceText =
                source instanceof TFile ? await this.app.vault.cachedRead(source) : "";
            this.render();
        } catch (error) {
            this.error = displayError(error);
            new Notice(`Knowledge compilation failed: ${this.error}`);
        } finally {
            this.busy = false;
            this.updateApplyCount();
        }
    }
}
