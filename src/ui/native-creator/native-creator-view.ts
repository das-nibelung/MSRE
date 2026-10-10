import "src/ui/native-creator/native-creator-view.css";
import { ButtonComponent, ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from "obsidian";

import {
    BASIC_NOTE_TYPE_ID,
    CLOZE_NOTE_TYPE_ID,
    REVERSED_NOTE_TYPE_ID,
} from "src/data/collection/builtin-note-types";
import { DEFAULT_DECK_OPTIONS_ID } from "src/data/collection/collection-store";
import {
    CardTemplateDefinition,
    CollectionNote,
    DeckOptionsDefinition,
    FieldKind,
    NoteFieldDefinition,
    NoteTypeDefinition,
    NoteTypeKind,
} from "src/data/collection/collection-types";
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
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";

export type NativeCreatorMode = "card" | "deck" | "deck-options" | "area" | "note-type";

interface NoteTypeEditorDraft {
    id: string;
    name: string;
    kind: NoteTypeKind;
    fields: NoteFieldDefinition[];
    templates: CardTemplateDefinition[];
    css: string;
}

export interface NativeCreatorRequest {
    mode: NativeCreatorMode;
    deckPath?: string;
    card?: Card;
    editAreaId?: string;
    targetAreaId?: string;
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
    private editingAreaId: string | null = null;
    private areaName = "";
    private noteTypeDraft: NoteTypeEditorDraft | null = null;
    private selectedNoteTypeId = BASIC_NOTE_TYPE_ID;
    private customFieldValues: Record<string, string> = {};
    private editingStructuredNote: CollectionNote | null = null;
    private selectedDeckOptionsId = DEFAULT_DECK_OPTIONS_ID;
    private deckOptionsDraft: DeckOptionsDefinition | null = null;
    private deckDescription = "";
    private tagsText = "";

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
        if (this.request.mode === "area") {
            return this.editingAreaId ? t("EDIT_KNOWLEDGE_AREA") : t("NEW_KNOWLEDGE_AREA");
        }
        if (this.request.mode === "note-type") return t("NOTE_TYPES");
        if (this.request.mode === "deck-options") return t("DECK_OPTIONS");
        return this.request.mode === "deck" ? t("NEW_DECK") : t("NEW_CARD");
    }

    getIcon(): string {
        if (this.request.mode === "area") return "library-big";
        if (this.request.mode === "deck-options") return "sliders-horizontal";
        if (this.request.mode === "note-type") return "shapes";
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
        this.editingStructuredNote = null;
        this.editingAreaId = request.editAreaId ?? null;
        if (request.mode !== "note-type") this.noteTypeDraft = null;
        this.areaName = this.editingAreaId
            ? (this.store.getKnowledgeAreas().find((area) => area.id === this.editingAreaId)
                  ?.name ?? "")
            : "";
        if (request.mode === "deck-options") this.loadDeckOptionsDraft();
        if (this.editingCard) {
            const sourcePath = this.editingCard.storageInfo?.notePath ?? "";
            const structuredNote = this.plugin.dataManager.collectionStore.findNoteBySource(
                sourcePath,
                this.editingCard.storageInfo?.questionId,
            );
            this.tagsText = structuredNote?.tags.join(", ") ?? "";
            if (structuredNote && !structuredNote.noteTypeId.startsWith("builtin-")) {
                this.editingStructuredNote = structuredNote;
                this.selectedNoteTypeId = structuredNote.noteTypeId;
                this.customFieldValues = { ...structuredNote.fields };
                const structuredCard = Object.values(
                    this.plugin.dataManager.collectionStore.getCollectionSnapshot().cards,
                ).find((card) => !card.deletedAt && card.noteId === structuredNote.id);
                if (structuredCard) this.selectedDeck = structuredCard.deckPath;
            } else {
                this.loadCardForEditing(this.editingCard);
            }
        } else if (wasEditing) {
            this.front = "";
            this.back = "";
            this.cardType = "basic";
            this.customFieldValues = {};
            this.tagsText = "";
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
                : this.request.mode === "area"
                  ? this.editingAreaId
                      ? t("EDIT_KNOWLEDGE_AREA")
                      : t("NEW_KNOWLEDGE_AREA")
                  : this.request.mode === "note-type"
                    ? this.noteTypeDraft
                        ? t("EDIT_NOTE_TYPE")
                        : t("NOTE_TYPES")
                    : this.request.mode === "deck-options"
                      ? t("DECK_OPTIONS")
                      : this.request.mode === "deck"
                        ? t("NEW_DECK")
                        : t("NEW_CARD"),
        });
        heading.createEl("p", {
            text: this.editingCard
                ? t("EDIT_CARD_DESCRIPTION")
                : this.request.mode === "area"
                  ? t("KNOWLEDGE_AREA_DESCRIPTION")
                  : this.request.mode === "note-type"
                    ? t("NOTE_TYPES_DESCRIPTION")
                    : this.request.mode === "deck-options"
                      ? t("DECK_OPTIONS_DESCRIPTION")
                      : this.request.mode === "deck"
                        ? t("NEW_DECK_DESCRIPTION")
                        : t("NEW_CARD_DESCRIPTION"),
        });

        if (!this.editingCard && !this.editingAreaId && this.request.mode !== "deck-options") {
            const switcher = top.createDiv("sr-native-creator-switcher");
            this.createModeButton(switcher, "card", "square-pen", t("CARD"));
            this.createModeButton(switcher, "deck", "layers-3", t("DECK"));
            this.createModeButton(switcher, "area", "library-big", t("KNOWLEDGE_AREAS"));
            this.createModeButton(switcher, "note-type", "shapes", t("NOTE_TYPES"));
        }

        const surface = page.createDiv("sr-native-creator-surface");
        if (this.request.mode === "deck") this.renderDeckForm(surface);
        else if (this.request.mode === "deck-options") this.renderDeckOptionsForm(surface);
        else if (this.request.mode === "area") this.renderAreaForm(surface);
        else if (this.request.mode === "note-type") this.renderNoteTypeManager(surface);
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
            this.editingAreaId = null;
            this.areaName = "";
            this.noteTypeDraft = null;
            this.error = "";
            this.render();
        });
    }

    private renderCardForm(surface: HTMLElement): void {
        const deckGroup = this.createFieldGroup(surface, t("DECK"), t("DECK_PICKER_HELP"));
        const editingCustomType = this.editingStructuredNote
            ? this.plugin.dataManager.collectionStore.getNoteType(
                  this.editingStructuredNote.noteTypeId,
              )
            : null;
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

        const typeGroup = this.createFieldGroup(surface, t("NOTE_TYPES"));
        if (editingCustomType) {
            typeGroup.createDiv({
                cls: "sr-native-readonly-value",
                text: this.getNoteTypeDisplayName(editingCustomType),
            });
            this.renderCustomNoteFields(surface, editingCustomType);
            return;
        } else if (this.editingCard) {
            const typeSwitcher = typeGroup.createDiv("sr-native-card-type-switcher");
            this.createCardTypeButton(typeSwitcher, "basic", t("CARD_TYPE_BASIC"), true);
            this.createCardTypeButton(typeSwitcher, "reversed", t("CARD_TYPE_REVERSED"), true);
            this.createCardTypeButton(typeSwitcher, "cloze", t("CARD_TYPE_CLOZE"), true);
        } else {
            const noteType = this.getSelectedNoteType();
            const picker = new ButtonComponent(typeGroup)
                .setButtonText(this.getNoteTypeDisplayName(noteType))
                .setClass("sr-native-picker")
                .onClick((event) => this.openNoteTypeMenu(event));
            picker.buttonEl.setAttribute("aria-haspopup", "menu");
            const chevron = picker.buttonEl.createSpan("sr-native-picker-chevron");
            setIcon(chevron, "chevron-down");
            if (!noteType.id.startsWith("builtin-")) {
                this.renderCustomNoteFields(surface, noteType);
                return;
            }
        }

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

        this.renderTagsField(surface);

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

    private loadDeckOptionsDraft(optionsId?: string): void {
        const collection = this.plugin.dataManager.collectionStore;
        const deck = collection.getDeck(this.selectedDeck);
        const options = optionsId
            ? collection.getDeckOptionsById(optionsId)
            : collection.getDeckOptionsForPath(this.selectedDeck);
        if (!options) return;
        this.selectedDeckOptionsId = options.id;
        this.deckOptionsDraft = { ...options };
        this.deckDescription = deck?.description ?? "";
    }

    private renderDeckOptionsForm(surface: HTMLElement): void {
        if (!this.deckOptionsDraft) this.loadDeckOptionsDraft();
        const draft = this.deckOptionsDraft;
        if (!draft) return;
        const collection = this.plugin.dataManager.collectionStore;

        const identity = surface.createDiv("sr-native-options-identity");
        const identityIcon = identity.createDiv("sr-native-options-identity-icon");
        setIcon(identityIcon, "folder-cog");
        const identityCopy = identity.createDiv();
        identityCopy.createSpan({ text: t("DECK_OPTIONS_FOR") });
        identityCopy.createEl("strong", { text: this.selectedDeck || t("DEFAULT_DECK") });

        const presetGroup = this.createFieldGroup(
            surface,
            t("OPTIONS_PRESET"),
            t("OPTIONS_PRESET_HELP"),
        );
        const presetRow = presetGroup.createDiv("sr-native-preset-row");
        const presetPicker = new ButtonComponent(presetRow)
            .setButtonText(draft.name)
            .setClass("sr-native-picker")
            .onClick((event) => this.openDeckOptionsMenu(event));
        presetPicker.buttonEl.setAttribute("aria-haspopup", "menu");
        const chevron = presetPicker.buttonEl.createSpan("sr-native-picker-chevron");
        setIcon(chevron, "chevron-down");
        const duplicate = new ButtonComponent(presetRow)
            .setIcon("copy-plus")
            .setTooltip(t("DUPLICATE_PRESET"))
            .onClick(() => this.duplicateDeckOptionsDraft());
        duplicate.buttonEl.addClass("sr-native-icon-button");
        presetGroup.createDiv({
            cls: "sr-native-options-usage",
            text: t("PRESET_USAGE", {
                count: collection.countDecksForOptions(this.selectedDeckOptionsId),
            }),
        });

        const nameGroup = this.createFieldGroup(surface, t("PRESET_NAME"));
        const nameInput = nameGroup.createEl("input", {
            cls: "sr-native-input",
            attr: { type: "text", autocomplete: "off", "aria-label": t("PRESET_NAME") },
        });
        nameInput.value = draft.name;
        nameInput.addEventListener("input", () => {
            draft.name = nameInput.value;
            this.clearError();
        });

        const descriptionGroup = this.createFieldGroup(
            surface,
            t("DECK_DESCRIPTION"),
            t("DECK_DESCRIPTION_HELP"),
        );
        const description = descriptionGroup.createEl("textarea", {
            cls: "sr-native-textarea sr-native-description-input",
            attr: { rows: "3", "aria-label": t("DECK_DESCRIPTION") },
        });
        description.value = this.deckDescription;
        description.addEventListener("input", () => {
            this.deckDescription = description.value;
        });

        const limits = surface.createDiv("sr-native-options-section");
        limits.createEl("h2", { text: t("DAILY_LIMITS") });
        limits.createEl("p", { text: t("DAILY_LIMITS_HELP") });
        const limitGrid = limits.createDiv("sr-native-options-grid");
        this.createNumberControl(
            limitGrid,
            t("NEW_CARDS_PER_DAY"),
            draft.newCardsPerDay,
            0,
            9999,
            (value) => (draft.newCardsPerDay = value),
        );
        this.createNumberControl(
            limitGrid,
            t("REVIEWS_PER_DAY"),
            draft.reviewsPerDay,
            0,
            99999,
            (value) => (draft.reviewsPerDay = value),
        );

        const retention = surface.createDiv("sr-native-options-section");
        const retentionHeading = retention.createDiv("sr-native-options-heading");
        retentionHeading.createEl("h2", { text: t("DESIRED_RETENTION") });
        const retentionValue = retentionHeading.createEl("strong", {
            text: `${Math.round(draft.desiredRetention * 100)}%`,
        });
        retention.createEl("p", { text: t("DESIRED_RETENTION_HELP") });
        const slider = retention.createEl("input", {
            cls: "sr-native-range",
            attr: {
                type: "range",
                min: "70",
                max: "99",
                step: "1",
                "aria-label": t("DESIRED_RETENTION"),
            },
        });
        slider.value = String(Math.round(draft.desiredRetention * 100));
        slider.addEventListener("input", () => {
            draft.desiredRetention = Number(slider.value) / 100;
            retentionValue.setText(`${slider.value}%`);
        });

        const orderGroup = this.createFieldGroup(
            surface,
            t("NEW_CARD_ORDER"),
            t("NEW_CARD_ORDER_HELP"),
        );
        const order = orderGroup.createDiv("sr-native-order-switcher");
        for (const value of ["sequential", "random"] as const) {
            const button = new ButtonComponent(order)
                .setButtonText(value === "sequential" ? t("ORDER_SEQUENTIAL") : t("ORDER_RANDOM"))
                .onClick(() => {
                    draft.newCardOrder = value;
                    this.render();
                });
            button.buttonEl.toggleClass("is-active", draft.newCardOrder === value);
            button.buttonEl.setAttribute("aria-pressed", String(draft.newCardOrder === value));
        }

        if (this.error) {
            surface.createDiv({
                cls: "sr-native-form-error",
                text: this.error,
                attr: { role: "alert" },
            });
        }
        const actions = surface.createDiv("sr-native-form-actions");
        new ButtonComponent(actions)
            .setButtonText(this.busy ? t("SAVING") : t("SAVE_DECK_OPTIONS"))
            .setCta()
            .setDisabled(this.busy)
            .onClick(() => void this.saveDeckOptions());
    }

    private createNumberControl(
        parent: HTMLElement,
        label: string,
        value: number,
        min: number,
        max: number,
        onChange: (value: number) => void,
    ): void {
        const wrapper = parent.createDiv("sr-native-number-control");
        wrapper.createEl("label", { text: label });
        const input = wrapper.createEl("input", {
            cls: "sr-native-input",
            attr: {
                type: "number",
                min: String(min),
                max: String(max),
                inputmode: "numeric",
                "aria-label": label,
            },
        });
        input.value = String(value);
        input.addEventListener("input", () => {
            const next = Math.max(min, Math.min(max, Number(input.value)));
            onChange(Number.isFinite(next) ? Math.round(next) : min);
            this.clearError();
        });
    }

    private openDeckOptionsMenu(event: MouseEvent): void {
        const menu = new Menu();
        const collection = this.plugin.dataManager.collectionStore;
        for (const options of collection.getDeckOptions()) {
            menu.addItem((item) =>
                item
                    .setTitle(options.name)
                    .setIcon(
                        options.id === this.selectedDeckOptionsId ? "check" : "sliders-horizontal",
                    )
                    .setChecked(options.id === this.selectedDeckOptionsId)
                    .onClick(() => {
                        this.loadDeckOptionsDraft(options.id);
                        this.render();
                    }),
            );
        }
        menu.showAtMouseEvent(event);
    }

    private duplicateDeckOptionsDraft(): void {
        if (!this.deckOptionsDraft) return;
        this.deckOptionsDraft = {
            ...this.deckOptionsDraft,
            id: this.plugin.dataManager.collectionStore.createId("deck-options"),
            name: t("PRESET_COPY_NAME", { name: this.deckOptionsDraft.name }),
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.selectedDeckOptionsId = this.deckOptionsDraft.id;
        this.render();
    }

    private renderAreaForm(surface: HTMLElement): void {
        const nameGroup = this.createFieldGroup(
            surface,
            t("KNOWLEDGE_AREA_NAME"),
            t("KNOWLEDGE_AREA_NAME_HELP"),
        );
        const input = nameGroup.createEl("input", {
            cls: "sr-native-input",
            attr: {
                type: "text",
                placeholder: t("KNOWLEDGE_AREA_NAME_PLACEHOLDER"),
                autocomplete: "off",
                "aria-label": t("KNOWLEDGE_AREA_NAME"),
            },
        });
        input.value = this.areaName;
        input.addEventListener("input", () => {
            this.areaName = input.value;
            this.clearError();
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") void this.saveKnowledgeArea();
        });

        const preview = surface.createDiv("sr-native-deck-preview sr-native-area-preview");
        const previewIcon = preview.createDiv("sr-native-deck-preview-icon");
        setIcon(previewIcon, "library-big");
        const previewCopy = preview.createDiv();
        previewCopy.createSpan({ text: t("KNOWLEDGE_AREAS") });
        const previewName = previewCopy.createEl("strong", {
            text: this.areaName.trim() || t("NEW_KNOWLEDGE_AREA"),
        });
        input.addEventListener("input", () => {
            previewName.setText(input.value.trim() || t("NEW_KNOWLEDGE_AREA"));
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
            .setButtonText(
                this.busy
                    ? t("SAVING")
                    : this.editingAreaId
                      ? t("SAVE_CHANGES")
                      : t("CREATE_KNOWLEDGE_AREA"),
            )
            .setCta()
            .setDisabled(this.busy)
            .onClick(() => void this.saveKnowledgeArea());
        window.setTimeout(() => input.focus(), 0);
    }

    private renderNoteTypeManager(surface: HTMLElement): void {
        surface.addClass("sr-note-type-surface");
        if (this.noteTypeDraft) {
            this.renderNoteTypeEditor(surface, this.noteTypeDraft);
            return;
        }

        const toolbar = surface.createDiv("sr-note-type-toolbar");
        const copy = toolbar.createDiv();
        copy.createEl("h2", { text: t("NOTE_TYPES") });
        copy.createEl("p", { text: t("NOTE_TYPES_HELP") });
        const add = new ButtonComponent(toolbar)
            .setButtonText(t("NEW_NOTE_TYPE"))
            .setCta()
            .onClick(() => {
                this.noteTypeDraft = this.createEmptyNoteTypeDraft();
                this.render();
            });
        const addIcon = add.buttonEl.createSpan("sr-note-type-button-icon");
        setIcon(addIcon, "plus");
        add.buttonEl.prepend(addIcon);

        const list = surface.createDiv("sr-note-type-list");
        for (const noteType of this.plugin.dataManager.collectionStore.getNoteTypes()) {
            this.renderNoteTypeRow(list, noteType);
        }
    }

    private renderNoteTypeRow(parent: HTMLElement, noteType: NoteTypeDefinition): void {
        const row = parent.createDiv("sr-note-type-row");
        const icon = row.createDiv("sr-note-type-icon");
        setIcon(icon, noteType.kind === "cloze" ? "scan-text" : "layout-template");
        const body = row.createDiv("sr-note-type-row-copy");
        const title = body.createDiv("sr-note-type-row-title");
        title.createEl("strong", { text: noteType.name });
        title.createSpan({
            cls: noteType.id.startsWith("builtin-") ? "is-builtin" : "is-custom",
            text: noteType.id.startsWith("builtin-") ? t("BUILT_IN") : t("CUSTOM"),
        });
        body.createSpan({
            text: t("NOTE_TYPE_SUMMARY", {
                fields: noteType.fields.length,
                cards: noteType.templates.length,
                notes: this.plugin.dataManager.collectionStore.countNotesForType(noteType.id),
            }),
        });

        const actions = row.createDiv("sr-note-type-row-actions");
        new ButtonComponent(actions)
            .setIcon("copy")
            .setTooltip(t("DUPLICATE_NOTE_TYPE"))
            .onClick(() => {
                this.noteTypeDraft = this.cloneNoteTypeDraft(noteType);
                this.render();
            });
        if (!noteType.id.startsWith("builtin-")) {
            new ButtonComponent(actions)
                .setIcon("pencil")
                .setTooltip(t("EDIT_NOTE_TYPE"))
                .onClick(() => {
                    this.noteTypeDraft = this.noteTypeToDraft(noteType);
                    this.render();
                });
            new ButtonComponent(actions)
                .setIcon("trash-2")
                .setTooltip(t("DELETE_NOTE_TYPE"))
                .onClick(() => this.confirmDeleteNoteType(noteType));
        }
    }

    private renderNoteTypeEditor(parent: HTMLElement, draft: NoteTypeEditorDraft): void {
        const editorHeader = parent.createDiv("sr-note-type-editor-header");
        new ButtonComponent(editorHeader)
            .setIcon("arrow-left")
            .setTooltip(t("NOTE_TYPES"))
            .onClick(() => {
                this.noteTypeDraft = null;
                this.error = "";
                this.render();
            });
        const editorTitle = editorHeader.createDiv();
        editorTitle.createEl("h2", { text: t("EDIT_NOTE_TYPE") });
        editorTitle.createEl("p", { text: t("NOTE_TYPE_EDITOR_HELP") });

        const nameGroup = this.createFieldGroup(parent, t("NOTE_TYPE_NAME"));
        const nameInput = nameGroup.createEl("input", {
            cls: "sr-native-input",
            attr: {
                type: "text",
                autocomplete: "off",
                placeholder: t("NOTE_TYPE_NAME_PLACEHOLDER"),
            },
        });
        nameInput.value = draft.name;
        nameInput.addEventListener("input", () => {
            draft.name = nameInput.value;
            this.clearError();
        });

        const kindGroup = this.createFieldGroup(parent, t("NOTE_TYPE_KIND"));
        const kindPicker = kindGroup.createDiv("sr-native-card-type-switcher sr-note-kind-picker");
        this.createNoteKindButton(kindPicker, draft, "standard", t("NOTE_TYPE_STANDARD"));
        this.createNoteKindButton(kindPicker, draft, "cloze", t("CARD_TYPE_CLOZE"));

        this.renderFieldDefinitions(parent, draft);
        this.renderTemplateDefinitions(parent, draft);

        if (this.error) {
            parent.createDiv({
                cls: "sr-native-form-error",
                text: this.error,
                attr: { role: "alert" },
            });
        }
        const actions = parent.createDiv("sr-native-form-actions sr-note-type-save-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => {
            this.noteTypeDraft = null;
            this.error = "";
            this.render();
        });
        new ButtonComponent(actions)
            .setButtonText(this.busy ? t("SAVING") : t("SAVE_NOTE_TYPE"))
            .setCta()
            .setDisabled(this.busy)
            .onClick(() => void this.saveNoteType());
    }

    private renderFieldDefinitions(parent: HTMLElement, draft: NoteTypeEditorDraft): void {
        const section = parent.createDiv("sr-note-type-section");
        const heading = section.createDiv("sr-note-type-section-heading");
        const headingCopy = heading.createDiv();
        headingCopy.createEl("h3", { text: t("NOTE_FIELDS") });
        headingCopy.createEl("p", { text: t("NOTE_FIELDS_HELP") });
        new ButtonComponent(heading)
            .setIcon("plus")
            .setTooltip(t("ADD_FIELD"))
            .onClick(() => {
                draft.fields.push({
                    id: this.plugin.dataManager.collectionStore.createId("field"),
                    name: t("NEW_FIELD"),
                    ordinal: draft.fields.length,
                    kind: "rich-text",
                    required: false,
                });
                this.render();
            });

        const list = section.createDiv("sr-note-type-definition-list");
        draft.fields.forEach((field, index) => {
            const row = list.createDiv("sr-note-field-row");
            row.createSpan({ cls: "sr-note-definition-index", text: String(index + 1) });
            const name = row.createEl("input", {
                cls: "sr-native-input",
                attr: { type: "text", "aria-label": t("FIELD_NAME") },
            });
            name.value = field.name;
            name.addEventListener("input", () => {
                field.name = name.value;
                this.clearError();
            });
            const kind = row.createEl("select", {
                cls: "dropdown sr-note-field-kind",
                attr: { "aria-label": t("FIELD_KIND") },
            });
            const kinds: FieldKind[] = ["rich-text", "text", "media", "number", "formula"];
            const kindLabels: Record<FieldKind, string> = {
                "rich-text": t("FIELD_KIND_RICH_TEXT"),
                text: t("FIELD_KIND_TEXT"),
                media: t("FIELD_KIND_MEDIA"),
                number: t("FIELD_KIND_NUMBER"),
                formula: t("FIELD_KIND_FORMULA"),
            };
            for (const value of kinds) {
                kind.createEl("option", { value, text: kindLabels[value] });
            }
            kind.value = field.kind;
            kind.addEventListener("change", () => (field.kind = kind.value as FieldKind));
            const required = row.createEl("label", { cls: "sr-note-field-required" });
            const checkbox = required.createEl("input", { attr: { type: "checkbox" } });
            checkbox.checked = field.required;
            checkbox.addEventListener("change", () => (field.required = checkbox.checked));
            required.createSpan({ text: t("REQUIRED_FIELD") });
            new ButtonComponent(row)
                .setIcon("trash-2")
                .setTooltip(t("REMOVE_FIELD"))
                .setDisabled(draft.fields.length === 1)
                .onClick(() => {
                    draft.fields.splice(index, 1);
                    this.render();
                });
        });
    }

    private renderTemplateDefinitions(parent: HTMLElement, draft: NoteTypeEditorDraft): void {
        const section = parent.createDiv("sr-note-type-section");
        const heading = section.createDiv("sr-note-type-section-heading");
        const headingCopy = heading.createDiv();
        headingCopy.createEl("h3", { text: t("CARD_TEMPLATES") });
        headingCopy.createEl("p", { text: t("CARD_TEMPLATES_HELP") });
        new ButtonComponent(heading)
            .setIcon("plus")
            .setTooltip(t("ADD_TEMPLATE"))
            .setDisabled(draft.kind === "cloze")
            .onClick(() => {
                draft.templates.push(this.createEmptyTemplate(draft.templates.length));
                this.render();
            });

        const list = section.createDiv("sr-note-template-list");
        draft.templates.forEach((template, index) => {
            const card = list.createDiv("sr-note-template-card");
            const top = card.createDiv("sr-note-template-card-top");
            top.createSpan({ cls: "sr-note-definition-index", text: String(index + 1) });
            const name = top.createEl("input", {
                cls: "sr-native-input",
                attr: { type: "text", "aria-label": t("TEMPLATE_NAME") },
            });
            name.value = template.name;
            name.addEventListener("input", () => (template.name = name.value));
            new ButtonComponent(top)
                .setIcon("trash-2")
                .setTooltip(t("REMOVE_TEMPLATE"))
                .setDisabled(draft.templates.length === 1 || draft.kind === "cloze")
                .onClick(() => {
                    draft.templates.splice(index, 1);
                    this.render();
                });

            this.createTemplateTextarea(
                card,
                t("QUESTION_TEMPLATE"),
                template.questionFormat,
                (value) => {
                    template.questionFormat = value;
                },
            );
            this.createTemplateTextarea(
                card,
                t("ANSWER_TEMPLATE"),
                template.answerFormat,
                (value) => {
                    template.answerFormat = value;
                },
            );
        });
    }

    private createTemplateTextarea(
        parent: HTMLElement,
        label: string,
        value: string,
        onChange: (value: string) => void,
    ): void {
        const field = parent.createDiv("sr-note-template-field");
        field.createEl("label", { text: label });
        const textarea = field.createEl("textarea", {
            cls: "sr-native-textarea sr-note-template-textarea",
            attr: { rows: "3", spellcheck: "false" },
        });
        textarea.value = value;
        textarea.addEventListener("input", () => {
            onChange(textarea.value);
            this.clearError();
        });
    }

    private createNoteKindButton(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        kind: NoteTypeKind,
        label: string,
    ): void {
        const button = new ButtonComponent(parent).setButtonText(label).onClick(() => {
            draft.kind = kind;
            if (kind === "cloze" && draft.templates.length > 1) {
                draft.templates = [draft.templates[0]];
            }
            this.render();
        });
        button.buttonEl.toggleClass("is-active", draft.kind === kind);
        button.buttonEl.setAttribute("aria-pressed", String(draft.kind === kind));
    }

    private createEmptyNoteTypeDraft(): NoteTypeEditorDraft {
        const store = this.plugin.dataManager.collectionStore;
        return {
            id: store.createId("notetype"),
            name: "",
            kind: "standard",
            fields: [
                {
                    id: store.createId("field"),
                    name: t("CARD_FRONT"),
                    ordinal: 0,
                    kind: "rich-text",
                    required: true,
                },
                {
                    id: store.createId("field"),
                    name: t("CARD_BACK"),
                    ordinal: 1,
                    kind: "rich-text",
                    required: true,
                },
            ],
            templates: [this.createEmptyTemplate(0)],
            css: "",
        };
    }

    private createEmptyTemplate(ordinal: number): CardTemplateDefinition {
        const fields = this.noteTypeDraft?.fields ?? [];
        const front = fields[0]?.name ?? t("CARD_FRONT");
        const back = fields[1]?.name ?? fields[0]?.name ?? t("CARD_BACK");
        return {
            id: this.plugin.dataManager.collectionStore.createId("template"),
            name: `${t("CARD")} ${ordinal + 1}`,
            ordinal,
            questionFormat: `{{${front}}}`,
            answerFormat: `{{${back}}}`,
            deckOverride: null,
            enabled: true,
        };
    }

    private noteTypeToDraft(noteType: NoteTypeDefinition): NoteTypeEditorDraft {
        return {
            id: noteType.id,
            name: noteType.name,
            kind: noteType.kind,
            fields: noteType.fields.map((field) => ({ ...field })),
            templates: noteType.templates.map((template) => ({ ...template })),
            css: noteType.css,
        };
    }

    private cloneNoteTypeDraft(noteType: NoteTypeDefinition): NoteTypeEditorDraft {
        const store = this.plugin.dataManager.collectionStore;
        return {
            id: store.createId("notetype"),
            name: `${noteType.name} — ${t("COPY")}`,
            kind: noteType.kind,
            fields: noteType.fields.map((field, ordinal) => ({
                ...field,
                id: store.createId("field"),
                ordinal,
            })),
            templates: noteType.templates.map((template, ordinal) => ({
                ...template,
                id: store.createId("template"),
                ordinal,
            })),
            css: noteType.css,
        };
    }

    private async saveNoteType(): Promise<void> {
        const draft = this.noteTypeDraft;
        if (!draft) return;
        if (!draft.name.trim()) {
            this.error = t("NOTE_TYPE_NAME_REQUIRED");
            this.render();
            return;
        }
        const fieldNames = draft.fields.map((field) => field.name.trim().toLocaleLowerCase());
        if (fieldNames.some((name) => !name) || new Set(fieldNames).size !== fieldNames.length) {
            this.error = t("NOTE_TYPE_FIELDS_INVALID");
            this.render();
            return;
        }
        if (
            draft.templates.some(
                (template) =>
                    !template.name.trim() ||
                    !template.questionFormat.trim() ||
                    !template.answerFormat.trim(),
            )
        ) {
            this.error = t("NOTE_TYPE_TEMPLATES_INVALID");
            this.render();
            return;
        }
        this.busy = true;
        this.error = "";
        this.render();
        try {
            await this.plugin.dataManager.collectionStore.saveNoteType({
                ...draft,
                name: draft.name.trim(),
                fields: draft.fields.map((field, ordinal) => ({
                    ...field,
                    name: field.name.trim(),
                    ordinal,
                })),
                templates: draft.templates.map((template, ordinal) => ({
                    ...template,
                    name: template.name.trim(),
                    ordinal,
                })),
            });
            this.busy = false;
            this.noteTypeDraft = null;
            new Notice(t("NOTE_TYPE_SAVED"));
            this.render();
        } catch {
            this.busy = false;
            this.error = t("NOTE_TYPE_SAVE_FAILED");
            this.render();
        }
    }

    private confirmDeleteNoteType(noteType: NoteTypeDefinition): void {
        new ConfirmationModal(
            this.plugin.app,
            t("DELETE_NOTE_TYPE"),
            t("DELETE_NOTE_TYPE_CONFIRMATION", { name: noteType.name }),
            t("CANCEL"),
            async () => {
                try {
                    await this.plugin.dataManager.collectionStore.deleteNoteType(noteType.id);
                    new Notice(t("NOTE_TYPE_DELETED"));
                    this.render();
                } catch (error) {
                    new Notice(
                        error instanceof Error && error.message === "note-type-in-use"
                            ? t("NOTE_TYPE_IN_USE")
                            : t("NOTE_TYPE_DELETE_FAILED"),
                    );
                }
            },
        ).open();
    }

    private createFieldGroup(parent: HTMLElement, label: string, help?: string): HTMLDivElement {
        const group = parent.createDiv("sr-native-field");
        group.createEl("label", { text: label });
        if (help) group.createEl("p", { text: help });
        return group;
    }

    private renderTagsField(parent: HTMLElement): void {
        const group = this.createFieldGroup(parent, t("TAGS"), t("TAGS_HELP"));
        const input = group.createEl("input", {
            cls: "sr-native-input",
            attr: {
                type: "text",
                placeholder: t("TAGS_PLACEHOLDER"),
                autocomplete: "off",
                autocapitalize: "none",
                "aria-label": t("TAGS"),
            },
        });
        input.value = this.tagsText;
        input.addEventListener("input", () => {
            this.tagsText = input.value;
        });
    }

    private getTags(): string[] {
        return this.tagsText
            .split(/[\s,]+/)
            .map((tag) => tag.trim().replace(/^#+/, ""))
            .filter(Boolean);
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

    private getSelectedNoteType(): NoteTypeDefinition {
        const store = this.plugin.dataManager.collectionStore;
        return (
            store.getNoteType(this.selectedNoteTypeId) ??
            store.getNoteType(BASIC_NOTE_TYPE_ID) ??
            store.getNoteTypes()[0]
        );
    }

    private getNoteTypeDisplayName(noteType: NoteTypeDefinition): string {
        if (noteType.id === BASIC_NOTE_TYPE_ID) return t("CARD_TYPE_BASIC");
        if (noteType.id === REVERSED_NOTE_TYPE_ID) return t("CARD_TYPE_REVERSED");
        if (noteType.id === CLOZE_NOTE_TYPE_ID) return t("CARD_TYPE_CLOZE");
        return noteType.name;
    }

    private openNoteTypeMenu(event: MouseEvent): void {
        const menu = new Menu();
        for (const noteType of this.plugin.dataManager.collectionStore.getNoteTypes()) {
            menu.addItem((item) =>
                item
                    .setTitle(this.getNoteTypeDisplayName(noteType))
                    .setIcon(noteType.kind === "cloze" ? "scan-text" : "layout-template")
                    .setChecked(noteType.id === this.selectedNoteTypeId)
                    .onClick(() => {
                        this.selectedNoteTypeId = noteType.id;
                        if (noteType.id === BASIC_NOTE_TYPE_ID) this.cardType = "basic";
                        else if (noteType.id === REVERSED_NOTE_TYPE_ID) this.cardType = "reversed";
                        else if (noteType.id === CLOZE_NOTE_TYPE_ID) this.cardType = "cloze";
                        this.error = "";
                        this.render();
                    }),
            );
        }
        menu.addSeparator();
        menu.addItem((item) =>
            item
                .setTitle(t("MANAGE_NOTE_TYPES"))
                .setIcon("settings-2")
                .onClick(() => {
                    this.request = { mode: "note-type" };
                    this.noteTypeDraft = null;
                    this.render();
                }),
        );
        menu.showAtMouseEvent(event);
    }

    private renderCustomNoteFields(surface: HTMLElement, noteType: NoteTypeDefinition): void {
        if (noteType.kind === "cloze") {
            surface.createDiv({ cls: "sr-native-form-tip", text: t("CUSTOM_CLOZE_HELP") });
        }
        let firstInput: HTMLInputElement | HTMLTextAreaElement | null = null;
        for (const field of [...noteType.fields].sort(
            (left, right) => left.ordinal - right.ordinal,
        )) {
            const group = this.createFieldGroup(
                surface,
                field.required ? `${field.name} · ${t("REQUIRED_FIELD")}` : field.name,
            );
            let input: HTMLInputElement | HTMLTextAreaElement;
            if (field.kind === "number") {
                input = group.createEl("input", {
                    cls: "sr-native-input",
                    attr: { type: "number", inputmode: "decimal", "aria-label": field.name },
                });
            } else {
                input = group.createEl("textarea", {
                    cls: "sr-native-textarea",
                    attr: {
                        rows: field.kind === "rich-text" || field.kind === "formula" ? "5" : "3",
                        "aria-label": field.name,
                    },
                });
            }
            input.value = this.customFieldValues[field.id] ?? "";
            input.addEventListener("input", () => {
                this.customFieldValues[field.id] = input.value;
                this.clearError();
            });
            firstInput ??= input;
        }

        this.renderTagsField(surface);

        if (this.error) {
            surface.createDiv({
                cls: "sr-native-form-error",
                text: this.error,
                attr: { role: "alert" },
            });
        }
        const actions = surface.createDiv("sr-native-form-actions");
        if (!this.editingStructuredNote) {
            const saveAnother = new ButtonComponent(actions)
                .setButtonText(t("SAVE_AND_ADD_ANOTHER"))
                .setDisabled(this.busy)
                .onClick(() => void this.saveStructuredNote(noteType, true));
            saveAnother.buttonEl.addClass("sr-native-secondary-action");
        }
        new ButtonComponent(actions)
            .setButtonText(
                this.busy
                    ? t("SAVING")
                    : this.editingStructuredNote
                      ? t("SAVE_CHANGES")
                      : t("SAVE_CARD"),
            )
            .setCta()
            .setDisabled(this.busy)
            .onClick(() => void this.saveStructuredNote(noteType, false));
        if (firstInput) window.setTimeout(() => firstInput?.focus(), 0);
    }

    private async saveStructuredNote(
        noteType: NoteTypeDefinition,
        addAnother: boolean,
    ): Promise<void> {
        const missingRequired = noteType.fields.some(
            (field) => field.required && !this.customFieldValues[field.id]?.trim(),
        );
        if (missingRequired) {
            this.error = t("REQUIRED_FIELDS_MISSING");
            this.render();
            return;
        }
        this.busy = true;
        this.error = "";
        this.render();
        try {
            const draft = {
                deckPath: this.selectedDeck,
                noteTypeId: noteType.id,
                fields: { ...this.customFieldValues },
                tags: this.getTags(),
            };
            if (this.editingStructuredNote) {
                await this.store.updateStructuredNote(this.editingStructuredNote, draft);
            } else {
                await this.store.createStructuredNote(draft);
            }
            new Notice(this.editingStructuredNote ? t("CARD_UPDATED") : t("CARD_SAVED"));
            if (addAnother) {
                this.customFieldValues = {};
                this.busy = false;
                this.render();
            } else {
                await this.returnToCards();
            }
        } catch (error) {
            this.busy = false;
            this.error =
                error instanceof Error && error.message === "cloze-pattern-required"
                    ? t("CUSTOM_CLOZE_REQUIRED")
                    : t("CARD_SAVE_FAILED");
            this.render();
        }
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
                tags: this.getTags(),
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
            if (this.request.targetAreaId) {
                const topLevelDeck = this.selectedDeck.split("/")[0];
                await this.store.assignDeckToKnowledgeArea(topLevelDeck, this.request.targetAreaId);
            }
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

    private async saveDeckOptions(): Promise<void> {
        const draft = this.deckOptionsDraft;
        if (!draft || !draft.name.trim()) {
            this.error = t("PRESET_NAME_REQUIRED");
            this.render();
            return;
        }
        this.busy = true;
        this.error = "";
        this.render();
        try {
            const collection = this.plugin.dataManager.collectionStore;
            const saved = await collection.saveDeckOptions(draft);
            await collection.updateDeck(this.selectedDeck, {
                description: this.deckDescription,
                optionsId: saved.id,
            });
            this.selectedDeckOptionsId = saved.id;
            this.deckOptionsDraft = saved;
            this.busy = false;
            new Notice(t("DECK_OPTIONS_SAVED"));
            await this.returnToCards();
        } catch {
            this.busy = false;
            this.error = t("DECK_OPTIONS_SAVE_FAILED");
            this.render();
        }
    }

    private async saveKnowledgeArea(): Promise<void> {
        if (!this.areaName.trim()) {
            this.error = t("KNOWLEDGE_AREA_NAME_REQUIRED");
            this.render();
            return;
        }
        this.busy = true;
        this.error = "";
        this.render();
        try {
            if (this.editingAreaId) {
                await this.store.renameKnowledgeArea(this.editingAreaId, this.areaName);
                new Notice(t("KNOWLEDGE_AREA_UPDATED"));
            } else {
                await this.store.createKnowledgeArea(this.areaName);
                new Notice(t("KNOWLEDGE_AREA_CREATED"));
            }
            await this.plugin.dataManager.sync();
            await this.returnToCards();
        } catch {
            this.busy = false;
            this.error = t("KNOWLEDGE_AREA_SAVE_FAILED");
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
        const questionId = question.ensureStableId();
        await question.writeQuestion(settings);
        question.cards.forEach((card, index) => {
            card.front = expanded[index].front;
            card.back = expanded[index].back;
        });
        await this.plugin.dataManager.collectionStore.updateNativeNote({
            type: draft.type,
            front: draft.front.trim(),
            back: draft.back.trim(),
            deckPath: this.selectedDeck,
            sourcePath: question.note.filePath,
            questionId,
            tags: draft.tags,
        });
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
    }

    private async returnToCards(): Promise<void> {
        await this.leaf.setViewState({ type: CARD_BROWSER_VIEW_TYPE, active: true });
    }
}
