import "src/ui/native-creator/native-creator-view.css";
import { ButtonComponent, ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from "obsidian";

import { CARD_BROWSER_VIEW_TYPE, CARD_CREATOR_VIEW_TYPE } from "src/data/constants";
import { Card } from "src/data/data-structures/card/card";
import { CardType } from "src/data/data-structures/card/questions/question";
import { CardFrontBackUtil } from "src/data/data-structures/card/questions/question-type";
import {
    NativeCardDraft,
    NativeCardStore,
    NativeCardType,
    normalizeManagedDeckPath,
    serializeNativeQuestion,
} from "src/data/native-card-store";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";

export type NativeCreatorMode = "card" | "deck";

export interface NativeCreatorRequest {
    mode: NativeCreatorMode;
    deckPath?: string;
    card?: Card;
}

export class NativeCreatorView extends ItemView {
    private request: NativeCreatorRequest = { mode: "card" };
    private readonly store: NativeCardStore;
    private selectedDeck = "";
    private cardType: NativeCardType = "basic";
    private front = "";
    private back = "";
    private busy = false;
    private error = "";
    private editingCard: Card | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
        this.store = new NativeCardStore(plugin);
    }

    getViewType(): string {
        return CARD_CREATOR_VIEW_TYPE;
    }

    getDisplayText(): string {
        if (this.editingCard) return t("EDIT_CARD");
        return this.request.mode === "deck" ? t("NEW_DECK") : t("NEW_CARD");
    }

    getIcon(): string {
        return this.request.mode === "deck" ? "layers-3" : "square-pen";
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass("sr-native-creator-view");
        this.render();
        return Promise.resolve();
    }

    configure(request: NativeCreatorRequest): void {
        const wasEditing = this.editingCard !== null;
        this.request = request;
        this.selectedDeck = request.deckPath ?? this.selectedDeck;
        this.editingCard = request.card ?? null;
        if (this.editingCard) this.loadCardForEditing(this.editingCard);
        else if (wasEditing) {
            this.front = "";
            this.back = "";
            this.cardType = "basic";
        }
        this.error = "";
        if (this.contentEl.isShown()) this.render();
    }

    private render(): void {
        this.contentEl.empty();
        this.contentEl.addClass("sr-native-creator-view");

        const page = this.contentEl.createDiv("sr-native-creator-page");
        const top = page.createDiv("sr-native-creator-top");
        const back = new ButtonComponent(top).setIcon("arrow-left").setTooltip(t("BACK_TO_CARDS"));
        back.buttonEl.addClass("sr-native-icon-button");
        back.onClick(() => void this.returnToCards());

        const heading = top.createDiv("sr-native-creator-heading");
        heading.createEl("h1", {
            text: this.editingCard
                ? t("EDIT_CARD")
                : this.request.mode === "deck"
                  ? t("NEW_DECK")
                  : t("NEW_CARD"),
        });
        heading.createEl("p", {
            text: this.editingCard
                ? t("EDIT_CARD_DESCRIPTION")
                : this.request.mode === "deck"
                  ? t("NEW_DECK_DESCRIPTION")
                  : t("NEW_CARD_DESCRIPTION"),
        });

        if (!this.editingCard) {
            const switcher = top.createDiv("sr-native-creator-switcher");
            this.createModeButton(switcher, "card", "square-pen", t("CARD"));
            this.createModeButton(switcher, "deck", "layers-3", t("DECK"));
        }

        const surface = page.createDiv("sr-native-creator-surface");
        if (this.request.mode === "deck") this.renderDeckForm(surface);
        else this.renderCardForm(surface);
    }

    private createModeButton(
        parent: HTMLElement,
        mode: NativeCreatorMode,
        iconName: string,
        label: string,
    ): void {
        const button = new ButtonComponent(parent).setTooltip(label);
        button.buttonEl.addClass("sr-native-switch-button");
        button.buttonEl.toggleClass("is-active", this.request.mode === mode);
        button.buttonEl.setAttribute("aria-pressed", String(this.request.mode === mode));
        const icon = button.buttonEl.createSpan("sr-native-switch-icon");
        setIcon(icon, iconName);
        button.buttonEl.createSpan({ text: label });
        button.onClick(() => {
            this.request = { mode, deckPath: this.selectedDeck };
            this.error = "";
            this.render();
        });
    }

    private renderCardForm(surface: HTMLElement): void {
        const deckGroup = this.createFieldGroup(surface, t("DECK"), t("DECK_PICKER_HELP"));
        if (this.editingCard) {
            deckGroup.createDiv({
                cls: "sr-native-readonly-value",
                text: this.selectedDeck || t("DEFAULT_DECK"),
            });
        } else {
            const deckButton = new ButtonComponent(deckGroup)
                .setButtonText(this.selectedDeck || t("DEFAULT_DECK"))
                .setClass("sr-native-picker")
                .onClick((event) => this.openDeckMenu(event));
            deckButton.buttonEl.setAttribute("aria-haspopup", "menu");
            const chevron = deckButton.buttonEl.createSpan("sr-native-picker-chevron");
            setIcon(chevron, "chevron-down");
        }

        const typeGroup = this.createFieldGroup(surface, t("CARD_TYPE"));
        const typeSwitcher = typeGroup.createDiv("sr-native-card-type-switcher");
        this.createCardTypeButton(typeSwitcher, "basic", t("CARD_TYPE_BASIC"), !!this.editingCard);
        this.createCardTypeButton(
            typeSwitcher,
            "reversed",
            t("CARD_TYPE_REVERSED"),
            !!this.editingCard,
        );
        this.createCardTypeButton(typeSwitcher, "cloze", t("CARD_TYPE_CLOZE"), !!this.editingCard);

        const frontLabel = this.cardType === "cloze" ? t("CLOZE_TEXT") : t("CARD_FRONT");
        const frontHelp = this.cardType === "cloze" ? t("CLOZE_TEXT_HELP") : undefined;
        const frontGroup = this.createFieldGroup(surface, frontLabel, frontHelp);
        const frontInput = frontGroup.createEl("textarea", {
            cls: "sr-native-textarea sr-native-textarea-front",
            attr: {
                placeholder:
                    this.cardType === "cloze"
                        ? t("CLOZE_TEXT_PLACEHOLDER")
                        : t("CARD_FRONT_PLACEHOLDER"),
                "aria-label": frontLabel,
                rows: "5",
            },
        });
        frontInput.value = this.front;
        frontInput.addEventListener("input", () => {
            this.front = frontInput.value;
            this.clearError();
        });

        const backGroup = this.createFieldGroup(
            surface,
            this.cardType === "cloze" ? t("CLOZE_ANSWER") : t("CARD_BACK"),
            this.cardType === "cloze" ? t("CLOZE_ANSWER_HELP") : undefined,
        );
        const backInput = backGroup.createEl("textarea", {
            cls: "sr-native-textarea",
            attr: {
                placeholder:
                    this.cardType === "cloze"
                        ? t("CLOZE_ANSWER_PLACEHOLDER")
                        : t("CARD_BACK_PLACEHOLDER"),
                "aria-label": this.cardType === "cloze" ? t("CLOZE_ANSWER") : t("CARD_BACK"),
                rows: this.cardType === "cloze" ? "2" : "5",
            },
        });
        backInput.value = this.back;
        backInput.addEventListener("input", () => {
            this.back = backInput.value;
            this.clearError();
        });

        if (this.error) {
            surface.createDiv({
                cls: "sr-native-form-error",
                text: this.error,
                attr: { role: "alert" },
            });
        }

        const actions = surface.createDiv("sr-native-form-actions");
        if (!this.editingCard) {
            const saveAnother = new ButtonComponent(actions)
                .setButtonText(t("SAVE_AND_ADD_ANOTHER"))
                .setDisabled(this.busy)
                .onClick(() => void this.saveCard(true));
            saveAnother.buttonEl.addClass("sr-native-secondary-action");
        }
        new ButtonComponent(actions)
            .setButtonText(
                this.busy ? t("SAVING") : this.editingCard ? t("SAVE_CHANGES") : t("SAVE_CARD"),
            )
            .setCta()
            .setDisabled(this.busy)
            .onClick(() => void this.saveCard(false));

        window.setTimeout(() => frontInput.focus(), 0);
    }

    private renderDeckForm(surface: HTMLElement): void {
        const nameGroup = this.createFieldGroup(surface, t("DECK_NAME"), t("DECK_NAME_HELP"));
        const input = nameGroup.createEl("input", {
            cls: "sr-native-input",
            attr: {
                type: "text",
                placeholder: t("DECK_NAME_PLACEHOLDER"),
                autocomplete: "off",
                "aria-label": t("DECK_NAME"),
            },
        });
        input.value = this.selectedDeck;
        input.addEventListener("input", () => {
            this.selectedDeck = input.value;
            this.clearError();
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") void this.saveDeck();
        });

        const preview = surface.createDiv("sr-native-deck-preview");
        const previewIcon = preview.createDiv("sr-native-deck-preview-icon");
        setIcon(previewIcon, "layers-3");
        const previewCopy = preview.createDiv();
        previewCopy.createSpan({ text: t("DECK_WILL_APPEAR_AS") });
        const previewName = previewCopy.createEl("strong", {
            text: normalizeManagedDeckPath(this.selectedDeck) || t("NEW_DECK"),
        });
        input.addEventListener("input", () => {
            previewName.setText(normalizeManagedDeckPath(input.value) || t("NEW_DECK"));
        });

        if (this.error) {
            surface.createDiv({
                cls: "sr-native-form-error",
                text: this.error,
                attr: { role: "alert" },
            });
        }

        const actions = surface.createDiv("sr-native-form-actions");
        new ButtonComponent(actions)
            .setButtonText(this.busy ? t("SAVING") : t("CREATE_DECK"))
            .setCta()
            .setDisabled(this.busy)
            .onClick(() => void this.saveDeck());
        window.setTimeout(() => input.focus(), 0);
    }

    private createFieldGroup(parent: HTMLElement, label: string, help?: string): HTMLDivElement {
        const group = parent.createDiv("sr-native-field");
        group.createEl("label", { text: label });
        if (help) group.createEl("p", { text: help });
        return group;
    }

    private createCardTypeButton(
        parent: HTMLElement,
        type: NativeCardType,
        label: string,
        disabled = false,
    ): void {
        const button = new ButtonComponent(parent)
            .setButtonText(label)
            .setDisabled(disabled && this.cardType !== type)
            .onClick(() => {
                if (disabled) return;
                this.cardType = type;
                this.error = "";
                this.render();
            });
        button.buttonEl.toggleClass("is-active", this.cardType === type);
        button.buttonEl.setAttribute("aria-pressed", String(this.cardType === type));
    }

    private openDeckMenu(event: MouseEvent): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle(t("DEFAULT_DECK"))
                .setIcon("inbox")
                .setChecked(this.selectedDeck === "")
                .onClick(() => {
                    this.selectedDeck = "";
                    this.render();
                }),
        );
        const deckPaths = this.store.getDeckPaths();
        if (deckPaths.length > 0) menu.addSeparator();
        for (const deckPath of deckPaths) {
            menu.addItem((item) =>
                item
                    .setTitle(deckPath)
                    .setIcon("layers-3")
                    .setChecked(deckPath === this.selectedDeck)
                    .onClick(() => {
                        this.selectedDeck = deckPath;
                        this.render();
                    }),
            );
        }
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(t("CREATE_NEW_DECK"))
                .setIcon("plus")
                .onClick(() => {
                    this.request = { mode: "deck" };
                    this.selectedDeck = "";
                    this.render();
                }),
        );
        menu.showAtMouseEvent(event);
    }

    private async saveCard(addAnother: boolean): Promise<void> {
        if (!this.front.trim() || !this.back.trim()) {
            this.error = t("CARD_FIELDS_REQUIRED");
            this.render();
            return;
        }
        if (this.cardType === "cloze" && !this.front.includes(this.back.trim())) {
            this.error = t("CLOZE_ANSWER_NOT_FOUND");
            this.render();
            return;
        }

        this.busy = true;
        this.error = "";
        this.render();
        try {
            const draft: NativeCardDraft = {
                deckPath: this.selectedDeck,
                type: this.cardType,
                front: this.front,
                back: this.back,
            };
            if (this.editingCard) await this.saveEditedCard(draft);
            else await this.store.createCard(draft);
            new Notice(this.editingCard ? t("CARD_UPDATED") : t("CARD_SAVED"));
            if (addAnother) {
                this.front = "";
                this.back = "";
                this.busy = false;
                this.render();
            } else {
                await this.returnToCards();
            }
        } catch (error) {
            this.busy = false;
            this.error =
                error instanceof Error && error.message === "cloze-pattern-unavailable"
                    ? t("CLOZE_PATTERN_UNAVAILABLE")
                    : t("CARD_SAVE_FAILED");
            this.render();
        }
    }

    private async saveDeck(): Promise<void> {
        if (!normalizeManagedDeckPath(this.selectedDeck)) {
            this.error = t("DECK_NAME_REQUIRED");
            this.render();
            return;
        }
        this.busy = true;
        this.error = "";
        this.render();
        try {
            this.selectedDeck = await this.store.createDeck(this.selectedDeck);
            this.busy = false;
            this.front = "";
            this.back = "";
            this.request = { mode: "card", deckPath: this.selectedDeck };
            new Notice(t("DECK_CREATED"));
            this.render();
        } catch {
            this.busy = false;
            this.error = t("DECK_SAVE_FAILED");
            this.render();
        }
    }

    private clearError(): void {
        this.error = "";
    }

    private loadCardForEditing(card: Card): void {
        const settings = this.plugin.dataManager.data.settings;
        const source = card.question.questionText.actualQuestion;
        const type = card.question.questionType;
        let separator = settings.multilineCardSeparator;
        this.cardType = "basic";

        if (type === CardType.SingleLineReversed || type === CardType.MultiLineReversed) {
            this.cardType = "reversed";
            separator =
                type === CardType.SingleLineReversed
                    ? settings.singleLineReversedCardSeparator
                    : settings.multilineReversedCardSeparator;
        } else if (type === CardType.SingleLineBasic) {
            separator = settings.singleLineCardSeparator;
        } else if (type === CardType.Cloze) {
            this.cardType = "cloze";
            const wrappers: [string, string][] = [
                ["==", "=="],
                ["**", "**"],
                ["{{", "}}"],
            ];
            for (const [open, close] of wrappers) {
                const start = source.indexOf(open);
                const end = start < 0 ? -1 : source.indexOf(close, start + open.length);
                if (start >= 0 && end > start) {
                    this.back = source.slice(start + open.length, end);
                    this.front = `${source.slice(0, start)}${this.back}${source.slice(
                        end + close.length,
                    )}`;
                    return;
                }
            }
            this.front = source;
            this.back = card.back.replace(/<[^>]*>/g, "").trim();
            return;
        }

        const index = source.indexOf(separator);
        this.front = index < 0 ? source : source.slice(0, index).trim();
        this.back = index < 0 ? card.back : source.slice(index + separator.length).trim();
    }

    private async saveEditedCard(draft: NativeCardDraft): Promise<void> {
        if (!this.editingCard) return;
        const settings = this.plugin.dataManager.data.settings;
        const question = this.editingCard.question;
        let modifiedText: string;
        if (question.questionType === CardType.SingleLineBasic) {
            modifiedText = `${draft.front.trim()}${settings.singleLineCardSeparator}${draft.back.trim()}`;
        } else if (question.questionType === CardType.SingleLineReversed) {
            modifiedText = `${draft.front.trim()}${settings.singleLineReversedCardSeparator}${draft.back.trim()}`;
        } else {
            modifiedText = serializeNativeQuestion(draft, settings);
        }
        const expanded = CardFrontBackUtil.expand(question.questionType, modifiedText, settings);
        if (expanded.length !== question.cards.length) throw new Error("card-count-changed");

        question.questionText.actualQuestion = modifiedText;
        await question.writeQuestion(settings);
        question.cards.forEach((card, index) => {
            card.front = expanded[index].front;
            card.back = expanded[index].back;
        });
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
    }

    private async returnToCards(): Promise<void> {
        await this.leaf.setViewState({ type: CARD_BROWSER_VIEW_TYPE, active: true });
    }
}
