import "src/ui/native-creator/native-creator-view.css";
import { ButtonComponent, ItemView, Menu, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";

import {
    BASIC_NOTE_TYPE_ID,
    CLOZE_NOTE_TYPE_ID,
    IMAGE_OCCLUSION_NOTE_TYPE_ID,
    OCCLUSION_ASSETS_FIELD_ID,
    OCCLUSION_MASKS_FIELD_ID,
    OCCLUSION_MODE_FIELD_ID,
    OCCLUSION_SOURCE_FIELD_ID,
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
import {
    LoadedOcclusionImage,
    loadOcclusionImage,
    OcclusionMask,
    OcclusionMode,
    renderOcclusionAssets,
} from "src/ui/native-creator/image-occlusion";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";

export type NativeCreatorMode =
    "card" | "image-occlusion" | "media" | "deck" | "deck-options" | "area" | "note-type";

type MediaTarget = "front" | "back" | `field:${string}`;

interface PendingMediaAttachment {
    id: string;
    file: File;
    target: MediaTarget;
    objectUrl: string;
}

interface ExistingMediaAttachment {
    id: string;
    path: string;
    target: MediaTarget;
}

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
    private cardVariants = new Set<NativeCardType>(["basic"]);
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
    private pendingMedia: PendingMediaAttachment[] = [];
    private existingMedia: ExistingMediaAttachment[] = [];
    private occlusionSource: LoadedOcclusionImage | null = null;
    private occlusionSourcePath: string | null = null;
    private occlusionMasks: OcclusionMask[] = [];
    private activeOcclusionMask: OcclusionMask | null = null;
    private selectedOcclusionMaskId: string | null = null;
    private occlusionMode: OcclusionMode = "hide-all";
    private editingOcclusionNote: CollectionNote | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private mediaRecordingChunks: Blob[] = [];
    private isRecordingMedia = false;

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
        if (this.request.mode === "image-occlusion") return t("IMAGE_OCCLUSION");
        if (this.request.mode === "media") return t("MEDIA_LIBRARY");
        if (this.editingCard) return t("EDIT_CARD");
        if (this.request.mode === "area") {
            return this.editingAreaId ? t("EDIT_KNOWLEDGE_AREA") : t("NEW_KNOWLEDGE_AREA");
        }
        if (this.request.mode === "note-type") return t("NOTE_TYPES");
        if (this.request.mode === "deck-options") return t("DECK_OPTIONS");
        return this.request.mode === "deck" ? t("NEW_DECK") : t("NEW_CARD");
    }

    getIcon(): string {
        if (this.request.mode === "image-occlusion") return "scan";
        if (this.request.mode === "media") return "images";
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

    onClose(): Promise<void> {
        this.clearPendingMedia();
        return Promise.resolve();
    }

    configure(request: NativeCreatorRequest): void {
        const wasEditing = this.editingCard !== null;
        this.clearPendingMedia();
        this.existingMedia = [];
        this.request = request;
        this.selectedDeck = request.deckPath ?? this.selectedDeck;
        this.editingCard = request.card ?? null;
        this.editingStructuredNote = null;
        this.editingOcclusionNote = null;
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
            if (structuredNote?.noteTypeId === IMAGE_OCCLUSION_NOTE_TYPE_ID) {
                this.editingOcclusionNote = structuredNote;
                this.request = { ...request, mode: "image-occlusion" };
                const structuredCard = Object.values(
                    this.plugin.dataManager.collectionStore.getCollectionSnapshot().cards,
                ).find((card) => !card.deletedAt && card.noteId === structuredNote.id);
                if (structuredCard) this.selectedDeck = structuredCard.deckPath;
                void this.loadImageOcclusionForEditing(structuredNote);
            } else if (structuredNote && !structuredNote.noteTypeId.startsWith("builtin-")) {
                this.editingStructuredNote = structuredNote;
                this.selectedNoteTypeId = structuredNote.noteTypeId;
                this.customFieldValues = { ...structuredNote.fields };
                for (const fieldId of Object.keys(this.customFieldValues)) {
                    this.customFieldValues[fieldId] = this.extractMediaEmbeds(
                        this.customFieldValues[fieldId],
                        `field:${fieldId}`,
                    );
                }
                const structuredCard = Object.values(
                    this.plugin.dataManager.collectionStore.getCollectionSnapshot().cards,
                ).find((card) => !card.deletedAt && card.noteId === structuredNote.id);
                if (structuredCard) this.selectedDeck = structuredCard.deckPath;
            } else {
                this.loadCardForEditing(this.editingCard);
                this.front = this.extractMediaEmbeds(this.front, "front");
                this.back = this.extractMediaEmbeds(this.back, "back");
            }
        } else if (wasEditing) {
            this.front = "";
            this.back = "";
            this.cardType = "basic";
            this.customFieldValues = {};
            this.tagsText = "";
            this.existingMedia = [];
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
            text:
                this.request.mode === "image-occlusion"
                    ? t("IMAGE_OCCLUSION")
                    : this.editingCard
                      ? t("EDIT_CARD")
                      : this.request.mode === "media"
                        ? t("MEDIA_LIBRARY")
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
            text:
                this.request.mode === "image-occlusion"
                    ? t("IMAGE_OCCLUSION_DESCRIPTION")
                    : this.editingCard
                      ? t("EDIT_CARD_DESCRIPTION")
                      : this.request.mode === "media"
                        ? t("MEDIA_LIBRARY_DESCRIPTION")
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

        if (
            !this.editingCard &&
            !this.editingAreaId &&
            this.request.mode !== "deck-options" &&
            this.request.mode !== "image-occlusion"
        ) {
            const switcher = top.createDiv("sr-native-creator-switcher");
            this.createModeButton(switcher, "card", "square-pen", t("CARD"));
            this.createModeButton(switcher, "deck", "layers-3", t("DECK"));
            this.createModeButton(switcher, "area", "library-big", t("KNOWLEDGE_AREAS"));
            this.createModeButton(switcher, "note-type", "shapes", t("NOTE_TYPES"));
            this.createModeButton(switcher, "media", "images", t("MEDIA_LIBRARY"));
        }

        const surface = page.createDiv("sr-native-creator-surface");
        if (this.request.mode === "image-occlusion") this.renderImageOcclusionForm(surface);
        else if (this.request.mode === "media") this.renderMediaManager(surface);
        else if (this.request.mode === "deck") this.renderDeckForm(surface);
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

        if (!this.editingCard) {
            const occlusion = typeGroup.createEl("button", {
                cls: "sr-native-occlusion-entry",
                attr: { type: "button" },
            });
            const occlusionIcon = occlusion.createSpan("sr-native-occlusion-entry-icon");
            setIcon(occlusionIcon, "scan");
            const occlusionCopy = occlusion.createSpan("sr-native-occlusion-entry-copy");
            occlusionCopy.createEl("strong", { text: t("IMAGE_OCCLUSION") });
            occlusionCopy.createSpan({ text: t("IMAGE_OCCLUSION_SHORT_HELP") });
            const arrow = occlusion.createSpan("sr-native-occlusion-entry-arrow");
            setIcon(arrow, "chevron-right");
            occlusion.addEventListener("click", () => {
                this.request = { mode: "image-occlusion", deckPath: this.selectedDeck };
                this.error = "";
                this.render();
            });

            const variants = this.createFieldGroup(
                surface,
                t("CARD_VARIANTS"),
                t("CARD_VARIANTS_HELP"),
            );
            const variantPicker = variants.createDiv(
                "sr-native-card-type-switcher sr-native-variant-picker",
            );
            for (const [type, label] of [
                ["basic", t("CARD_VARIANT_FORWARD")],
                ["reversed", t("CARD_VARIANT_REVERSE")],
                ["cloze", t("CARD_TYPE_CLOZE")],
            ] as const) {
                const button = new ButtonComponent(variantPicker).setButtonText(label);
                button.buttonEl.toggleClass("is-active", this.cardVariants.has(type));
                button.buttonEl.setAttribute("aria-pressed", String(this.cardVariants.has(type)));
                button.onClick(() => {
                    if (this.cardVariants.has(type)) {
                        if (this.cardVariants.size > 1) this.cardVariants.delete(type);
                    } else {
                        this.cardVariants.add(type);
                    }
                    this.cardType =
                        this.cardVariants.size === 1 && this.cardVariants.has("cloze")
                            ? "cloze"
                            : "basic";
                    this.error = "";
                    this.render();
                });
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
        this.renderMediaControls(frontGroup, "front");

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
        this.renderMediaControls(backGroup, "back");

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

    private renderMediaControls(parent: HTMLElement, target: MediaTarget): void {
        const controls = parent.createDiv("sr-native-media-controls");
        const picker = controls.createEl("button", {
            cls: "sr-native-media-button",
            attr: { type: "button" },
        });
        const icon = picker.createSpan();
        setIcon(icon, "paperclip");
        picker.createSpan({ text: t("ADD_MEDIA") });
        const input = controls.createEl("input", {
            cls: "sr-native-media-input",
            attr: {
                type: "file",
                accept: "image/*,audio/*,video/*",
                multiple: "true",
                tabindex: "-1",
            },
        });
        picker.addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
            for (const file of Array.from(input.files ?? [])) {
                this.pendingMedia.push({
                    id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    file,
                    target,
                    objectUrl: URL.createObjectURL(file),
                });
            }
            input.value = "";
            this.clearError();
            this.render();
        });

        const pendingAttachments = this.pendingMedia.filter(
            (attachment) => attachment.target === target,
        );
        const existingAttachments = this.existingMedia.filter(
            (attachment) => attachment.target === target,
        );
        if (pendingAttachments.length === 0 && existingAttachments.length === 0) return;
        const list = parent.createDiv("sr-native-media-list");
        for (const attachment of existingAttachments) {
            const item = list.createDiv("sr-native-media-item");
            const preview = item.createDiv("sr-native-media-preview");
            const file = this.plugin.app.vault.getAbstractFileByPath(attachment.path);
            const extension = file instanceof TFile ? file.extension.toLocaleLowerCase() : "";
            if (
                file instanceof TFile &&
                /^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/.test(extension)
            ) {
                preview.createEl("img", {
                    attr: {
                        src: this.plugin.app.vault.getResourcePath(file),
                        alt: file.name,
                    },
                });
            } else {
                const mediaIcon = preview.createDiv();
                setIcon(
                    mediaIcon,
                    /^(mp3|wav|m4a|ogg|flac|aac)$/.test(extension) ? "audio-lines" : "film",
                );
            }
            const copy = item.createDiv("sr-native-media-copy");
            copy.createEl("strong", { text: file instanceof TFile ? file.name : attachment.path });
            copy.createSpan({ text: t("SAVED_IN_VAULT") });
            const remove = item.createEl("button", {
                cls: "sr-native-media-remove",
                attr: { type: "button", "aria-label": t("REMOVE_MEDIA") },
            });
            setIcon(remove, "x");
            remove.addEventListener("click", () => {
                this.existingMedia = this.existingMedia.filter((item) => item.id !== attachment.id);
                this.render();
            });
        }
        for (const attachment of pendingAttachments) {
            const item = list.createDiv("sr-native-media-item");
            const preview = item.createDiv("sr-native-media-preview");
            if (attachment.file.type.startsWith("image/")) {
                preview.createEl("img", {
                    attr: { src: attachment.objectUrl, alt: attachment.file.name },
                });
            } else {
                const mediaIcon = preview.createDiv();
                setIcon(
                    mediaIcon,
                    attachment.file.type.startsWith("audio/") ? "audio-lines" : "film",
                );
            }
            const copy = item.createDiv("sr-native-media-copy");
            copy.createEl("strong", { text: attachment.file.name });
            copy.createSpan({ text: this.formatFileSize(attachment.file.size) });
            const remove = item.createEl("button", {
                cls: "sr-native-media-remove",
                attr: { type: "button", "aria-label": t("REMOVE_MEDIA") },
            });
            setIcon(remove, "x");
            remove.addEventListener("click", () => {
                URL.revokeObjectURL(attachment.objectUrl);
                this.pendingMedia = this.pendingMedia.filter((item) => item.id !== attachment.id);
                this.render();
            });
        }
    }

    private async materializePendingMedia(): Promise<void> {
        if (this.pendingMedia.length === 0) return;
        for (const attachment of this.pendingMedia) {
            const path = await this.store.saveMediaAsset(
                attachment.file.name,
                await attachment.file.arrayBuffer(),
            );
            this.existingMedia.push({ id: attachment.id, path, target: attachment.target });
            URL.revokeObjectURL(attachment.objectUrl);
        }
        this.pendingMedia = [];
    }

    private clearPendingMedia(): void {
        for (const attachment of this.pendingMedia) URL.revokeObjectURL(attachment.objectUrl);
        this.pendingMedia = [];
    }

    private hasPendingMedia(target: MediaTarget): boolean {
        return (
            this.pendingMedia.some((attachment) => attachment.target === target) ||
            this.existingMedia.some((attachment) => attachment.target === target)
        );
    }

    private extractMediaEmbeds(value: string, target: MediaTarget): string {
        const expression = /!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
        const text = value.replace(expression, (_match, path: string) => {
            this.existingMedia.push({
                id: `existing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                path: path.trim(),
                target,
            });
            return "";
        });
        return text.replace(/\n{3,}/g, "\n\n").trim();
    }

    private withMediaEmbeds(value: string, target: MediaTarget): string {
        const embeds = this.existingMedia
            .filter((attachment) => attachment.target === target)
            .map((attachment) => `![[${attachment.path}]]`);
        return [value.trim(), ...embeds].filter(Boolean).join("\n\n");
    }

    private formatFileSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    private renderImageOcclusionForm(surface: HTMLElement): void {
        surface.addClass("sr-native-occlusion-surface");
        const deckGroup = this.createFieldGroup(surface, t("DECK"), t("DECK_PICKER_HELP"));
        const deckButton = new ButtonComponent(deckGroup)
            .setButtonText(this.selectedDeck || t("DEFAULT_DECK"))
            .setClass("sr-native-picker")
            .onClick((event) => this.openDeckMenu(event));
        deckButton.buttonEl.setAttribute("aria-haspopup", "menu");
        const chevron = deckButton.buttonEl.createSpan("sr-native-picker-chevron");
        setIcon(chevron, "chevron-down");

        if (!this.occlusionSource) {
            const empty = surface.createDiv("sr-native-occlusion-empty");
            const emptyIcon = empty.createDiv("sr-native-occlusion-empty-icon");
            setIcon(emptyIcon, "image-plus");
            empty.createEl("h2", { text: t("CHOOSE_OCCLUSION_IMAGE") });
            empty.createEl("p", { text: t("CHOOSE_OCCLUSION_IMAGE_HELP") });
            const choose = empty.createEl("button", {
                cls: "mod-cta sr-native-occlusion-choose",
                text: t("CHOOSE_IMAGE"),
                attr: { type: "button" },
            });
            const input = empty.createEl("input", {
                cls: "sr-native-media-input",
                attr: { type: "file", accept: "image/*", tabindex: "-1" },
            });
            choose.addEventListener("click", () => input.click());
            input.addEventListener("change", () => {
                const file = input.files?.[0];
                if (file) void this.setOcclusionSource(file);
            });
        } else {
            const modeGroup = this.createFieldGroup(
                surface,
                t("OCCLUSION_MODE"),
                t("OCCLUSION_MODE_HELP"),
            );
            const modePicker = modeGroup.createDiv("sr-native-card-type-switcher");
            for (const [mode, label] of [
                ["hide-one", t("OCCLUSION_HIDE_ONE")],
                ["hide-all", t("OCCLUSION_HIDE_ALL")],
            ] as const) {
                const button = new ButtonComponent(modePicker).setButtonText(label);
                button.buttonEl.toggleClass("is-active", this.occlusionMode === mode);
                button.onClick(() => {
                    this.occlusionMode = mode;
                    this.render();
                });
            }
            const toolbar = surface.createDiv("sr-native-occlusion-toolbar");
            const copy = toolbar.createDiv();
            copy.createEl("strong", { text: t("DRAW_MASKS") });
            copy.createSpan({ text: t("DRAW_MASKS_HELP") });
            const tools = toolbar.createDiv("sr-native-occlusion-tools");
            const undo = new ButtonComponent(tools)
                .setIcon("undo-2")
                .setTooltip(t("UNDO_LAST_MASK"))
                .setDisabled(this.occlusionMasks.length === 0)
                .onClick(() => {
                    this.occlusionMasks.pop();
                    this.render();
                });
            undo.buttonEl.addClass("sr-native-icon-button");
            const replace = new ButtonComponent(tools)
                .setIcon("image-plus")
                .setTooltip(t("CHOOSE_ANOTHER_IMAGE"))
                .onClick(() => replacementInput.click());
            replace.buttonEl.addClass("sr-native-icon-button");
            const replacementInput = tools.createEl("input", {
                cls: "sr-native-media-input",
                attr: { type: "file", accept: "image/*", tabindex: "-1" },
            });
            replacementInput.addEventListener("change", () => {
                const file = replacementInput.files?.[0];
                if (file) void this.setOcclusionSource(file);
            });

            const stage = surface.createDiv("sr-native-occlusion-stage");
            const canvas = stage.createEl("canvas", {
                cls: "sr-native-occlusion-canvas",
                attr: { "aria-label": t("IMAGE_OCCLUSION_EDITOR") },
            });
            this.initializeOcclusionCanvas(canvas);

            const count = surface.createDiv("sr-native-occlusion-count");
            count.createEl("strong", {
                text: t("OCCLUSION_CARD_COUNT", { count: this.occlusionMasks.length }),
            });
            count.createSpan({ text: t("OCCLUSION_CARD_COUNT_HELP") });
            const maskList = surface.createDiv("sr-native-occlusion-mask-list");
            this.occlusionMasks.forEach((mask, index) => {
                const row = maskList.createDiv("sr-native-occlusion-mask-row");
                row.toggleClass("is-selected", mask.id === this.selectedOcclusionMaskId);
                const select = row.createEl("button", {
                    cls: "sr-native-occlusion-mask-select",
                    text: String(index + 1),
                    attr: { type: "button", "aria-label": t("SELECT_OCCLUSION_MASK") },
                });
                select.addEventListener("click", () => {
                    this.selectedOcclusionMaskId = mask.id;
                    this.render();
                });
                const label = row.createEl("input", {
                    cls: "sr-native-input",
                    attr: {
                        type: "text",
                        placeholder: t("OCCLUSION_LABEL_PLACEHOLDER"),
                        "aria-label": t("OCCLUSION_LABEL"),
                    },
                });
                label.value = mask.label;
                label.addEventListener("input", () => (mask.label = label.value));
                const remove = new ButtonComponent(row)
                    .setIcon("trash-2")
                    .setTooltip(t("REMOVE_OCCLUSION_MASK"))
                    .onClick(() => {
                        this.occlusionMasks = this.occlusionMasks.filter(
                            (candidate) => candidate.id !== mask.id,
                        );
                        if (this.selectedOcclusionMaskId === mask.id) {
                            this.selectedOcclusionMaskId = null;
                        }
                        this.render();
                    });
                remove.buttonEl.addClass("sr-native-icon-button");
            });
            this.renderTagsField(surface);
        }

        if (this.error) {
            surface.createDiv({
                cls: "sr-native-form-error",
                text: this.error,
                attr: { role: "alert" },
            });
        }
        const actions = surface.createDiv("sr-native-form-actions");
        const cancel = new ButtonComponent(actions)
            .setButtonText(t("CANCEL"))
            .setDisabled(this.busy)
            .onClick(() => {
                if (this.editingOcclusionNote) {
                    void this.returnToCards();
                    return;
                }
                this.request = { mode: "card", deckPath: this.selectedDeck };
                this.occlusionSource = null;
                this.occlusionMasks = [];
                this.render();
            });
        cancel.buttonEl.addClass("sr-native-secondary-action");
        new ButtonComponent(actions)
            .setButtonText(
                this.busy
                    ? t("SAVING")
                    : this.editingOcclusionNote
                      ? t("SAVE_CHANGES")
                      : t("CREATE_OCCLUSION_CARDS"),
            )
            .setCta()
            .setDisabled(this.busy || !this.occlusionSource || this.occlusionMasks.length === 0)
            .onClick(() => void this.saveImageOcclusion());
    }

    private async setOcclusionSource(file: File): Promise<void> {
        try {
            this.occlusionSource = await loadOcclusionImage(file);
            this.occlusionSourcePath = null;
            this.occlusionMasks = [];
            this.selectedOcclusionMaskId = null;
            this.error = "";
        } catch {
            this.error = t("OCCLUSION_IMAGE_FAILED");
        }
        this.render();
    }

    private async loadImageOcclusionForEditing(note: CollectionNote): Promise<void> {
        try {
            const sourcePath = note.fields[OCCLUSION_SOURCE_FIELD_ID];
            const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) throw new Error("occlusion-source-not-found");
            const data = await this.plugin.app.vault.readBinary(sourceFile);
            const mime: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                webp: "image/webp",
                gif: "image/gif",
                svg: "image/svg+xml",
                avif: "image/avif",
                heic: "image/heic",
                heif: "image/heif",
            };
            this.occlusionSource = await loadOcclusionImage(
                new File([data], sourceFile.name, {
                    type: mime[sourceFile.extension.toLocaleLowerCase()] ?? "image/*",
                }),
            );
            this.occlusionSourcePath = sourcePath;
            const parsed = JSON.parse(note.fields[OCCLUSION_MASKS_FIELD_ID] ?? "[]") as Array<
                Partial<OcclusionMask>
            >;
            this.occlusionMasks = parsed.map((mask, index) => ({
                id: mask.id ?? `mask-${index + 1}`,
                x: mask.x ?? 0,
                y: mask.y ?? 0,
                width: mask.width ?? 0.1,
                height: mask.height ?? 0.1,
                label: mask.label ?? "",
            }));
            this.occlusionMode =
                note.fields[OCCLUSION_MODE_FIELD_ID] === "hide-one" ? "hide-one" : "hide-all";
            this.selectedOcclusionMaskId = this.occlusionMasks[0]?.id ?? null;
            this.error = "";
        } catch (error) {
            console.error("Spaced Repetition: image occlusion edit load failed", error);
            this.error = t("OCCLUSION_IMAGE_FAILED");
        }
        if (this.contentEl.isShown()) this.render();
    }

    private initializeOcclusionCanvas(canvas: HTMLCanvasElement): void {
        const source = this.occlusionSource;
        if (!source) return;
        const scale = Math.min(1, 1600 / Math.max(source.width, source.height));
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        const image = new Image();
        const redraw = (): void => {
            const context = canvas.getContext("2d");
            if (!context || !image.complete) return;
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            const masks = this.activeOcclusionMask
                ? [...this.occlusionMasks, this.activeOcclusionMask]
                : this.occlusionMasks;
            for (const mask of masks) {
                const selected = mask.id === this.selectedOcclusionMaskId;
                context.fillStyle = selected ? "rgba(124, 58, 237, 0.78)" : "rgba(28, 28, 30, 0.9)";
                context.strokeStyle = selected ? "#a78bfa" : "rgba(255, 255, 255, 0.95)";
                context.lineWidth = Math.max(2, canvas.width * 0.003);
                context.fillRect(
                    mask.x * canvas.width,
                    mask.y * canvas.height,
                    mask.width * canvas.width,
                    mask.height * canvas.height,
                );
                context.strokeRect(
                    mask.x * canvas.width,
                    mask.y * canvas.height,
                    mask.width * canvas.width,
                    mask.height * canvas.height,
                );
                if (selected) {
                    const size = Math.max(10, canvas.width * 0.016);
                    context.fillStyle = "#ffffff";
                    context.fillRect(
                        (mask.x + mask.width) * canvas.width - size / 2,
                        (mask.y + mask.height) * canvas.height - size / 2,
                        size,
                        size,
                    );
                }
            }
        };
        image.addEventListener("load", redraw);
        image.src = source.dataUrl;

        const point = (event: PointerEvent): { x: number; y: number } => {
            const bounds = canvas.getBoundingClientRect();
            return {
                x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
                y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
            };
        };
        let start: { x: number; y: number } | null = null;
        let origin: OcclusionMask | null = null;
        let interaction: "create" | "move" | "resize" = "create";
        const hitMask = (position: { x: number; y: number }): OcclusionMask | null =>
            [...this.occlusionMasks]
                .reverse()
                .find(
                    (mask) =>
                        position.x >= mask.x &&
                        position.x <= mask.x + mask.width &&
                        position.y >= mask.y &&
                        position.y <= mask.y + mask.height,
                ) ?? null;
        canvas.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            canvas.setPointerCapture(event.pointerId);
            start = point(event);
            const hit = hitMask(start);
            if (hit) {
                this.selectedOcclusionMaskId = hit.id;
                origin = { ...hit };
                const nearHandle =
                    Math.abs(start.x - (hit.x + hit.width)) < 0.035 &&
                    Math.abs(start.y - (hit.y + hit.height)) < 0.035;
                interaction = nearHandle ? "resize" : "move";
                this.activeOcclusionMask = hit;
            } else {
                interaction = "create";
                origin = null;
                this.activeOcclusionMask = {
                    id: `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    x: start.x,
                    y: start.y,
                    width: 0,
                    height: 0,
                    label: "",
                };
                this.selectedOcclusionMaskId = this.activeOcclusionMask.id;
            }
            redraw();
        });
        canvas.addEventListener("pointermove", (event) => {
            if (!start || !this.activeOcclusionMask) return;
            event.preventDefault();
            const current = point(event);
            if (interaction === "move" && origin) {
                this.activeOcclusionMask.x = Math.max(
                    0,
                    Math.min(1 - origin.width, origin.x + current.x - start.x),
                );
                this.activeOcclusionMask.y = Math.max(
                    0,
                    Math.min(1 - origin.height, origin.y + current.y - start.y),
                );
            } else if (interaction === "resize" && origin) {
                this.activeOcclusionMask.width = Math.max(
                    0.012,
                    Math.min(1 - origin.x, origin.width + current.x - start.x),
                );
                this.activeOcclusionMask.height = Math.max(
                    0.012,
                    Math.min(1 - origin.y, origin.height + current.y - start.y),
                );
            } else {
                this.activeOcclusionMask.x = Math.min(start.x, current.x);
                this.activeOcclusionMask.y = Math.min(start.y, current.y);
                this.activeOcclusionMask.width = Math.abs(current.x - start.x);
                this.activeOcclusionMask.height = Math.abs(current.y - start.y);
            }
            redraw();
        });
        const finish = (event: PointerEvent): void => {
            if (!start || !this.activeOcclusionMask) return;
            event.preventDefault();
            if (
                interaction === "create" &&
                this.activeOcclusionMask.width >= 0.012 &&
                this.activeOcclusionMask.height >= 0.012
            ) {
                this.occlusionMasks.push(this.activeOcclusionMask);
            }
            this.activeOcclusionMask = null;
            start = null;
            this.render();
        };
        canvas.addEventListener("pointerup", finish);
        canvas.addEventListener("pointercancel", finish);
    }

    private async saveImageOcclusion(): Promise<void> {
        const source = this.occlusionSource;
        if (!source || this.occlusionMasks.length === 0) return;
        this.busy = true;
        this.error = "";
        this.render();
        try {
            const sourcePath =
                this.occlusionSourcePath ??
                (await this.store.saveMediaAsset(
                    source.file.name,
                    await source.file.arrayBuffer(),
                ));
            const assets = await renderOcclusionAssets(
                source,
                this.occlusionMasks,
                this.occlusionMode,
            );
            const stem = source.file.name.replace(/\.[^.]+$/, "") || "occlusion";
            const storedAssets = [];
            for (const [index, asset] of assets.entries()) {
                const questionPath = await this.store.saveMediaAsset(
                    `${stem}-occlusion-${index + 1}.png`,
                    asset.question,
                );
                const answerPath = await this.store.saveMediaAsset(
                    `${stem}-answer-${index + 1}.png`,
                    asset.answer,
                );
                storedAssets.push({
                    maskId: asset.maskId,
                    questionPath,
                    answerPath,
                    label: this.occlusionMasks[index]?.label ?? "",
                });
            }
            const draft = {
                deckPath: this.selectedDeck,
                sourcePath,
                masksJson: JSON.stringify(this.occlusionMasks),
                mode: this.occlusionMode,
                assets: storedAssets,
                tags: [...new Set([...this.getTags(), "image-occlusion"])],
            };
            if (this.editingOcclusionNote) {
                const oldAssets = this.getOcclusionAssetPaths(this.editingOcclusionNote);
                await this.store.updateImageOcclusionNote(this.editingOcclusionNote, draft);
                await this.trashGeneratedAssets(oldAssets);
            } else {
                await this.store.createImageOcclusionNote(draft);
            }
            new Notice(t("OCCLUSION_CARDS_CREATED", { count: storedAssets.length }));
            this.occlusionSource = null;
            this.occlusionSourcePath = null;
            this.occlusionMasks = [];
            await this.returnToCards();
        } catch (error) {
            console.error("Spaced Repetition: image occlusion creation failed", error);
            this.busy = false;
            this.error = t("OCCLUSION_SAVE_FAILED");
            this.render();
        }
    }

    private getOcclusionAssetPaths(note: CollectionNote): string[] {
        try {
            const assets = JSON.parse(note.fields[OCCLUSION_ASSETS_FIELD_ID] ?? "[]") as Array<{
                questionPath?: string;
                answerPath?: string;
            }>;
            return assets
                .flatMap((asset) => [asset.questionPath, asset.answerPath])
                .filter((path): path is string => Boolean(path));
        } catch {
            return [];
        }
    }

    private async trashGeneratedAssets(paths: string[]): Promise<void> {
        for (const path of new Set(paths)) {
            const file = this.plugin.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) await this.plugin.app.fileManager.trashFile(file);
        }
    }

    private renderMediaManager(surface: HTMLElement): void {
        surface.addClass("sr-native-media-manager");
        const actions = surface.createDiv("sr-media-manager-actions");
        this.createMediaImportButton(
            actions,
            "paperclip",
            t("IMPORT_MEDIA"),
            "image/*,audio/*,video/*",
        );
        this.createMediaImportButton(actions, "camera", t("TAKE_PHOTO"), "image/*", true);
        const record = new ButtonComponent(actions)
            .setIcon(this.isRecordingMedia ? "square" : "mic")
            .setButtonText(this.isRecordingMedia ? t("STOP_RECORDING") : t("RECORD_AUDIO"))
            .onClick(() => void this.toggleAudioRecording());
        record.buttonEl.toggleClass("is-recording", this.isRecordingMedia);
        const list = surface.createDiv("sr-media-manager-list");
        list.createDiv({ cls: "sr-media-manager-loading", text: t("SCANNING_MEDIA") });
        void this.populateMediaManager(list);
    }

    private createMediaImportButton(
        parent: HTMLElement,
        icon: string,
        label: string,
        accept: string,
        capture = false,
    ): void {
        const wrapper = parent.createDiv("sr-media-import-control");
        const button = new ButtonComponent(wrapper).setIcon(icon).setButtonText(label);
        const input = wrapper.createEl("input", {
            cls: "sr-native-media-input",
            attr: {
                type: "file",
                accept,
                ...(capture ? { capture: "environment" } : {}),
            },
        });
        button.onClick(() => input.click());
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (!file) return;
            void file
                .arrayBuffer()
                .then((data) => this.store.saveMediaAsset(file.name, data))
                .then(() => {
                    new Notice(t("MEDIA_IMPORTED"));
                    this.render();
                })
                .catch(() => new Notice(t("MEDIA_IMPORT_FAILED")));
        });
    }

    private async toggleAudioRecording(): Promise<void> {
        if (this.mediaRecorder?.state === "recording") {
            this.mediaRecorder.stop();
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.mediaRecordingChunks = [];
            this.mediaRecorder = new MediaRecorder(stream);
            this.mediaRecorder.addEventListener("dataavailable", (event) => {
                if (event.data.size > 0) this.mediaRecordingChunks.push(event.data);
            });
            this.mediaRecorder.addEventListener("stop", () => {
                stream.getTracks().forEach((track) => track.stop());
                const type = this.mediaRecordingChunks[0]?.type || "audio/webm";
                const extension = type.includes("mp4")
                    ? "m4a"
                    : type.includes("ogg")
                      ? "ogg"
                      : "webm";
                const blob = new Blob(this.mediaRecordingChunks, { type });
                void blob
                    .arrayBuffer()
                    .then((data) =>
                        this.store.saveMediaAsset(`recording-${Date.now()}.${extension}`, data),
                    )
                    .then(() => new Notice(t("AUDIO_RECORDED")))
                    .catch(() => new Notice(t("MEDIA_IMPORT_FAILED")))
                    .finally(() => {
                        this.isRecordingMedia = false;
                        this.mediaRecorder = null;
                        this.render();
                    });
            });
            this.mediaRecorder.start();
            this.isRecordingMedia = true;
            this.render();
        } catch {
            new Notice(t("MICROPHONE_UNAVAILABLE"));
        }
    }

    private async populateMediaManager(parent: HTMLElement): Promise<void> {
        const settings = this.plugin.dataManager.data.settings;
        const mediaPrefix = `${settings.scheduleDataVaultLocation}/Media/`;
        const files = this.plugin.app.vault
            .getFiles()
            .filter((file) => file.path.startsWith(mediaPrefix));
        const referenced = new Set<string>();
        const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
        const contents = await Promise.all(
            markdownFiles.map((file) => this.plugin.app.vault.cachedRead(file)),
        );
        for (const content of contents) {
            for (const match of content.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
                referenced.add(match[1].trim());
            }
        }
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        for (const note of Object.values(snapshot.notes)) {
            if (note.deletedAt) continue;
            const value = JSON.stringify(note.fields);
            for (const file of files) if (value.includes(file.path)) referenced.add(file.path);
        }

        const hashGroups = new Map<string, TFile[]>();
        for (const file of files) {
            const data = await this.plugin.app.vault.readBinary(file);
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
            const group = hashGroups.get(hash) ?? [];
            group.push(file);
            hashGroups.set(hash, group);
        }
        const duplicates = new Set(
            [...hashGroups.values()].filter((group) => group.length > 1).flatMap((group) => group),
        );
        const orphans = files.filter((file) => !referenced.has(file.path));
        if (!parent.isConnected) return;
        parent.empty();

        const summary = parent.createDiv("sr-media-manager-summary");
        this.createMediaStat(summary, files.length, t("MEDIA_FILES"));
        this.createMediaStat(summary, orphans.length, t("UNUSED_MEDIA"));
        this.createMediaStat(summary, duplicates.size, t("DUPLICATE_MEDIA"));
        if (orphans.length > 0) {
            new ButtonComponent(summary)
                .setIcon("trash-2")
                .setButtonText(t("CLEAN_UNUSED_MEDIA"))
                .onClick(() => this.confirmTrashMedia(orphans));
        }
        if (files.length === 0) {
            parent.createDiv({ cls: "sr-media-manager-empty", text: t("NO_MEDIA_FILES") });
            return;
        }
        for (const file of files) {
            const row = parent.createDiv("sr-media-manager-row");
            const preview = row.createDiv("sr-media-manager-preview");
            if (/^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i.test(file.extension)) {
                preview.createEl("img", {
                    attr: { src: this.plugin.app.vault.getResourcePath(file), alt: file.name },
                });
            } else {
                setIcon(
                    preview,
                    /^(mp3|wav|m4a|ogg|flac|aac|webm)$/i.test(file.extension)
                        ? "audio-lines"
                        : "film",
                );
            }
            const copy = row.createDiv("sr-media-manager-copy");
            copy.createEl("strong", { text: file.name });
            copy.createSpan({ text: this.formatFileSize(file.stat.size) });
            const badges = copy.createDiv("sr-media-manager-badges");
            if (!referenced.has(file.path)) badges.createSpan({ text: t("UNUSED") });
            if (duplicates.has(file)) badges.createSpan({ text: t("DUPLICATE") });
            const rowActions = row.createDiv("sr-media-manager-row-actions");
            const replace = new ButtonComponent(rowActions)
                .setIcon("replace")
                .setTooltip(t("REPLACE_MEDIA"));
            const replaceInput = rowActions.createEl("input", {
                cls: "sr-native-media-input",
                attr: { type: "file", accept: "image/*,audio/*,video/*" },
            });
            replace.onClick(() => replaceInput.click());
            replaceInput.addEventListener("change", () => {
                const replacement = replaceInput.files?.[0];
                if (!replacement) return;
                void replacement
                    .arrayBuffer()
                    .then((data) => this.plugin.app.vault.modifyBinary(file, data))
                    .then(() => {
                        new Notice(t("MEDIA_REPLACED"));
                        this.render();
                    });
            });
            new ButtonComponent(rowActions)
                .setIcon("trash-2")
                .setTooltip(t("DELETE_MEDIA"))
                .onClick(() => this.confirmTrashMedia([file]));
        }
    }

    private createMediaStat(parent: HTMLElement, value: number, label: string): void {
        const stat = parent.createDiv("sr-media-manager-stat");
        stat.createEl("strong", { text: String(value) });
        stat.createSpan({ text: label });
    }

    private confirmTrashMedia(files: TFile[]): void {
        new ConfirmationModal(
            this.plugin.app,
            t("DELETE_MEDIA"),
            t("DELETE_MEDIA_CONFIRMATION", { count: files.length }),
            t("CANCEL"),
            async () => {
                for (const file of files) await this.plugin.app.fileManager.trashFile(file);
                new Notice(t("MEDIA_MOVED_TO_TRASH", { count: files.length }));
                this.render();
            },
        ).open();
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
            if (noteType.id === IMAGE_OCCLUSION_NOTE_TYPE_ID) continue;
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
                        if (noteType.id === BASIC_NOTE_TYPE_ID)
                            this.cardVariants = new Set(["basic"]);
                        else if (noteType.id === REVERSED_NOTE_TYPE_ID)
                            this.cardVariants = new Set(["reversed"]);
                        else if (noteType.id === CLOZE_NOTE_TYPE_ID)
                            this.cardVariants = new Set(["cloze"]);
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
            if (field.kind === "media") this.renderMediaControls(group, `field:${field.id}`);
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
            (field) =>
                field.required &&
                !this.customFieldValues[field.id]?.trim() &&
                !this.hasPendingMedia(`field:${field.id}`),
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
            await this.materializePendingMedia();
            const draft = {
                deckPath: this.selectedDeck,
                noteTypeId: noteType.id,
                fields: Object.fromEntries(
                    noteType.fields.map((field) => [
                        field.id,
                        this.withMediaEmbeds(
                            this.customFieldValues[field.id] ?? "",
                            `field:${field.id}`,
                        ),
                    ]),
                ),
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
                this.existingMedia = [];
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
        const includesCloze = this.editingCard
            ? this.cardType === "cloze"
            : this.cardVariants.has("cloze");
        const fieldsMissing = includesCloze
            ? !this.front.trim() || !this.back.trim()
            : (!this.front.trim() && !this.hasPendingMedia("front")) ||
              (!this.back.trim() && !this.hasPendingMedia("back"));
        if (fieldsMissing) {
            this.error = t("CARD_FIELDS_REQUIRED");
            this.render();
            return;
        }
        if (includesCloze && !this.front.includes(this.back.trim())) {
            this.error = t("CLOZE_ANSWER_NOT_FOUND");
            this.render();
            return;
        }

        this.busy = true;
        this.error = "";
        this.render();
        try {
            await this.materializePendingMedia();
            const draft: NativeCardDraft = {
                deckPath: this.selectedDeck,
                type: this.cardType,
                front: this.withMediaEmbeds(this.front, "front"),
                back: this.withMediaEmbeds(this.back, "back"),
                tags: this.getTags(),
            };
            if (this.editingCard) await this.saveEditedCard(draft);
            else {
                const types = [...this.cardVariants];
                await this.store.createCards(
                    types.map((type) => ({
                        ...draft,
                        type,
                    })),
                );
            }
            new Notice(this.editingCard ? t("CARD_UPDATED") : t("CARD_SAVED"));
            if (addAnother) {
                this.front = "";
                this.back = "";
                this.clearPendingMedia();
                this.existingMedia = [];
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
