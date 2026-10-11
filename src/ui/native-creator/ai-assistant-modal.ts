import { App, ButtonComponent, Modal, setIcon } from "obsidian";

import { AiAssistantService } from "src/intelligence/ai-assistant";
import {
    AiAssistantRequest,
    AiAssistantResult,
    AiAssistantTask,
    AiCardDraft,
    AiProviderDescriptor,
} from "src/intelligence/ai-types";
import type SRPlugin from "src/main";

interface AiAssistantModalOptions {
    sourceText: string;
    currentCard?: AiAssistantRequest["currentCard"];
    onApply(cards: AiCardDraft[]): void;
}

const TASKS: Array<{ id: AiAssistantTask; icon: string; en: string; ru: string }> = [
    { id: "draft-cards", icon: "layers-3", en: "Draft cards", ru: "Создать карточки" },
    { id: "improve-card", icon: "wand-sparkles", en: "Improve", ru: "Улучшить" },
    { id: "split-card", icon: "split", en: "Split", ru: "Разделить" },
    { id: "make-cloze", icon: "scan-text", en: "Make cloze", ru: "Сделать cloze" },
    { id: "suggest-answer", icon: "message-square-text", en: "Answer", ru: "Дополнить ответ" },
];

export class AiAssistantModal extends Modal {
    private providers: AiProviderDescriptor[] = [];
    private providerId = "direct-api";
    private task: AiAssistantTask = "draft-cards";
    private sourceText: string;
    private busy = false;
    private error = "";
    private result: AiAssistantResult | null = null;
    private selected = new Set<number>();

    constructor(
        app: App,
        private readonly plugin: SRPlugin,
        private readonly service: AiAssistantService,
        private readonly options: AiAssistantModalOptions,
    ) {
        super(app);
        this.sourceText = options.sourceText;
        this.providerId = plugin.dataManager.data.settings.aiPreferredProvider;
        this.task = options.currentCard?.front ? "improve-card" : "draft-cards";
    }

    onOpen(): void {
        this.modalEl.addClass("sr-ai-assistant-modal");
        void this.loadProviders();
    }

    onClose(): void {
        this.contentEl.empty();
    }

    private async loadProviders(): Promise<void> {
        try {
            this.providers = await this.service.listProviders();
            if (!this.providers.some((provider) => provider.id === this.providerId)) {
                this.providerId = this.providers[0]?.id ?? "direct-api";
            }
        } catch (error) {
            this.error = error instanceof Error ? error.message : "Could not load AI providers";
        }
        this.render();
    }

    private text(en: string, ru: string): string {
        const locale = this.plugin.dataManager.data.settings.preferredLocale;
        return locale === "ru" || (locale === "-" && navigator.language.startsWith("ru")) ? ru : en;
    }

    private render(): void {
        this.contentEl.empty();
        const header = this.contentEl.createDiv("sr-ai-assistant-header");
        const mark = header.createDiv("sr-ai-assistant-mark");
        setIcon(mark, "sparkles");
        const title = header.createDiv();
        title.createEl("h2", { text: this.text("AI co-author", "AI-соавтор") });
        title.createEl("p", {
            text: this.text(
                "Generate a proposal first. Nothing is saved until you apply and save the card.",
                "Сначала создаётся предложение. Ничего не сохранится, пока вы не примените и не сохраните карточку.",
            ),
        });

        const taskRail = this.contentEl.createDiv("sr-ai-task-rail");
        for (const task of TASKS) {
            const button = taskRail.createEl("button", {
                attr: { type: "button", "aria-pressed": String(this.task === task.id) },
            });
            const icon = button.createSpan();
            setIcon(icon, task.icon);
            button.createSpan({ text: this.text(task.en, task.ru) });
            button.toggleClass("is-active", this.task === task.id);
            button.addEventListener("click", () => {
                this.task = task.id;
                this.result = null;
                this.error = "";
                this.render();
            });
        }

        const connection = this.contentEl.createDiv("sr-ai-connection");
        const connectionLabel = connection.createEl("label", {
            text: this.text("Connection", "Подключение"),
        });
        const select = connection.createEl("select", {
            attr: { "aria-label": connectionLabel.textContent ?? "Connection" },
        });
        for (const provider of this.providers) {
            const option = select.createEl("option", {
                text: provider.available ? provider.label : `${provider.label} · setup required`,
                attr: { value: provider.id },
            });
            option.disabled = !provider.available;
        }
        select.value = this.providerId;
        select.addEventListener("change", () => {
            this.providerId = select.value;
            this.plugin.dataManager.data.settings.aiPreferredProvider = select.value;
            void this.plugin.dataManager.settingsManager.save();
            this.error = "";
            this.render();
        });
        const activeProvider = this.providers.find((provider) => provider.id === this.providerId);
        connection.createEl("p", {
            text:
                activeProvider?.description ??
                this.text(
                    "Configure a provider in Data settings.",
                    "Настройте провайдера в разделе «Данные».",
                ),
        });

        const context = this.contentEl.createDiv("sr-ai-context");
        context.createEl("label", {
            text: this.text("Source sent to the provider", "Контекст, отправляемый провайдеру"),
        });
        const textarea = context.createEl("textarea", {
            attr: {
                placeholder: this.text(
                    "Paste a note, paragraph, or source material…",
                    "Вставьте заметку, абзац или исходный материал…",
                ),
                maxlength: "24000",
            },
        });
        textarea.value = this.sourceText;
        textarea.addEventListener("input", () => {
            this.sourceText = textarea.value;
        });
        context.createEl("small", {
            text:
                activeProvider?.kind === "api"
                    ? this.text(
                          "This text leaves the device only after you press Generate.",
                          "Текст покинет устройство только после нажатия «Создать».",
                      )
                    : activeProvider?.kind === "mcp"
                      ? this.text(
                            "The request is placed in the local MCP queue for Codex or another connected agent.",
                            "Запрос попадёт в локальную очередь MCP для Codex или другого подключённого агента.",
                        )
                      : this.text(
                            "The registered Obsidian plugin controls where this text is processed.",
                            "Зарегистрированный плагин Obsidian определяет, где будет обработан текст.",
                        ),
        });

        if (this.error) {
            this.contentEl.createDiv({
                cls: "sr-ai-error",
                text: this.errorText(this.error),
                attr: { role: "alert" },
            });
        }
        if (this.result) this.renderResult(this.result);

        const actions = this.contentEl.createDiv("sr-ai-actions");
        if (this.result) {
            new ButtonComponent(actions)
                .setButtonText(this.text("Try again", "Повторить"))
                .setDisabled(this.busy)
                .onClick(() => void this.generate());
            new ButtonComponent(actions)
                .setButtonText(
                    this.text(
                        `Apply ${this.selected.size || ""}`.trim(),
                        `Применить ${this.selected.size || ""}`.trim(),
                    ),
                )
                .setCta()
                .setDisabled(this.busy || this.selected.size === 0)
                .onClick(() => this.applySelected());
        } else {
            new ButtonComponent(actions)
                .setButtonText(
                    this.busy
                        ? this.text("Generating…", "Создание…")
                        : this.text("Generate proposal", "Создать предложение"),
                )
                .setCta()
                .setDisabled(this.busy || !activeProvider?.available)
                .onClick(() => void this.generate());
        }
    }

    private renderResult(result: AiAssistantResult): void {
        const section = this.contentEl.createDiv("sr-ai-result");
        const resultHeader = section.createDiv("sr-ai-result-header");
        resultHeader.createEl("strong", {
            text: this.text(
                `${result.cards.length} proposed card${result.cards.length === 1 ? "" : "s"}`,
                `Предложено карточек: ${result.cards.length}`,
            ),
        });
        if (result.summary) resultHeader.createSpan({ text: result.summary });
        result.cards.forEach((card, index) => {
            const row = section.createEl("label", { cls: "sr-ai-result-card" });
            const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
            checkbox.checked = this.selected.has(index);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) this.selected.add(index);
                else this.selected.delete(index);
                this.render();
            });
            const copy = row.createDiv();
            const meta = copy.createDiv("sr-ai-result-meta");
            meta.createSpan({ text: card.type === "cloze" ? "Cloze" : "Basic" });
            if (card.tags?.length) meta.createSpan({ text: card.tags.slice(0, 3).join(" · ") });
            copy.createEl("strong", { text: card.front });
            copy.createEl("p", { text: card.back });
            if (card.rationale) copy.createEl("small", { text: card.rationale });
        });
    }

    private async generate(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.error = "";
        this.result = null;
        this.selected.clear();
        this.render();
        try {
            this.result = await this.service.run(this.providerId, {
                task: this.task,
                locale: this.plugin.dataManager.data.settings.preferredLocale,
                sourceText: this.sourceText,
                currentCard: this.options.currentCard,
                maximumCards:
                    this.task === "improve-card" || this.task === "suggest-answer" ? 1 : 8,
            });
            this.result.cards.forEach((_card, index) => this.selected.add(index));
        } catch (error) {
            this.error = error instanceof Error ? error.message : "ai-request-failed";
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private applySelected(): void {
        if (!this.result) return;
        const cards = this.result.cards.filter((_card, index) => this.selected.has(index));
        if (cards.length === 0) return;
        this.options.onApply(cards);
        this.close();
    }

    private errorText(code: string): string {
        const known: Record<string, [string, string]> = {
            "ai-api-not-configured": [
                "Set the endpoint and model in Settings → Data → AI co-author.",
                "Укажите endpoint и модель в Настройки → Данные → AI-соавтор.",
            ],
            "ai-source-required": ["Add source text first.", "Сначала добавьте исходный текст."],
            "ai-mcp-timeout": [
                "The MCP agent did not answer in time. The request remains in the AI queue.",
                "MCP-агент не ответил вовремя. Запрос остался в очереди AI.",
            ],
            "ai-provider-unavailable": [
                "This provider is unavailable.",
                "Этот провайдер недоступен.",
            ],
            "invalid-ai-response": [
                "The provider returned an unsupported response.",
                "Провайдер вернул неподдерживаемый ответ.",
            ],
            "empty-ai-response": [
                "The provider did not return usable cards.",
                "Провайдер не вернул пригодных карточек.",
            ],
        };
        const message = known[code];
        return message ? this.text(message[0], message[1]) : code;
    }
}
