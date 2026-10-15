import {
    ButtonComponent,
    FuzzySuggestModal,
    ItemView,
    Notice,
    setIcon,
    TFile,
    WorkspaceLeaf,
} from "obsidian";

import { INTELLIGENCE_CENTER_VIEW_TYPE } from "src/data/constants";
import { AiProviderDescriptor } from "src/intelligence/ai-types";
import {
    analyzeCollectionIntelligence,
    CollectionIntelligenceReport,
    IntelligenceFinding,
    IntelligenceFindingKind,
} from "src/intelligence/collection-intelligence";
import { extractIntelligenceSource, IntelligenceSource } from "src/intelligence/source-ingestion";
import { LocaleManagerInstance } from "src/lang/locale-manager";
import type SRPlugin from "src/main";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";
import { deriveQuickAddSeeds } from "src/ui/native-creator/quick-add";
import { collectKnowledgeRelations } from "src/ui/obsidian-integrations/knowledge-dependencies";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";

const SUPPORTED_EXTENSIONS = new Set([
    "md",
    "txt",
    "canvas",
    "pdf",
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bmp",
    "avif",
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "oga",
    "flac",
    "aac",
    "webm",
]);

const KIND_META: Record<IntelligenceFindingKind, { icon: string; en: string; ru: string }> = {
    duplicate: { icon: "copy-check", en: "Duplicates", ru: "Дубликаты" },
    contradiction: { icon: "split", en: "Contradictions", ru: "Противоречия" },
    gap: { icon: "puzzle", en: "Knowledge gaps", ru: "Пробелы" },
    atomicity: { icon: "scan-line", en: "Card quality", ru: "Качество" },
    split: { icon: "scissors-line-dashed", en: "Split cards", ru: "Разделение" },
    error: { icon: "brain-circuit", en: "Error patterns", ru: "Ошибки" },
};

function uiText(en: string, ru: string): string {
    return LocaleManagerInstance.getInstance().currentLocale.startsWith("ru") ? ru : en;
}

function errorText(error: unknown): string {
    return error instanceof Error
        ? error.message.replaceAll("-", " ")
        : typeof error === "string"
          ? error
          : "Unknown error";
}

class IntelligenceSourcePicker extends FuzzySuggestModal<TFile> {
    constructor(
        plugin: SRPlugin,
        private readonly choose: (file: TFile) => void,
    ) {
        super(plugin.app);
        this.setPlaceholder(
            uiText(
                "Choose Markdown, Canvas, PDF, image or audio…",
                "Выберите Markdown, Canvas, PDF, изображение или аудио…",
            ),
        );
    }

    getItems(): TFile[] {
        return this.app.vault
            .getFiles()
            .filter((file) => SUPPORTED_EXTENSIONS.has(file.extension.toLocaleLowerCase()))
            .sort((left, right) => right.stat.mtime - left.stat.mtime);
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.choose(item);
    }
}

export class IntelligenceCenterView extends ItemView {
    private report: CollectionIntelligenceReport | null = null;
    private filter: IntelligenceFindingKind | "all" = "all";
    private busy = false;
    private sourceBusy = false;
    private error = "";
    private source: IntelligenceSource | null = null;
    private providers: AiProviderDescriptor[] = [];
    private providerId = "";
    private records = new Map<string, CardBrowserRecord>();

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
    }

    getViewType(): string {
        return INTELLIGENCE_CENTER_VIEW_TYPE;
    }

    getDisplayText(): string {
        return uiText("Intelligence Center", "Центр интеллекта");
    }

    getIcon(): string {
        return "brain-circuit";
    }

    async onOpen(): Promise<void> {
        this.contentEl.addClass("sr-intelligence-center");
        await this.loadProviders();
        this.refresh();
    }

    onClose(): Promise<void> {
        this.contentEl.empty();
        return Promise.resolve();
    }

    refresh(): void {
        if (this.busy) return;
        this.busy = true;
        this.error = "";
        this.render();
        try {
            const records = createStudyRecords(this.plugin);
            this.records = new Map(records.map((record) => [record.id, record]));
            const notePaths = records.map((record) => record.notePath).filter(Boolean);
            const relations = collectKnowledgeRelations(this.app, notePaths);
            const relatedByNoteId: Record<string, Array<{ id: string; score: number }>> = {};
            for (const group of this.plugin.dataManager.semanticIndex.clusterConcepts(0.48)) {
                for (const id of group) {
                    relatedByNoteId[id] = group
                        .filter((candidate) => candidate !== id)
                        .slice(0, 8)
                        .map((candidate) => ({ id: candidate, score: 0.5 }));
                }
            }
            this.report = analyzeCollectionIntelligence({
                records,
                reviewLog: Object.values(
                    this.plugin.dataManager.collectionStore.getReviewLogSnapshot().entries,
                ),
                duplicateGroups:
                    this.plugin.dataManager.semanticIndex.findNearDuplicateGroups(0.82),
                relatedByNoteId,
                relations,
            });
        } catch (error) {
            this.error = errorText(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async loadProviders(): Promise<void> {
        try {
            this.providers = await this.plugin.ai.listProviders();
            const preferred = this.plugin.dataManager.data.settings.aiPreferredProvider;
            this.providerId =
                this.providers.find((provider) => provider.id === preferred && provider.available)
                    ?.id ??
                this.providers.find((provider) => provider.available)?.id ??
                "";
        } catch (error) {
            this.error = errorText(error);
        }
    }

    private render(): void {
        this.contentEl.empty();
        this.renderHeader();
        if (this.error)
            this.contentEl.createDiv({ cls: "sr-intelligence-error", text: this.error });
        const main = this.contentEl.createDiv("sr-intelligence-layout");
        this.renderAudit(main.createDiv("sr-intelligence-audit"));
        this.renderSourceLab(main.createDiv("sr-intelligence-source-lab"));
    }

    private renderHeader(): void {
        const header = this.contentEl.createDiv("sr-intelligence-header");
        const title = header.createDiv("sr-intelligence-title");
        const mark = title.createSpan("sr-intelligence-mark");
        setIcon(mark, "brain-circuit");
        const copy = title.createDiv();
        copy.createEl("h2", { text: uiText("Intelligence Center", "Центр интеллекта") });
        copy.createSpan({
            text: uiText(
                "Explainable local checks · optional AI",
                "Объяснимые локальные проверки · AI по желанию",
            ),
        });
        new ButtonComponent(header.createDiv("sr-intelligence-header-actions"))
            .setButtonText(
                this.busy ? uiText("Analyzing…", "Анализ…") : uiText("Run audit", "Проверить"),
            )
            .setIcon("refresh-cw")
            .setDisabled(this.busy)
            .onClick(() => void this.refresh());
    }

    private renderAudit(host: HTMLElement): void {
        const heading = host.createDiv("sr-intelligence-section-heading");
        const copy = heading.createDiv();
        copy.createEl("h3", { text: uiText("Collection audit", "Аудит коллекции") });
        copy.createSpan({
            text: this.report
                ? uiText(
                      `${this.report.cards} cards · ${this.report.findings.length} signals`,
                      `${this.report.cards} карточек · ${this.report.findings.length} сигналов`,
                  )
                : uiText("Preparing local analysis…", "Подготовка локального анализа…"),
        });
        if (!this.report) {
            host.createDiv("sr-intelligence-skeleton");
            return;
        }
        const filters = host.createDiv("sr-intelligence-filters");
        this.renderFilter(
            filters,
            "all",
            uiText("All", "Все"),
            this.report.findings.length,
            "list-filter",
        );
        for (const kind of Object.keys(KIND_META) as IntelligenceFindingKind[]) {
            const meta = KIND_META[kind];
            this.renderFilter(
                filters,
                kind,
                uiText(meta.en, meta.ru),
                this.report.counts[kind],
                meta.icon,
            );
        }
        const visible = this.report.findings.filter(
            (finding) => this.filter === "all" || finding.kind === this.filter,
        );
        const list = host.createDiv("sr-intelligence-findings");
        if (!visible.length) {
            const empty = list.createDiv("sr-intelligence-empty");
            setIcon(empty.createSpan(), "badge-check");
            empty.createEl("strong", {
                text: uiText("No signals in this category", "В этой категории проблем нет"),
            });
            empty.createSpan({
                text: uiText(
                    "The audit found nothing actionable.",
                    "Аудит не нашёл требующих действий сигналов.",
                ),
            });
            return;
        }
        visible.slice(0, 150).forEach((finding) => this.renderFinding(list, finding));
    }

    private renderFilter(
        host: HTMLElement,
        kind: IntelligenceFindingKind | "all",
        label: string,
        count: number,
        icon: string,
    ): void {
        const button = host.createEl("button", { cls: "sr-intelligence-filter" });
        button.toggleClass("is-active", this.filter === kind);
        setIcon(button.createSpan(), icon);
        button.createSpan({ text: label });
        button.createEl("small", { text: String(count) });
        button.addEventListener("click", () => {
            this.filter = kind;
            this.render();
        });
    }

    private renderFinding(host: HTMLElement, finding: IntelligenceFinding): void {
        const row = host.createDiv(`sr-intelligence-finding is-${finding.severity}`);
        const marker = row.createSpan("sr-intelligence-finding-icon");
        setIcon(marker, KIND_META[finding.kind].icon);
        const body = row.createDiv("sr-intelligence-finding-body");
        const top = body.createDiv("sr-intelligence-finding-top");
        top.createEl("strong", { text: finding.title });
        top.createEl("small", { text: `${Math.round(finding.confidence * 100)}%` });
        body.createSpan({ text: finding.summary });
        if (finding.evidence.length) {
            const evidence = body.createEl("details", { cls: "sr-intelligence-evidence" });
            evidence.createEl("summary", {
                text: uiText("Why this was flagged", "Почему это отмечено"),
            });
            finding.evidence.slice(0, 5).forEach((item) => evidence.createDiv({ text: item }));
        }
        const actions = row.createDiv("sr-intelligence-finding-actions");
        if (finding.sourcePaths[0]) {
            new ButtonComponent(actions)
                .setIcon("file-text")
                .setTooltip(uiText("Open source", "Открыть источник"))
                .onClick(
                    () => void this.app.workspace.openLinkText(finding.sourcePaths[0], "", false),
                );
        }
        if (finding.drafts.length) {
            new ButtonComponent(actions)
                .setIcon("list-plus")
                .setTooltip(uiText("Review proposed cards", "Проверить предложенные карточки"))
                .onClick(
                    () =>
                        void this.plugin.uiManager.tabViewManager.openNativeCreator({
                            mode: "card",
                            initialSeeds: finding.drafts,
                        }),
                );
        }
        if (this.providerId && ["atomicity", "split", "error"].includes(finding.kind)) {
            new ButtonComponent(actions)
                .setIcon("sparkles")
                .setTooltip(uiText("Ask AI for a reviewed rewrite", "Предложить исправление с AI"))
                .setDisabled(this.sourceBusy)
                .onClick(() => void this.improveFindingWithAi(finding));
        }
        new ButtonComponent(actions)
            .setIcon("rows-3")
            .setTooltip(uiText("Show in Cards", "Показать в Карточках"))
            .onClick(
                () =>
                    void this.plugin.uiManager.openCardBrowser(
                        finding.sourcePaths[0] ?? null,
                        finding.evidence[0] ?? "",
                    ),
            );
    }

    private renderSourceLab(host: HTMLElement): void {
        const heading = host.createDiv("sr-intelligence-section-heading");
        const copy = heading.createDiv();
        copy.createEl("h3", { text: uiText("Source lab", "Лаборатория источников") });
        copy.createSpan({
            text: uiText(
                "Markdown, Canvas, PDF, images and audio",
                "Markdown, Canvas, PDF, изображения и аудио",
            ),
        });
        const source = host.createDiv("sr-intelligence-source");
        if (this.source) {
            const icon = source.createSpan("sr-intelligence-source-icon");
            setIcon(
                icon,
                this.source.kind === "audio"
                    ? "audio-lines"
                    : this.source.kind === "image"
                      ? "image"
                      : "file-scan",
            );
            const sourceCopy = source.createDiv();
            sourceCopy.createEl("strong", {
                text: this.source.path.split("/").pop() ?? this.source.path,
            });
            sourceCopy.createSpan({
                text: uiText(
                    `${this.source.kind} · ${this.source.text.length.toLocaleString()} characters extracted`,
                    `${this.source.kind} · извлечено ${this.source.text.length.toLocaleString()} символов`,
                ),
            });
            new ButtonComponent(source)
                .setIcon("x")
                .setTooltip(uiText("Clear", "Очистить"))
                .onClick(() => {
                    this.source = null;
                    this.render();
                });
        } else {
            setIcon(source.createSpan("sr-intelligence-source-icon"), "file-up");
            const sourceCopy = source.createDiv();
            sourceCopy.createEl("strong", { text: uiText("Choose material", "Выберите материал") });
            sourceCopy.createSpan({
                text: uiText(
                    "Nothing leaves the vault until you run AI.",
                    "Ничего не покидает vault до запуска AI.",
                ),
            });
        }
        const sourceActions = host.createDiv("sr-intelligence-source-actions");
        new ButtonComponent(sourceActions)
            .setButtonText(uiText("Choose file", "Выбрать файл"))
            .setIcon("folder-search")
            .setDisabled(this.sourceBusy)
            .onClick(() =>
                new IntelligenceSourcePicker(
                    this.plugin,
                    (file) => void this.loadSource(file),
                ).open(),
            );
        new ButtonComponent(sourceActions)
            .setButtonText(uiText("Use active", "Текущий файл"))
            .setIcon("mouse-pointer-click")
            .setDisabled(this.sourceBusy)
            .onClick(() => {
                const file = this.app.workspace.getActiveFile();
                if (file) void this.loadSource(file);
                else new Notice(uiText("No active file", "Нет активного файла"));
            });
        if (this.source?.warnings.length) {
            const warnings = host.createDiv("sr-intelligence-source-warnings");
            this.source.warnings.forEach((warning) => warnings.createDiv({ text: warning }));
        }
        this.renderProvider(host);
    }

    private renderProvider(host: HTMLElement): void {
        const providerRow = host.createDiv("sr-intelligence-provider");
        const select = providerRow.createEl("select", {
            cls: "dropdown",
            attr: { "aria-label": uiText("AI provider", "AI-провайдер") },
        });
        if (!this.providers.some((provider) => provider.available)) {
            select.createEl("option", {
                text: uiText("No AI connected", "AI не подключён"),
                value: "",
            });
        }
        for (const provider of this.providers) {
            const option = select.createEl("option", {
                text: `${provider.label}${provider.available ? "" : " · unavailable"}`,
                value: provider.id,
            });
            option.disabled = !provider.available;
        }
        select.value = this.providerId;
        select.addEventListener("change", () => {
            this.providerId = select.value;
            this.plugin.dataManager.data.settings.aiPreferredProvider = this.providerId;
            void this.plugin.dataManager.savePluginData();
        });
        new ButtonComponent(providerRow)
            .setButtonText(
                this.sourceBusy
                    ? uiText("Working…", "Обработка…")
                    : uiText("Generate with AI", "Создать с AI"),
            )
            .setIcon("sparkles")
            .setCta()
            .setDisabled(!this.source || !this.providerId || this.sourceBusy)
            .onClick(() => void this.generateWithAi());
        new ButtonComponent(providerRow)
            .setButtonText(uiText("Local draft", "Локальный черновик"))
            .setIcon("shield-check")
            .setDisabled(!this.source?.text.trim() || this.sourceBusy)
            .onClick(() => this.reviewLocalDraft());
    }

    private async loadSource(file: TFile): Promise<void> {
        if (!SUPPORTED_EXTENSIONS.has(file.extension.toLocaleLowerCase())) {
            new Notice(
                uiText("This file type is not supported", "Этот тип файла не поддерживается"),
            );
            return;
        }
        this.sourceBusy = true;
        this.error = "";
        this.render();
        try {
            this.source = await extractIntelligenceSource(this.app, file);
        } catch (error) {
            this.error = errorText(error);
        } finally {
            this.sourceBusy = false;
            this.render();
        }
    }

    private reviewLocalDraft(): void {
        if (!this.source?.text.trim()) return;
        const seeds = deriveQuickAddSeeds(this.source.text).slice(0, 12);
        if (!seeds.length) {
            new Notice(
                uiText("No local card pattern found", "Локальный шаблон карточек не найден"),
            );
            return;
        }
        void this.plugin.uiManager.tabViewManager.openNativeCreator({
            mode: "card",
            initialSeeds: seeds,
        });
    }

    private async generateWithAi(): Promise<void> {
        if (!this.source || !this.providerId || this.sourceBusy) return;
        this.sourceBusy = true;
        this.error = "";
        this.render();
        try {
            const result = await this.plugin.ai.run(this.providerId, {
                task: "draft-cards",
                locale: LocaleManagerInstance.getInstance().currentLocale,
                sourceText:
                    this.source.text ||
                    `Create atomic study cards from the attached ${this.source.kind} source.`,
                attachments: this.source.attachments,
                maximumCards: 12,
            });
            if (!result.cards.length) throw new Error("ai-returned-no-cards");
            await this.plugin.uiManager.tabViewManager.openNativeCreator({
                mode: "card",
                deckPath: result.cards.find((card) => card.deckPath)?.deckPath,
                initialSeeds: result.cards.map((card) => ({
                    front: card.front,
                    back: card.back,
                    type: card.type,
                    sourceLabel: card.rationale || this.source?.path,
                })),
            });
        } catch (error) {
            this.error = errorText(error);
        } finally {
            this.sourceBusy = false;
            this.render();
        }
    }

    private async improveFindingWithAi(finding: IntelligenceFinding): Promise<void> {
        const record = finding.cardIds.map((id) => this.records.get(id)).find(Boolean);
        if (!record || !this.providerId || this.sourceBusy) return;
        this.sourceBusy = true;
        this.error = "";
        this.render();
        try {
            const result = await this.plugin.ai.run(this.providerId, {
                task:
                    finding.kind === "split" || finding.kind === "error"
                        ? "split-card"
                        : "improve-card",
                locale: LocaleManagerInstance.getInstance().currentLocale,
                sourceText: `${record.front}\n\n${record.back}`,
                currentCard: {
                    front: record.front,
                    back: record.back,
                    type: record.cardType,
                    tags: record.tags,
                    deckPath: record.deckNames[0] ?? "",
                },
                maximumCards: 12,
            });
            if (!result.cards.length) throw new Error("ai-returned-no-cards");
            await this.plugin.uiManager.tabViewManager.openNativeCreator({
                mode: "card",
                deckPath: record.deckNames[0],
                initialSeeds: result.cards.map((card) => ({
                    front: card.front,
                    back: card.back,
                    type: card.type,
                    sourceLabel: card.rationale || finding.title,
                })),
            });
        } catch (error) {
            this.error = errorText(error);
        } finally {
            this.sourceBusy = false;
            this.render();
        }
    }
}
