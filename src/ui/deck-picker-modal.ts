import "src/ui/deck-picker-modal.css";
import { App, ButtonComponent, Modal, SearchComponent, setIcon } from "obsidian";

import { normalizeManagedDeckPath } from "src/data/native-card-store";
import { t } from "src/lang/helpers";

export interface DeckPickerOptions {
    decks: string[];
    current: string;
    allowAll?: boolean;
    onChoose: (deckPath: string) => void;
    onCreate?: (deckPath: string) => Promise<string>;
}

export class DeckPickerModal extends Modal {
    private query = "";
    private listEl: HTMLDivElement | null = null;

    constructor(
        app: App,
        private readonly options: DeckPickerOptions,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-deck-picker-modal");
        const header = this.contentEl.createDiv("sr-deck-picker-header");
        header.createEl("h2", { text: t("CHOOSE_DECK") });
        header.createEl("p", { text: t("CHOOSE_DECK_HELP") });

        const search = this.contentEl.createDiv("sr-deck-picker-search");
        new SearchComponent(search).setPlaceholder(t("SEARCH_DECKS")).onChange((value) => {
            this.query = value.trim().toLocaleLowerCase();
            this.renderList();
        });

        this.listEl = this.contentEl.createDiv("sr-deck-picker-list");
        this.renderList();

        if (this.options.onCreate) {
            const create = this.contentEl.createDiv("sr-deck-picker-create");
            const input = create.createEl("input", {
                attr: {
                    type: "text",
                    placeholder: t("NEW_DECK_PATH_PLACEHOLDER"),
                    "aria-label": t("NEW_DECK"),
                },
            });
            const button = new ButtonComponent(create)
                .setButtonText(t("CREATE_DECK"))
                .setCta()
                .onClick(async () => {
                    const path = normalizeManagedDeckPath(input.value);
                    if (!path || !this.options.onCreate) return;
                    button.setDisabled(true);
                    const created = await this.options.onCreate(path);
                    this.options.onChoose(created);
                    this.close();
                });
            input.addEventListener("keydown", (event) => {
                if (event.key === "Enter") void button.buttonEl.click();
            });
        }
    }

    private renderList(): void {
        if (!this.listEl) return;
        this.listEl.empty();
        const entries = [
            ...(this.options.allowAll ? [{ path: "all", label: t("ALL_DECKS") }] : []),
            ...this.options.decks.map((path) => ({
                path,
                label: path.split("/").slice(-1)[0] ?? path,
            })),
        ].filter(({ path, label }) => `${path} ${label}`.toLocaleLowerCase().includes(this.query));

        if (entries.length === 0) {
            this.listEl.createDiv({ cls: "sr-native-empty-state", text: t("NO_DECKS_MATCH") });
            return;
        }

        for (const { path, label } of entries) {
            const button = this.listEl.createEl("button", {
                cls: "sr-deck-picker-item",
                attr: { type: "button" },
            });
            button.toggleClass("is-selected", path === this.options.current);
            const icon = button.createSpan("sr-deck-picker-item-icon");
            setIcon(icon, path === "all" ? "layers-3" : "folder");
            const copy = button.createSpan("sr-deck-picker-item-copy");
            copy.createEl("strong", { text: label });
            if (path !== label && path !== "all") copy.createSpan({ text: path });
            const check = button.createSpan();
            if (path === this.options.current) setIcon(check, "check");
            button.addEventListener("click", () => {
                this.options.onChoose(path);
                this.close();
            });
        }
    }
}
