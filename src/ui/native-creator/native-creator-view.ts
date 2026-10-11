import "src/ui/native-creator/native-creator-view.css";
import {
    ButtonComponent,
    ItemView,
    MarkdownRenderer,
    Menu,
    normalizePath,
    Notice,
    Platform,
    setIcon,
    TFile,
    WorkspaceLeaf,
} from "obsidian";

import {
    AnkiPackage,
    parseAnkiPackage,
    parseDelimited,
    writeDelimited,
} from "src/data/anki/anki-package";
import {
    AnkiImportReport,
    AnkiTransferService,
    DuplicatePolicy,
} from "src/data/anki/anki-transfer-service";
import {
    canonicalAnswerMode,
    createDefaultAnswerConfig,
    normalizeAnswerConfig,
} from "src/data/collection/answer-evaluator";
import {
    BASIC_NOTE_TYPE_ID,
    CLOZE_NOTE_TYPE_ID,
    IMAGE_OCCLUSION_NOTE_TYPE_ID,
    OCCLUSION_ASSETS_FIELD_ID,
    OCCLUSION_COMMENTS_FIELD_ID,
    OCCLUSION_EXTRA_FIELD_ID,
    OCCLUSION_HEADER_FIELD_ID,
    OCCLUSION_MASKS_FIELD_ID,
    OCCLUSION_MODE_FIELD_ID,
    OCCLUSION_REFERENCE_FIELD_ID,
    OCCLUSION_SOURCE_FIELD_ID,
    REVERSED_NOTE_TYPE_ID,
} from "src/data/collection/builtin-note-types";
import { DEFAULT_DECK_OPTIONS_ID } from "src/data/collection/collection-store";
import {
    CardAnswerMode,
    CardTemplateDefinition,
    CollectionNote,
    DeckOptionsDefinition,
    FieldKind,
    NoteFieldDefinition,
    NoteTypeDefinition,
    NoteTypeKind,
    TemplateBlockKind,
    TemplateSurface,
    TemplateVisualBlock,
} from "src/data/collection/collection-types";
import {
    compileTemplateBlocks,
    conditionForField,
    createTemplateVisualBlock,
    inferTemplateBlocks,
    TEMPLATE_LIBRARY,
    TemplateLibraryBlueprint,
    validateTemplateDesign,
} from "src/data/collection/template-designer";
import { CARD_BROWSER_VIEW_TYPE, CARD_CREATOR_VIEW_TYPE } from "src/data/constants";
import { Card } from "src/data/data-structures/card/card";
import { CardType } from "src/data/data-structures/card/questions/question";
import {
    NativeCardDraft,
    NativeCardStore,
    NativeCardType,
    normalizeManagedDeckPath,
    renderNoteTypeTemplate,
    StructuredNoteDraft,
} from "src/data/native-card-store";
import { KnowledgeArea } from "src/data/plugin-data";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { DeckPickerModal } from "src/ui/deck-picker-modal";
import {
    cloneOcclusionMasks,
    getOcclusionCardGroups,
    LoadedOcclusionImage,
    loadOcclusionImage,
    normalizeOcclusionMask,
    OcclusionMask,
    OcclusionMode,
    OcclusionPoint,
    OcclusionShape,
    pointInOcclusionMask,
    renderOcclusionAssets,
} from "src/ui/native-creator/image-occlusion";
import { extractBatchClozeSeeds, QuickAddSeed } from "src/ui/native-creator/quick-add";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";
import { escapeHtml } from "src/utils/escape-html";

export type NativeCreatorMode =
    | "card"
    | "image-occlusion"
    | "media"
    | "transfer"
    | "deck"
    | "deck-options"
    | "area"
    | "note-type";

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
    version: number;
    name: string;
    kind: NoteTypeKind;
    fields: NoteFieldDefinition[];
    templates: CardTemplateDefinition[];
    css: string;
}

interface CreatorStickyPreferences {
    deck: boolean;
    noteType: boolean;
    tags: boolean;
    fieldIds: string[];
}

interface CardEditorSnapshot {
    front: string;
    back: string;
    deckPath: string;
    noteTypeId: string;
    cardType: NativeCardType;
    answerMode: "reveal" | "type";
    tagsText: string;
    customFieldValues: Record<string, string>;
}

type OcclusionTool = OcclusionShape | "pan";

export interface NativeCreatorRequest {
    mode: NativeCreatorMode;
    deckPath?: string;
    card?: Card;
    duplicateCard?: Card;
    editAreaId?: string;
    targetAreaId?: string;
    initialSeeds?: QuickAddSeed[];
}

export class NativeCreatorView extends ItemView {
    private request: NativeCreatorRequest = { mode: "card" };
    private readonly store: NativeCardStore;
    private selectedDeck = "";
    private cardType: NativeCardType = "basic";
    private answerMode: "reveal" | "type" = "reveal";
    private front = "";
    private back = "";
    private busy = false;
    private error = "";
    private editingCard: Card | null = null;
    private editingAreaId: string | null = null;
    private areaName = "";
    private areaScheduling: NonNullable<KnowledgeArea["scheduling"]> = {};
    private areaParentId: string | null = null;
    private areaKind: "area" | "project" = "area";
    private areaGoal: NonNullable<KnowledgeArea["goal"]> = {};
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
    private selectedOcclusionMaskIds = new Set<string>();
    private occlusionMode: OcclusionMode = "hide-all";
    private occlusionTool: OcclusionTool = "rectangle";
    private occlusionPolygonDraft: OcclusionPoint[] = [];
    private occlusionUndoStack: OcclusionMask[][] = [];
    private occlusionRedoStack: OcclusionMask[][] = [];
    private occlusionZoom = 1;
    private occlusionHeader = "";
    private occlusionExtra = "";
    private occlusionComments = "";
    private occlusionReference = "";
    private editingOcclusionNote: CollectionNote | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private mediaRecordingChunks: Blob[] = [];
    private isRecordingMedia = false;
    private draftRestored = false;
    private templatePreviewDevice: "phone" | "desktop" = "phone";
    private templatePreviewTheme: "light" | "dark" = "dark";
    private templatePreviewValues: Record<string, string> = {};
    private transferPackage: AnkiPackage | null = null;
    private transferFileName = "";
    private transferSelectedDeckIds = new Set<number>();
    private transferDuplicatePolicy: DuplicatePolicy = "skip";
    private transferReport: AnkiImportReport | null = null;
    private transferProgress = "";
    private transferCsvRows: string[][] = [];
    private transferCsvDelimiter: "," | "\t" = ",";
    private transferCsvNoteTypeId = BASIC_NOTE_TYPE_ID;
    private transferCsvDeck = "";
    private transferCsvMapping: Record<string, number> = {};
    private transferCsvTagsColumn = -1;
    private quickAddQueue: QuickAddSeed[] = [];
    private stickyPreferences: CreatorStickyPreferences = {
        deck: true,
        noteType: true,
        tags: false,
        fieldIds: [],
    };
    private cardUndoStack: CardEditorSnapshot[] = [];
    private cardRedoStack: CardEditorSnapshot[] = [];
    private fieldEditStart: CardEditorSnapshot | null = null;
    private showCardPreview = false;
    private occlusionBatchFiles: File[] = [];
    private occlusionBatchTotal = 0;

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
        if (this.request.mode === "transfer")
            return this.transferText("Import & export", "Импорт и экспорт");
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
        if (this.request.mode === "transfer") return "arrow-left-right";
        if (this.request.mode === "area") return "library-big";
        if (this.request.mode === "deck-options") return "sliders-horizontal";
        if (this.request.mode === "note-type") return "shapes";
        return this.request.mode === "deck" ? "layers-3" : "square-pen";
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass("sr-native-creator-view");
        this.registerDomEvent(this.contentEl, "keydown", (event: KeyboardEvent) => {
            if (this.request.mode !== "card" || this.busy) return;
            const modifier = event.metaKey || event.ctrlKey;
            if (modifier && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void this.saveCurrentCard(event.shiftKey);
                return;
            }
            const target = event.target as HTMLElement | null;
            const nativeEditor =
                target?.isContentEditable ||
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement;
            if (!nativeEditor && modifier && event.key.toLowerCase() === "z") {
                event.preventDefault();
                if (event.shiftKey) this.redoCardEdit();
                else this.undoCardEdit();
            }
        });
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
        this.stickyPreferences = this.loadStickyPreferences();
        this.cardUndoStack = [];
        this.cardRedoStack = [];
        this.quickAddQueue = [];
        this.selectedDeck =
            request.deckPath ??
            (this.selectedDeck || localStorage.getItem(this.lastDeckKey()) || "");
        this.editingCard = request.card ?? null;
        this.editingStructuredNote = null;
        this.editingOcclusionNote = null;
        if (request.mode === "image-occlusion" && !request.card) {
            this.occlusionBatchFiles = [];
            this.occlusionBatchTotal = 0;
            this.resetOcclusionEditor();
        }
        this.editingAreaId = request.editAreaId ?? null;
        if (request.mode !== "note-type") this.noteTypeDraft = null;
        this.areaName = this.editingAreaId
            ? (this.store.getKnowledgeAreas().find((area) => area.id === this.editingAreaId)
                  ?.name ?? "")
            : "";
        this.areaScheduling = this.editingAreaId
            ? {
                  ...(this.store.getKnowledgeAreas().find((area) => area.id === this.editingAreaId)
                      ?.scheduling ?? {}),
              }
            : {};
        const editingArea = this.editingAreaId
            ? this.store.getKnowledgeAreas().find((area) => area.id === this.editingAreaId)
            : undefined;
        this.areaParentId = editingArea?.parentId ?? request.targetAreaId ?? null;
        this.areaKind = editingArea?.kind ?? "area";
        this.areaGoal = { ...(editingArea?.goal ?? {}) };
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
                this.selectedNoteTypeId = this.noteTypeIdForCardType(this.cardType);
                if (structuredNote?.answerMode) {
                    this.answerMode =
                        canonicalAnswerMode(structuredNote.answerMode) === "text"
                            ? "type"
                            : "reveal";
                }
                this.front = this.extractMediaEmbeds(this.front, "front");
                this.back = this.extractMediaEmbeds(this.back, "back");
            }
        } else if (request.duplicateCard) {
            const source = request.duplicateCard;
            const structuredNote = this.plugin.dataManager.collectionStore.findNoteBySource(
                source.storageInfo?.notePath ?? "",
                source.storageInfo?.questionId,
            );
            this.loadCardForEditing(source);
            this.selectedNoteTypeId = this.noteTypeIdForCardType(this.cardType);
            if (structuredNote?.answerMode) {
                this.answerMode =
                    canonicalAnswerMode(structuredNote.answerMode) === "text" ? "type" : "reveal";
            }
            this.tagsText = structuredNote?.tags.join(", ") ?? "";
            this.front = this.extractMediaEmbeds(this.front, "front");
            this.back = this.extractMediaEmbeds(this.back, "back");
        } else if (wasEditing) {
            this.front = "";
            this.back = "";
            this.cardType = "basic";
            this.selectedNoteTypeId = BASIC_NOTE_TYPE_ID;
            this.answerMode = "reveal";
            this.customFieldValues = {};
            this.tagsText = "";
            this.existingMedia = [];
        } else if (request.mode === "card" && !this.draftRestored) {
            this.restoreDraft();
        }
        if (request.mode === "card" && request.initialSeeds?.length) {
            this.clearDraft();
            this.quickAddQueue = request.initialSeeds.slice(1);
            this.applyQuickAddSeed(request.initialSeeds[0]);
        }
        this.error = "";
        if (this.contentEl.isShown()) this.render();
    }

    private render(): void {
        this.contentEl.empty();
        this.contentEl.addClass("sr-native-creator-view");

        const page = this.contentEl.createDiv("sr-native-creator-page");
        const top = page.createDiv("sr-native-creator-top");
        top.toggleClass("sr-native-creator-top-card", this.request.mode === "card");
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
                        : this.request.mode === "transfer"
                          ? this.transferText("Import & export", "Импорт и экспорт")
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
                        : this.request.mode === "transfer"
                          ? this.transferText(
                                "Move Anki packages and spreadsheets without leaving your vault.",
                                "Переносите пакеты Anki и таблицы, не покидая хранилище.",
                            )
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
            const section = new ButtonComponent(top)
                .setButtonText(this.getModeLabel(this.request.mode))
                .setTooltip(t("OPEN_SECTION_MENU"))
                .onClick((event) => this.openModeMenu(event));
            section.buttonEl.addClass("sr-native-section-picker");
            section.buttonEl.setAttribute("aria-haspopup", "menu");
            const icon = section.buttonEl.createSpan("sr-native-section-picker-icon");
            setIcon(icon, this.getModeIcon(this.request.mode));
            section.buttonEl.prepend(icon);
            const chevron = section.buttonEl.createSpan("sr-native-section-picker-chevron");
            setIcon(chevron, "chevron-down");
        }

        if (this.request.mode === "card") {
            const save = new ButtonComponent(top)
                .setButtonText(
                    this.busy
                        ? t("SAVING")
                        : this.editingCard || this.editingStructuredNote
                          ? t("SAVE_CHANGES")
                          : t("SAVE"),
                )
                .setDisabled(this.busy)
                .onClick(() => void this.saveCurrentCard(false));
            save.buttonEl.addClass("sr-native-top-save");
            save.buttonEl.addClass("mod-cta");
        }

        const surface = page.createDiv("sr-native-creator-surface");
        if (this.request.mode === "image-occlusion") this.renderImageOcclusionForm(surface);
        else if (this.request.mode === "media") this.renderMediaManager(surface);
        else if (this.request.mode === "transfer") this.renderTransferManager(surface);
        else if (this.request.mode === "deck") this.renderDeckForm(surface);
        else if (this.request.mode === "deck-options") this.renderDeckOptionsForm(surface);
        else if (this.request.mode === "area") this.renderAreaForm(surface);
        else if (this.request.mode === "note-type") this.renderNoteTypeManager(surface);
        else this.renderCardForm(surface);
    }

    private getModeLabel(mode: NativeCreatorMode): string {
        if (mode === "deck") return t("DECK");
        if (mode === "area") return t("KNOWLEDGE_AREAS");
        if (mode === "note-type") return t("NOTE_TYPES");
        if (mode === "media") return t("MEDIA_LIBRARY");
        if (mode === "transfer") return this.transferText("Import & export", "Импорт и экспорт");
        return t("CARD");
    }

    private getModeIcon(mode: NativeCreatorMode): string {
        if (mode === "deck") return "layers-3";
        if (mode === "area") return "library-big";
        if (mode === "note-type") return "shapes";
        if (mode === "media") return "images";
        if (mode === "transfer") return "arrow-left-right";
        return "square-pen";
    }

    private openModeMenu(event: MouseEvent): void {
        const menu = new Menu();
        for (const mode of ["card", "deck", "area", "note-type", "media", "transfer"] as const) {
            menu.addItem((item) =>
                item
                    .setTitle(this.getModeLabel(mode))
                    .setIcon(this.getModeIcon(mode))
                    .setChecked(this.request.mode === mode)
                    .onClick(() => {
                        this.request = { mode, deckPath: this.selectedDeck };
                        this.editingAreaId = null;
                        this.areaName = "";
                        this.noteTypeDraft = null;
                        this.error = "";
                        this.render();
                    }),
            );
        }
        if (this.getLastCreatedCard()) {
            menu.addSeparator();
            menu.addItem((item) =>
                item
                    .setTitle(t("DUPLICATE_CARD"))
                    .setIcon("copy-plus")
                    .onClick(() => this.duplicateLastCreatedCard()),
            );
        }
        menu.showAtMouseEvent(event);
    }

    private renderCardForm(surface: HTMLElement): void {
        surface.addClass("sr-native-card-editor");
        const utility = surface.createDiv("sr-native-card-utility");
        if (this.quickAddQueue.length > 0) {
            const queue = utility.createDiv("sr-native-quick-queue");
            const queueIcon = queue.createSpan();
            setIcon(queueIcon, "list-checks");
            queue.createSpan({
                text: this.creatorText(
                    `${this.quickAddQueue.length + 1} cards in Quick Add`,
                    `${this.quickAddQueue.length + 1} карточек в Quick Add`,
                ),
            });
        } else {
            utility.createSpan({
                cls: "sr-native-quick-hint",
                text: this.creatorText(
                    "⌘↵ Save · ⇧⌘↵ Save & next",
                    "⌘↵ Сохранить · ⇧⌘↵ Сохранить и дальше",
                ),
            });
        }
        const utilityActions = utility.createDiv("sr-native-card-utility-actions");
        for (const [icon, label, disabled, action] of [
            ["undo-2", t("UNDO"), this.cardUndoStack.length === 0, () => this.undoCardEdit()],
            ["redo-2", t("REDO"), this.cardRedoStack.length === 0, () => this.redoCardEdit()],
        ] as const) {
            const button = new ButtonComponent(utilityActions)
                .setIcon(icon)
                .setTooltip(label)
                .setDisabled(disabled)
                .onClick(action);
            button.buttonEl.addClass("sr-native-icon-button");
        }
        const previewToggle = new ButtonComponent(utilityActions)
            .setIcon("panel-top")
            .setTooltip(this.creatorText("Preview card", "Предпросмотр карточки"))
            .onClick(() => {
                this.showCardPreview = !this.showCardPreview;
                this.render();
            });
        previewToggle.buttonEl.addClass("sr-native-icon-button");
        previewToggle.buttonEl.toggleClass("is-active", this.showCardPreview);

        const meta = surface.createDiv("sr-native-card-meta");
        const deckGroup = this.createFieldGroup(meta, t("DECK"));
        deckGroup.addClass("sr-native-compact-field");
        const editingCustomType = this.editingStructuredNote
            ? this.plugin.dataManager.collectionStore.getNoteType(
                  this.editingStructuredNote.noteTypeId,
              )
            : null;
        if (this.editingCard && !this.editingStructuredNote) {
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

        const typeGroup = this.createFieldGroup(meta, t("NOTE_TYPES"));
        typeGroup.addClass("sr-native-compact-field");
        if (editingCustomType) {
            const selectedType = this.getSelectedNoteType();
            const picker = new ButtonComponent(typeGroup)
                .setButtonText(this.getNoteTypeDisplayName(selectedType))
                .setClass("sr-native-picker")
                .onClick((event) => this.openNoteTypeMenu(event));
            picker.buttonEl.setAttribute("aria-haspopup", "menu");
            const chevron = picker.buttonEl.createSpan("sr-native-picker-chevron");
            setIcon(chevron, "chevron-down");
            this.renderCustomNoteFields(surface, selectedType);
            return;
        } else if (this.editingCard) {
            typeGroup.createDiv({
                cls: "sr-native-readonly-value",
                text: this.getNativeCardTypeLabel(this.cardType),
            });
        } else {
            let noteType = this.getSelectedNoteType();
            if (noteType.id === IMAGE_OCCLUSION_NOTE_TYPE_ID) {
                this.selectedNoteTypeId = BASIC_NOTE_TYPE_ID;
                this.cardType = "basic";
                noteType = this.getSelectedNoteType();
            }
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
            const recentDecks = this.getRecentDecks()
                .filter((deck) => deck !== this.selectedDeck)
                .slice(0, 3);
            if (recentDecks.length > 0) {
                const recent = surface.createDiv("sr-native-recent-decks");
                recent.createSpan({
                    text: this.creatorText("Recent", "Недавние"),
                    cls: "sr-native-recent-label",
                });
                for (const deck of recentDecks) {
                    const button = recent.createEl("button", {
                        text: deck.split("/").pop() ?? deck,
                        attr: { type: "button", title: deck },
                    });
                    button.addEventListener("click", () => {
                        this.rememberCardState();
                        this.selectedDeck = deck;
                        this.rememberDeck(deck);
                        this.saveDraft();
                        this.render();
                    });
                }
            }
        }

        const frontLabel = this.cardType === "cloze" ? t("CLOZE_TEXT") : t("CARD_FRONT");
        const frontHelp = this.cardType === "cloze" ? t("CLOZE_TEXT_HELP") : undefined;
        const cardFields = surface.createDiv("sr-native-card-fields");
        let duplicateStatus: HTMLDivElement | null = null;
        const updateDuplicateStatus = (): void => {
            if (!duplicateStatus) return;
            const count = this.countMatchingFronts(this.front);
            duplicateStatus.hidden = count === 0;
            duplicateStatus.setText(
                this.creatorText(
                    `${count} possible duplicate${count === 1 ? "" : "s"}`,
                    `Возможных дубликатов: ${count}`,
                ),
            );
        };
        const frontGroup = this.createFieldGroup(cardFields, frontLabel, frontHelp);
        const frontInput = this.createRichTextEditor(
            frontGroup,
            this.front,
            this.cardType === "cloze" ? t("CLOZE_TEXT_PLACEHOLDER") : t("CARD_FRONT_PLACEHOLDER"),
            frontLabel,
            "front",
            (value) => {
                this.front = value;
                updateDuplicateStatus();
            },
        );

        const backGroup = this.createFieldGroup(
            cardFields,
            this.cardType === "cloze" ? t("CLOZE_ANSWER") : t("CARD_BACK"),
            this.cardType === "cloze" ? t("CLOZE_ANSWER_HELP") : undefined,
        );
        this.createRichTextEditor(
            backGroup,
            this.back,
            this.cardType === "cloze" ? t("CLOZE_ANSWER_PLACEHOLDER") : t("CARD_BACK_PLACEHOLDER"),
            this.cardType === "cloze" ? t("CLOZE_ANSWER") : t("CARD_BACK"),
            "back",
            (value) => (this.back = value),
        );
        duplicateStatus = cardFields.createDiv({
            cls: "sr-native-duplicate-status",
            attr: { role: "status", "aria-live": "polite" },
        });
        updateDuplicateStatus();

        if (this.showCardPreview) this.renderFullCardPreview(surface);

        const advanced = surface.createEl("details", { cls: "sr-native-card-advanced" });
        if (this.answerMode === "type" || this.tagsText.trim()) advanced.open = true;
        const advancedSummary = advanced.createEl("summary");
        advancedSummary.createSpan({ text: t("MORE_CARD_OPTIONS") });
        const advancedChevron = advancedSummary.createSpan("sr-native-card-advanced-chevron");
        setIcon(advancedChevron, "chevron-down");
        const advancedBody = advanced.createDiv("sr-native-card-advanced-body");

        const answerMode = this.createFieldGroup(
            advancedBody,
            t("ANSWER_MODE"),
            t("ANSWER_MODE_HELP"),
        );
        const answerModePicker = answerMode.createDiv("sr-native-answer-mode-picker");
        for (const [mode, label, iconName] of [
            ["reveal", t("ANSWER_MODE_REVEAL"), "eye"],
            ["type", t("ANSWER_MODE_TYPE"), "text-cursor-input"],
        ] as const) {
            const button = new ButtonComponent(answerModePicker).setButtonText(label);
            button.buttonEl.toggleClass("is-active", this.answerMode === mode);
            button.buttonEl.setAttribute("aria-pressed", String(this.answerMode === mode));
            const icon = button.buttonEl.createSpan("sr-native-answer-mode-icon");
            setIcon(icon, iconName);
            button.buttonEl.prepend(icon);
            button.onClick(() => {
                this.rememberCardState();
                this.answerMode = mode;
                this.error = "";
                this.saveDraft();
                this.render();
            });
        }

        this.renderTagsField(advancedBody);
        this.renderStickyControls(advancedBody, ["front", "back"]);

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
                .setButtonText(
                    this.quickAddQueue.length
                        ? this.creatorText(
                              `Save & next · ${this.quickAddQueue.length} left`,
                              `Сохранить и дальше · осталось ${this.quickAddQueue.length}`,
                          )
                        : t("SAVE_AND_ADD_ANOTHER"),
                )
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

        if (!Platform.isMobile) window.setTimeout(() => frontInput.focus(), 0);
    }

    private renderFullCardPreview(parent: HTMLElement): void {
        const preview = parent.createDiv("sr-native-full-preview");
        const heading = preview.createDiv("sr-native-full-preview-heading");
        heading.createSpan({
            text: this.creatorText("Card preview", "Предпросмотр карточки"),
        });
        heading.createSpan({
            cls: "sr-native-full-preview-mode",
            text: this.answerMode === "type" ? t("ANSWER_MODE_TYPE") : t("ANSWER_MODE_REVEAL"),
        });
        for (const [label, value] of [
            [t("CARD_FRONT"), this.front],
            [t("CARD_BACK"), this.back],
        ] as const) {
            const face = preview.createDiv("sr-native-full-preview-face");
            face.createSpan({ text: label });
            const body = face.createDiv("sr-native-full-preview-body");
            if (!value.trim()) {
                body.createEl("em", {
                    text: this.creatorText("Empty field", "Пустое поле"),
                });
            } else {
                void MarkdownRenderer.render(
                    this.app,
                    value,
                    body,
                    this.editingCard?.question.note.filePath ?? "",
                    this,
                );
            }
        }
    }

    private renderStructuredCardPreview(parent: HTMLElement, noteType: NoteTypeDefinition): void {
        const template = noteType.templates[0];
        if (!template) return;
        const preview = parent.createDiv("sr-native-full-preview");
        preview.createDiv({
            cls: "sr-native-full-preview-heading",
            text: this.creatorText("Live card preview", "Предпросмотр карточки"),
        });
        const question = renderNoteTypeTemplate(
            template.questionFormat,
            noteType,
            this.customFieldValues,
        );
        const answer = renderNoteTypeTemplate(
            template.answerFormat,
            noteType,
            this.customFieldValues,
            question,
        );
        for (const [label, value] of [
            [t("CARD_FRONT"), question],
            [t("CARD_BACK"), answer],
        ] as const) {
            const face = preview.createDiv("sr-native-full-preview-face");
            face.createSpan({ text: label });
            const body = face.createDiv("sr-native-full-preview-body");
            void MarkdownRenderer.render(this.app, value, body, "", this);
        }
    }

    private renderStickyControls(parent: HTMLElement, fieldIds: string[]): void {
        const section = this.createFieldGroup(
            parent,
            this.creatorText("Keep for the next card", "Сохранить для следующей карточки"),
            this.creatorText(
                "Pinned values stay when you use Save & add another.",
                "Закреплённые значения сохраняются после «Сохранить и добавить ещё».",
            ),
        );
        section.addClass("sr-native-sticky-section");
        const controls = section.createDiv("sr-native-sticky-controls");
        const options: Array<[string, boolean, () => void]> = [
            [
                t("DECK"),
                this.stickyPreferences.deck,
                () => {
                    this.stickyPreferences.deck = !this.stickyPreferences.deck;
                    this.saveStickyPreferences();
                    this.render();
                },
            ],
            [
                t("NOTE_TYPES"),
                this.stickyPreferences.noteType,
                () => {
                    this.stickyPreferences.noteType = !this.stickyPreferences.noteType;
                    this.saveStickyPreferences();
                    this.render();
                },
            ],
            [
                t("TAGS"),
                this.stickyPreferences.tags,
                () => {
                    this.stickyPreferences.tags = !this.stickyPreferences.tags;
                    this.saveStickyPreferences();
                    this.render();
                },
            ],
            ...fieldIds.map((fieldId): [string, boolean, () => void] => [
                fieldId === "front"
                    ? t("CARD_FRONT")
                    : fieldId === "back"
                      ? t("CARD_BACK")
                      : (this.getSelectedNoteType().fields.find((field) => field.id === fieldId)
                            ?.name ?? fieldId),
                this.stickyPreferences.fieldIds.includes(fieldId),
                () => this.toggleStickyField(fieldId),
            ]),
        ];
        for (const [label, active, action] of options) {
            const button = controls.createEl("button", {
                cls: active ? "is-active" : "",
                attr: { type: "button", "aria-pressed": String(active) },
            });
            const icon = button.createSpan();
            setIcon(icon, active ? "pin" : "pin-off");
            button.createSpan({ text: label });
            button.addEventListener("click", action);
        }
    }

    private renderMediaControls(parent: HTMLElement, target: MediaTarget): void {
        this.renderMediaPicker(parent, target, true);
        this.renderMediaAttachmentList(parent, target);
    }

    private renderMediaPicker(parent: HTMLElement, target: MediaTarget, iconOnly: boolean): void {
        const controls = parent.createDiv("sr-native-media-controls");
        const picker = controls.createEl("button", {
            cls: iconOnly
                ? "sr-native-media-button sr-native-media-button-icon"
                : "sr-native-media-button",
            attr: {
                type: "button",
                "aria-label": t("ADD_MEDIA"),
                title: t("ADD_MEDIA"),
            },
        });
        const icon = picker.createSpan();
        icon.setAttribute("aria-hidden", "true");
        setIcon(icon, "paperclip");
        if (!iconOnly) picker.createSpan({ text: t("ADD_MEDIA") });

        const createInput = (
            accept: string,
            capture?: "environment" | "user" | "microphone",
            multiple = false,
        ): HTMLInputElement => {
            const input = controls.createEl("input", {
                cls: "sr-native-media-input",
                attr: {
                    type: "file",
                    accept,
                    tabindex: "-1",
                    ...(multiple ? { multiple: "true" } : {}),
                    ...(capture ? { capture } : {}),
                },
            });
            input.addEventListener("change", () => {
                this.queueMediaFiles(input.files, target);
                input.value = "";
            });
            return input;
        };
        const fileInput = createInput("image/*,audio/*,video/*", undefined, true);
        const photoInput = createInput("image/*", "environment");
        const audioInput = createInput("audio/*", "microphone");

        picker.addEventListener("click", (event) => {
            const menu = new Menu();
            menu.addItem((item) =>
                item
                    .setTitle(t("IMPORT_MEDIA"))
                    .setIcon("folder-open")
                    .onClick(() => fileInput.click()),
            );
            menu.addItem((item) =>
                item
                    .setTitle(t("TAKE_PHOTO"))
                    .setIcon("camera")
                    .onClick(() => photoInput.click()),
            );
            menu.addItem((item) =>
                item
                    .setTitle(t("RECORD_AUDIO"))
                    .setIcon("mic")
                    .onClick(() => audioInput.click()),
            );
            menu.showAtMouseEvent(event);
        });
    }

    private queueMediaFiles(files: FileList | null, target: MediaTarget): void {
        for (const file of Array.from(files ?? [])) {
            this.pendingMedia.push({
                id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                file,
                target,
                objectUrl: URL.createObjectURL(file),
            });
        }
        this.clearError();
        this.render();
    }

    private renderMediaAttachmentList(parent: HTMLElement, target: MediaTarget): void {
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
                        width: "44",
                        height: "44",
                        loading: "lazy",
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
                    attr: {
                        src: attachment.objectUrl,
                        alt: attachment.file.name,
                        width: "44",
                        height: "44",
                    },
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

    private rememberOcclusionState(): void {
        this.occlusionUndoStack.push(cloneOcclusionMasks(this.occlusionMasks));
        if (this.occlusionUndoStack.length > 60) this.occlusionUndoStack.shift();
        this.occlusionRedoStack = [];
    }

    private undoOcclusion(): void {
        const previous = this.occlusionUndoStack.pop();
        if (!previous) return;
        this.occlusionRedoStack.push(cloneOcclusionMasks(this.occlusionMasks));
        this.occlusionMasks = previous;
        this.syncOcclusionSelection();
        this.render();
    }

    private redoOcclusion(): void {
        const next = this.occlusionRedoStack.pop();
        if (!next) return;
        this.occlusionUndoStack.push(cloneOcclusionMasks(this.occlusionMasks));
        this.occlusionMasks = next;
        this.syncOcclusionSelection();
        this.render();
    }

    private syncOcclusionSelection(): void {
        const ids = new Set(this.occlusionMasks.map((mask) => mask.id));
        this.selectedOcclusionMaskIds = new Set(
            [...this.selectedOcclusionMaskIds].filter((id) => ids.has(id)),
        );
        if (this.selectedOcclusionMaskId && !ids.has(this.selectedOcclusionMaskId)) {
            this.selectedOcclusionMaskId = null;
        }
        if (!this.selectedOcclusionMaskId) {
            const [fallbackSelectedId] = [...this.selectedOcclusionMaskIds];
            this.selectedOcclusionMaskId = fallbackSelectedId ?? null;
        }
    }

    private selectedOcclusionMasks(): OcclusionMask[] {
        const selected = this.selectedOcclusionMaskIds.size
            ? this.selectedOcclusionMaskIds
            : new Set(this.selectedOcclusionMaskId ? [this.selectedOcclusionMaskId] : []);
        return this.occlusionMasks.filter((mask) => selected.has(mask.id));
    }

    private removeSelectedOcclusionMasks(): void {
        const selected = new Set(this.selectedOcclusionMasks().map((mask) => mask.id));
        if (!selected.size) return;
        this.rememberOcclusionState();
        this.occlusionMasks = this.occlusionMasks.filter((mask) => !selected.has(mask.id));
        this.selectedOcclusionMaskIds.clear();
        this.selectedOcclusionMaskId = null;
        this.render();
    }

    private duplicateSelectedOcclusionMasks(): void {
        const selected = this.selectedOcclusionMasks();
        if (!selected.length) return;
        this.rememberOcclusionState();
        const copies = selected.map((mask) => {
            const copy = cloneOcclusionMasks([mask])[0];
            copy.id = `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            copy.groupId = null;
            copy.x = Math.min(1 - copy.width, copy.x + 0.025);
            copy.y = Math.min(1 - copy.height, copy.y + 0.025);
            copy.points = copy.points?.map((point) => ({
                x: Math.min(1, point.x + 0.025),
                y: Math.min(1, point.y + 0.025),
            }));
            return copy;
        });
        this.occlusionMasks.push(...copies);
        this.selectedOcclusionMaskIds = new Set(copies.map((mask) => mask.id));
        this.selectedOcclusionMaskId = copies[0]?.id ?? null;
        this.render();
    }

    private groupSelectedOcclusionMasks(): void {
        const selected = this.selectedOcclusionMasks();
        if (selected.length < 2) return;
        this.rememberOcclusionState();
        const currentGroup = selected[0].groupId;
        const sameGroup =
            Boolean(currentGroup) && selected.every((mask) => mask.groupId === currentGroup);
        const groupId = sameGroup
            ? null
            : `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        for (const mask of selected) mask.groupId = groupId;
        this.render();
    }

    private finishOcclusionPolygon(): void {
        if (this.occlusionPolygonDraft.length < 3) return;
        this.rememberOcclusionState();
        const xs = this.occlusionPolygonDraft.map((point) => point.x);
        const ys = this.occlusionPolygonDraft.map((point) => point.y);
        const mask: OcclusionMask = {
            id: `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            shape: "polygon",
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
            points: [...this.occlusionPolygonDraft],
            label: "",
            acceptedLabels: [],
            concepts: [],
            groupId: null,
        };
        this.occlusionMasks.push(mask);
        this.occlusionPolygonDraft = [];
        this.selectedOcclusionMaskId = mask.id;
        this.selectedOcclusionMaskIds = new Set([mask.id]);
        this.render();
    }

    private resetOcclusionEditor(): void {
        this.occlusionSource = null;
        this.occlusionSourcePath = null;
        this.occlusionMasks = [];
        this.activeOcclusionMask = null;
        this.selectedOcclusionMaskId = null;
        this.selectedOcclusionMaskIds.clear();
        this.occlusionUndoStack = [];
        this.occlusionRedoStack = [];
        this.occlusionPolygonDraft = [];
        this.occlusionZoom = 1;
        this.occlusionHeader = "";
        this.occlusionExtra = "";
        this.occlusionComments = "";
        this.occlusionReference = "";
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
                attr: {
                    type: "file",
                    accept: "image/*",
                    tabindex: "-1",
                    multiple: "true",
                },
            });
            choose.addEventListener("click", () => input.click());
            input.addEventListener("change", () => {
                const files = Array.from(input.files ?? []);
                const file = files[0];
                if (!file) return;
                this.occlusionBatchFiles = files.slice(1);
                this.occlusionBatchTotal = files.length;
                void this.setOcclusionSource(file);
            });
        } else {
            const overview = surface.createDiv("sr-native-occlusion-overview");
            const modePicker = overview.createDiv("sr-native-card-type-switcher");
            for (const [mode, label] of [
                ["hide-one", t("OCCLUSION_HIDE_ONE")],
                ["hide-all", t("OCCLUSION_HIDE_ALL")],
            ] as const) {
                const button = new ButtonComponent(modePicker).setButtonText(label);
                button.buttonEl.toggleClass("is-active", this.occlusionMode === mode);
                button.buttonEl.setAttribute("aria-pressed", String(this.occlusionMode === mode));
                button.onClick(() => {
                    this.occlusionMode = mode;
                    this.render();
                });
            }
            const summary = overview.createDiv("sr-native-occlusion-summary");
            summary.createEl("strong", {
                text: String(getOcclusionCardGroups(this.occlusionMasks).length),
            });
            summary.createSpan({ text: t("OCCLUSION_CARDS_SHORT") });
            if (this.occlusionBatchTotal > 1) {
                overview.createDiv({
                    cls: "sr-native-occlusion-batch",
                    text: this.creatorText(
                        `Image ${this.occlusionBatchTotal - this.occlusionBatchFiles.length} of ${this.occlusionBatchTotal}`,
                        `Изображение ${this.occlusionBatchTotal - this.occlusionBatchFiles.length} из ${this.occlusionBatchTotal}`,
                    ),
                });
            }

            const toolbar = surface.createDiv("sr-native-occlusion-toolbar");
            const drawingTools = toolbar.createDiv("sr-native-occlusion-tool-picker");
            for (const [tool, icon, label] of [
                ["rectangle", "square", t("OCCLUSION_RECTANGLE")],
                ["ellipse", "circle", t("OCCLUSION_ELLIPSE")],
                ["polygon", "spline", t("OCCLUSION_POLYGON")],
                ["pan", "hand", t("OCCLUSION_PAN")],
            ] as const) {
                const button = new ButtonComponent(drawingTools)
                    .setIcon(icon)
                    .setTooltip(label)
                    .onClick(() => {
                        this.occlusionTool = tool;
                        this.occlusionPolygonDraft = [];
                        this.render();
                    });
                button.buttonEl.addClass("sr-native-icon-button");
                button.buttonEl.toggleClass("is-active", this.occlusionTool === tool);
                button.buttonEl.setAttribute("aria-pressed", String(this.occlusionTool === tool));
            }
            if (this.occlusionTool === "polygon" && this.occlusionPolygonDraft.length > 0) {
                new ButtonComponent(drawingTools)
                    .setIcon("check")
                    .setTooltip(t("OCCLUSION_FINISH_POLYGON"))
                    .setDisabled(this.occlusionPolygonDraft.length < 3)
                    .onClick(() => this.finishOcclusionPolygon())
                    .buttonEl.addClass("sr-native-icon-button", "is-confirm");
            }

            const historyTools = toolbar.createDiv("sr-native-occlusion-tools");
            for (const [icon, label, disabled, action] of [
                [
                    "undo-2",
                    t("UNDO"),
                    this.occlusionUndoStack.length === 0,
                    () => this.undoOcclusion(),
                ],
                [
                    "redo-2",
                    t("REDO"),
                    this.occlusionRedoStack.length === 0,
                    () => this.redoOcclusion(),
                ],
            ] as const) {
                const button = new ButtonComponent(historyTools)
                    .setIcon(icon)
                    .setTooltip(label)
                    .setDisabled(disabled)
                    .onClick(action);
                button.buttonEl.addClass("sr-native-icon-button");
            }
            const replace = new ButtonComponent(historyTools)
                .setIcon("image-plus")
                .setTooltip(t("CHOOSE_ANOTHER_IMAGE"))
                .onClick(() => replacementInput.click());
            replace.buttonEl.addClass("sr-native-icon-button");
            const replacementInput = historyTools.createEl("input", {
                cls: "sr-native-media-input",
                attr: { type: "file", accept: "image/*", tabindex: "-1" },
            });
            replacementInput.addEventListener("change", () => {
                const file = replacementInput.files?.[0];
                if (file) void this.setOcclusionSource(file);
            });

            const stageShell = surface.createDiv("sr-native-occlusion-stage-shell");
            const stage = stageShell.createDiv("sr-native-occlusion-stage");
            const canvas = stage.createEl("canvas", {
                cls: "sr-native-occlusion-canvas",
                attr: { "aria-label": t("IMAGE_OCCLUSION_EDITOR") },
            });
            canvas.setCssProps({ width: `${Math.round(this.occlusionZoom * 100)}%` });
            this.initializeOcclusionCanvas(canvas, stage);
            const zoom = stageShell.createDiv("sr-native-occlusion-zoom");
            new ButtonComponent(zoom)
                .setIcon("minus")
                .setTooltip(t("ZOOM_OUT"))
                .setDisabled(this.occlusionZoom <= 0.75)
                .onClick(() => {
                    this.occlusionZoom = Math.max(0.75, this.occlusionZoom - 0.25);
                    this.render();
                })
                .buttonEl.addClass("sr-native-icon-button");
            zoom.createSpan({ text: `${Math.round(this.occlusionZoom * 100)}%` });
            new ButtonComponent(zoom)
                .setIcon("plus")
                .setTooltip(t("ZOOM_IN"))
                .setDisabled(this.occlusionZoom >= 3)
                .onClick(() => {
                    this.occlusionZoom = Math.min(3, this.occlusionZoom + 0.25);
                    this.render();
                })
                .buttonEl.addClass("sr-native-icon-button");

            if (this.selectedOcclusionMasks().length > 0) {
                const selection = surface.createDiv("sr-native-occlusion-selection-bar");
                selection.createSpan({
                    text: t("OCCLUSION_SELECTED_COUNT", {
                        count: this.selectedOcclusionMasks().length,
                    }),
                });
                const selectionActions = selection.createDiv();
                for (const [icon, label, action, disabled] of [
                    ["copy", t("DUPLICATE"), () => this.duplicateSelectedOcclusionMasks(), false],
                    [
                        "group",
                        t("OCCLUSION_GROUP_TOGGLE"),
                        () => this.groupSelectedOcclusionMasks(),
                        this.selectedOcclusionMasks().length < 2,
                    ],
                    ["trash-2", t("DELETE"), () => this.removeSelectedOcclusionMasks(), false],
                ] as const) {
                    const button = new ButtonComponent(selectionActions)
                        .setIcon(icon)
                        .setTooltip(label)
                        .setDisabled(disabled)
                        .onClick(action);
                    button.buttonEl.addClass("sr-native-icon-button");
                }
            }

            const maskList = surface.createDiv("sr-native-occlusion-mask-list");
            this.occlusionMasks.forEach((mask, index) => {
                const selected = this.selectedOcclusionMaskIds.has(mask.id);
                const active = mask.id === this.selectedOcclusionMaskId;
                const row = maskList.createDiv("sr-native-occlusion-mask-row");
                row.toggleClass("is-selected", selected || active);
                const rowTop = row.createDiv("sr-native-occlusion-mask-row-top");
                const select = rowTop.createEl("button", {
                    cls: "sr-native-occlusion-mask-select",
                    attr: { type: "button", "aria-label": t("SELECT_OCCLUSION_MASK") },
                });
                setIcon(
                    select,
                    selected
                        ? "check"
                        : mask.shape === "ellipse"
                          ? "circle"
                          : mask.shape === "polygon"
                            ? "spline"
                            : "square",
                );
                select.addEventListener("click", () => {
                    if (selected) this.selectedOcclusionMaskIds.delete(mask.id);
                    else this.selectedOcclusionMaskIds.add(mask.id);
                    this.selectedOcclusionMaskId = mask.id;
                    this.render();
                });
                const title = rowTop.createEl("button", {
                    cls: "sr-native-occlusion-mask-title",
                    attr: { type: "button" },
                });
                title.createEl("strong", {
                    text: mask.label || `${t("OCCLUSION_REGION")} ${index + 1}`,
                });
                title.createSpan({
                    text: [
                        mask.shape === "ellipse"
                            ? t("OCCLUSION_ELLIPSE")
                            : mask.shape === "polygon"
                              ? t("OCCLUSION_POLYGON")
                              : t("OCCLUSION_RECTANGLE"),
                        mask.groupId ? t("OCCLUSION_GROUPED") : "",
                    ]
                        .filter(Boolean)
                        .join(" · "),
                });
                title.addEventListener("click", () => {
                    this.selectedOcclusionMaskId = active ? null : mask.id;
                    this.selectedOcclusionMaskIds = new Set([mask.id]);
                    this.render();
                });
                const remove = new ButtonComponent(rowTop)
                    .setIcon("trash-2")
                    .setTooltip(t("REMOVE_OCCLUSION_MASK"))
                    .onClick(() => {
                        this.selectedOcclusionMaskIds = new Set([mask.id]);
                        this.selectedOcclusionMaskId = mask.id;
                        this.removeSelectedOcclusionMasks();
                    });
                remove.buttonEl.addClass("sr-native-icon-button");

                if (active) {
                    const fields = row.createDiv("sr-native-occlusion-mask-fields");
                    const label = this.createOcclusionTextInput(
                        fields,
                        t("OCCLUSION_LABEL"),
                        mask.label,
                        t("OCCLUSION_LABEL_PLACEHOLDER"),
                        (value) => (mask.label = value),
                    );
                    label.addClass("is-primary");
                    this.createOcclusionTextInput(
                        fields,
                        t("OCCLUSION_ALTERNATIVES"),
                        (mask.acceptedLabels ?? []).join("; "),
                        t("OCCLUSION_ALTERNATIVES_PLACEHOLDER"),
                        (value) =>
                            (mask.acceptedLabels = value
                                .split(/[;\n]/)
                                .map((item) => item.trim())
                                .filter(Boolean)),
                    );
                    this.createOcclusionTextInput(
                        fields,
                        t("OCCLUSION_CONCEPTS"),
                        (mask.concepts ?? []).join(", "),
                        t("OCCLUSION_CONCEPTS_PLACEHOLDER"),
                        (value) =>
                            (mask.concepts = value
                                .split(/[,\n]/)
                                .map((item) => item.trim())
                                .filter(Boolean)),
                    );
                }
            });

            if (this.canUseOcclusionOcr()) {
                const ocr = surface.createEl("button", {
                    cls: "sr-native-occlusion-ocr",
                    attr: { type: "button" },
                });
                const icon = ocr.createSpan();
                setIcon(icon, "scan-text");
                ocr.createSpan({ text: t("OCCLUSION_OCR_SUGGEST") });
                ocr.addEventListener("click", () => void this.suggestOcclusionLabels());
            }

            const metadata = surface.createEl("details", {
                cls: "sr-native-occlusion-metadata",
            });
            if (
                this.occlusionHeader ||
                this.occlusionExtra ||
                this.occlusionComments ||
                this.occlusionReference
            ) {
                metadata.open = true;
            }
            metadata.createEl("summary", { text: t("OCCLUSION_CARD_CONTEXT") });
            const metadataFields = metadata.createDiv();
            for (const [label, value, placeholder, update] of [
                [
                    t("OCCLUSION_HEADER"),
                    this.occlusionHeader,
                    t("OCCLUSION_HEADER_PLACEHOLDER"),
                    (next: string) => (this.occlusionHeader = next),
                ],
                [
                    t("OCCLUSION_EXTRA"),
                    this.occlusionExtra,
                    t("OCCLUSION_EXTRA_PLACEHOLDER"),
                    (next: string) => (this.occlusionExtra = next),
                ],
                [
                    t("OCCLUSION_COMMENTS"),
                    this.occlusionComments,
                    t("OCCLUSION_COMMENTS_PLACEHOLDER"),
                    (next: string) => (this.occlusionComments = next),
                ],
                [
                    t("OCCLUSION_REFERENCE"),
                    this.occlusionReference,
                    t("OCCLUSION_REFERENCE_PLACEHOLDER"),
                    (next: string) => (this.occlusionReference = next),
                ],
            ] as const) {
                this.createOcclusionTextInput(
                    metadataFields,
                    label,
                    value,
                    placeholder,
                    update,
                    true,
                );
            }
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
                this.occlusionBatchFiles = [];
                this.occlusionBatchTotal = 0;
                this.resetOcclusionEditor();
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

    private createOcclusionTextInput(
        parent: HTMLElement,
        label: string,
        value: string,
        placeholder: string,
        update: (value: string) => void,
        multiline = false,
    ): HTMLElement {
        const field = parent.createEl("label", { cls: "sr-native-occlusion-inline-field" });
        field.createSpan({ text: label });
        const input = multiline
            ? field.createEl("textarea", {
                  cls: "sr-native-input",
                  attr: { rows: "2", placeholder },
              })
            : field.createEl("input", {
                  cls: "sr-native-input",
                  attr: { type: "text", placeholder },
              });
        input.value = value;
        input.addEventListener("input", () => update(input.value));
        return field;
    }

    private getOcclusionTextDetector():
        | (new () => {
              detect(
                  source: ImageBitmapSource,
              ): Promise<Array<{ rawValue: string; boundingBox: DOMRectReadOnly }>>;
          })
        | undefined {
        return (
            globalThis as typeof globalThis & {
                TextDetector?: new () => {
                    detect(
                        source: ImageBitmapSource,
                    ): Promise<Array<{ rawValue: string; boundingBox: DOMRectReadOnly }>>;
                };
            }
        ).TextDetector;
    }

    private canUseOcclusionOcr(): boolean {
        return Boolean(this.getOcclusionTextDetector() && globalThis.createImageBitmap);
    }

    private async suggestOcclusionLabels(): Promise<void> {
        const source = this.occlusionSource;
        const Detector = this.getOcclusionTextDetector();
        if (!source || !Detector || !globalThis.createImageBitmap) return;
        try {
            const bitmap = await createImageBitmap(source.file);
            const detections = await new Detector().detect(bitmap);
            bitmap.close();
            const targets = this.selectedOcclusionMasks().length
                ? this.selectedOcclusionMasks()
                : this.occlusionMasks;
            this.rememberOcclusionState();
            let updated = 0;
            for (const mask of targets) {
                const matches = detections
                    .filter((detection) => {
                        const center = {
                            x:
                                (detection.boundingBox.x + detection.boundingBox.width / 2) /
                                source.width,
                            y:
                                (detection.boundingBox.y + detection.boundingBox.height / 2) /
                                source.height,
                        };
                        return pointInOcclusionMask(mask, center);
                    })
                    .map((detection) => detection.rawValue.trim())
                    .filter(Boolean);
                if (!matches.length) continue;
                if (!mask.label) mask.label = matches[0];
                mask.acceptedLabels = [...new Set([...(mask.acceptedLabels ?? []), ...matches])];
                updated++;
            }
            if (!updated) this.occlusionUndoStack.pop();
            new Notice(
                updated ? t("OCCLUSION_OCR_UPDATED", { count: updated }) : t("OCCLUSION_OCR_EMPTY"),
            );
            this.render();
        } catch (error) {
            console.warn("Spaced Repetition: OCR suggestions unavailable", error);
            this.error = t("OCCLUSION_OCR_FAILED");
            this.render();
        }
    }

    private async setOcclusionSource(file: File): Promise<void> {
        try {
            this.occlusionSource = await loadOcclusionImage(file);
            this.occlusionSourcePath = null;
            this.occlusionMasks = [];
            this.selectedOcclusionMaskId = null;
            this.selectedOcclusionMaskIds.clear();
            this.occlusionUndoStack = [];
            this.occlusionRedoStack = [];
            this.occlusionPolygonDraft = [];
            this.occlusionZoom = 1;
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
            this.occlusionMasks = parsed.map(normalizeOcclusionMask);
            this.occlusionMode =
                note.fields[OCCLUSION_MODE_FIELD_ID] === "hide-one" ? "hide-one" : "hide-all";
            this.selectedOcclusionMaskId = this.occlusionMasks[0]?.id ?? null;
            this.selectedOcclusionMaskIds = new Set(
                this.selectedOcclusionMaskId ? [this.selectedOcclusionMaskId] : [],
            );
            this.occlusionUndoStack = [];
            this.occlusionRedoStack = [];
            this.occlusionPolygonDraft = [];
            this.occlusionZoom = 1;
            this.occlusionHeader = note.fields[OCCLUSION_HEADER_FIELD_ID] ?? "";
            this.occlusionExtra = note.fields[OCCLUSION_EXTRA_FIELD_ID] ?? "";
            this.occlusionComments = note.fields[OCCLUSION_COMMENTS_FIELD_ID] ?? "";
            this.occlusionReference = note.fields[OCCLUSION_REFERENCE_FIELD_ID] ?? "";
            this.error = "";
        } catch (error) {
            console.error("Spaced Repetition: image occlusion edit load failed", error);
            this.error = t("OCCLUSION_IMAGE_FAILED");
        }
        if (this.contentEl.isShown()) this.render();
    }

    private initializeOcclusionCanvas(canvas: HTMLCanvasElement, stage: HTMLElement): void {
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
            const masks =
                this.activeOcclusionMask &&
                !this.occlusionMasks.some((mask) => mask.id === this.activeOcclusionMask?.id)
                    ? [...this.occlusionMasks, this.activeOcclusionMask]
                    : this.occlusionMasks;
            for (const mask of masks) {
                const selected =
                    mask.id === this.selectedOcclusionMaskId ||
                    this.selectedOcclusionMaskIds.has(mask.id);
                context.fillStyle = selected ? "rgba(124, 58, 237, 0.78)" : "rgba(28, 28, 30, 0.9)";
                context.strokeStyle = selected ? "#a78bfa" : "rgba(255, 255, 255, 0.95)";
                context.lineWidth = Math.max(2, canvas.width * 0.003);
                context.beginPath();
                if (mask.shape === "ellipse") {
                    context.ellipse(
                        (mask.x + mask.width / 2) * canvas.width,
                        (mask.y + mask.height / 2) * canvas.height,
                        (mask.width * canvas.width) / 2,
                        (mask.height * canvas.height) / 2,
                        0,
                        0,
                        Math.PI * 2,
                    );
                } else if (mask.shape === "polygon" && (mask.points?.length ?? 0) >= 3) {
                    const points = mask.points ?? [];
                    context.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
                    for (const point of points.slice(1)) {
                        context.lineTo(point.x * canvas.width, point.y * canvas.height);
                    }
                    context.closePath();
                } else {
                    context.rect(
                        mask.x * canvas.width,
                        mask.y * canvas.height,
                        mask.width * canvas.width,
                        mask.height * canvas.height,
                    );
                }
                context.fill();
                context.stroke();
                if (selected && mask.shape !== "polygon") {
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
            if (this.occlusionPolygonDraft.length) {
                context.save();
                context.strokeStyle = "#a78bfa";
                context.fillStyle = "#ffffff";
                context.lineWidth = Math.max(2, canvas.width * 0.003);
                context.beginPath();
                const first = this.occlusionPolygonDraft[0];
                context.moveTo(first.x * canvas.width, first.y * canvas.height);
                for (const point of this.occlusionPolygonDraft.slice(1)) {
                    context.lineTo(point.x * canvas.width, point.y * canvas.height);
                }
                context.stroke();
                for (const point of this.occlusionPolygonDraft) {
                    context.beginPath();
                    context.arc(
                        point.x * canvas.width,
                        point.y * canvas.height,
                        Math.max(4, canvas.width * 0.006),
                        0,
                        Math.PI * 2,
                    );
                    context.fill();
                }
                context.restore();
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
        let panStart: { x: number; y: number; left: number; top: number } | null = null;
        const hitMask = (position: { x: number; y: number }): OcclusionMask | null =>
            [...this.occlusionMasks]
                .reverse()
                .find((mask) => pointInOcclusionMask(mask, position)) ?? null;
        canvas.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            canvas.setPointerCapture(event.pointerId);
            if (this.occlusionTool === "pan") {
                panStart = {
                    x: event.clientX,
                    y: event.clientY,
                    left: stage.scrollLeft,
                    top: stage.scrollTop,
                };
                canvas.addClass("is-panning");
                return;
            }
            start = point(event);
            if (this.occlusionTool === "polygon") {
                this.occlusionPolygonDraft.push(start);
                redraw();
                return;
            }
            const hit = hitMask(start);
            if (hit) {
                this.selectedOcclusionMaskId = hit.id;
                this.selectedOcclusionMaskIds = new Set([hit.id]);
                origin = { ...hit };
                const nearHandle =
                    hit.shape !== "polygon" &&
                    Math.abs(start.x - (hit.x + hit.width)) < 0.035 &&
                    Math.abs(start.y - (hit.y + hit.height)) < 0.035;
                interaction = nearHandle ? "resize" : "move";
                this.activeOcclusionMask = hit;
                this.rememberOcclusionState();
            } else {
                interaction = "create";
                origin = null;
                this.activeOcclusionMask = {
                    id: `mask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    shape: this.occlusionTool,
                    x: start.x,
                    y: start.y,
                    width: 0,
                    height: 0,
                    points: [],
                    label: "",
                    acceptedLabels: [],
                    concepts: [],
                    groupId: null,
                };
                this.selectedOcclusionMaskId = this.activeOcclusionMask.id;
                this.selectedOcclusionMaskIds = new Set([this.activeOcclusionMask.id]);
                this.rememberOcclusionState();
            }
            redraw();
        });
        canvas.addEventListener("pointermove", (event) => {
            if (panStart) {
                event.preventDefault();
                stage.scrollLeft = panStart.left - (event.clientX - panStart.x);
                stage.scrollTop = panStart.top - (event.clientY - panStart.y);
                return;
            }
            if (this.occlusionTool === "polygon") return;
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
                if (this.activeOcclusionMask.shape === "polygon") {
                    const deltaX = this.activeOcclusionMask.x - origin.x;
                    const deltaY = this.activeOcclusionMask.y - origin.y;
                    this.activeOcclusionMask.points = (origin.points ?? []).map((point) => ({
                        x: Math.max(0, Math.min(1, point.x + deltaX)),
                        y: Math.max(0, Math.min(1, point.y + deltaY)),
                    }));
                }
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
            if (panStart) {
                event.preventDefault();
                panStart = null;
                canvas.removeClass("is-panning");
                return;
            }
            if (this.occlusionTool === "polygon") return;
            if (!start || !this.activeOcclusionMask) return;
            event.preventDefault();
            if (
                interaction === "create" &&
                this.activeOcclusionMask.width >= 0.012 &&
                this.activeOcclusionMask.height >= 0.012
            ) {
                this.occlusionMasks.push(this.activeOcclusionMask);
            } else if (interaction === "create") {
                this.occlusionUndoStack.pop();
            }
            this.activeOcclusionMask = null;
            start = null;
            this.render();
        };
        canvas.addEventListener("pointerup", finish);
        canvas.addEventListener("pointercancel", finish);
        canvas.addEventListener("dblclick", (event) => {
            if (this.occlusionTool !== "polygon") return;
            event.preventDefault();
            this.finishOcclusionPolygon();
        });
        stage.addEventListener(
            "wheel",
            (event) => {
                event.preventDefault();
                const delta = event.deltaY < 0 ? 0.25 : -0.25;
                this.occlusionZoom = Math.max(0.75, Math.min(3, this.occlusionZoom + delta));
                canvas.setCssProps({ width: `${Math.round(this.occlusionZoom * 100)}%` });
            },
            { passive: false },
        );
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
            const groups = new Map(
                getOcclusionCardGroups(this.occlusionMasks).map((group) => [group.id, group]),
            );
            const stem = source.file.name.replace(/\.[^.]+$/, "") || "occlusion";
            const storedAssets = [];
            for (const [index, asset] of assets.entries()) {
                const group = groups.get(asset.maskId);
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
                    maskIds: asset.maskIds,
                    questionPath,
                    answerPath,
                    label: group?.masks[0]?.label ?? "",
                    acceptedLabels: group?.masks[0]?.acceptedLabels ?? [],
                    answers:
                        group?.masks.map((mask, answerIndex) => ({
                            id: mask.id,
                            label: mask.label,
                            acceptedLabels: mask.acceptedLabels ?? [],
                            concepts: mask.concepts?.length
                                ? mask.concepts
                                : [`${t("OCCLUSION_REGION")} ${answerIndex + 1}`],
                        })) ?? [],
                });
            }
            const draft = {
                deckPath: this.selectedDeck,
                sourcePath,
                masksJson: JSON.stringify(this.occlusionMasks),
                mode: this.occlusionMode,
                assets: storedAssets,
                header: this.occlusionHeader,
                extra: this.occlusionExtra,
                comments: this.occlusionComments,
                reference: this.occlusionReference,
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
            const nextBatchFile = this.editingOcclusionNote
                ? undefined
                : this.occlusionBatchFiles.shift();
            this.resetOcclusionEditor();
            if (nextBatchFile) {
                this.busy = false;
                await this.setOcclusionSource(nextBatchFile);
                return;
            }
            this.occlusionBatchFiles = [];
            this.occlusionBatchTotal = 0;
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

    private transferText(english: string, russian: string): string {
        return (activeDocument.documentElement.lang || navigator.language)
            .toLocaleLowerCase()
            .startsWith("ru")
            ? russian
            : english;
    }

    private renderTransferManager(surface: HTMLElement): void {
        surface.addClass("sr-transfer-manager");
        const actions = surface.createDiv("sr-transfer-actions");
        const importInput = actions.createEl("input");
        importInput.type = "file";
        importInput.accept = ".apkg,.colpkg,.csv,.tsv,text/csv,text/tab-separated-values";
        importInput.addClass("sr-transfer-file-input");
        importInput.addEventListener("change", () => {
            const file = importInput.files?.[0];
            if (file) void this.loadTransferFile(file);
        });
        const importButton = new ButtonComponent(actions)
            .setButtonText(this.transferText("Choose a file", "Выбрать файл"))
            .setIcon("folder-input")
            .onClick(() => importInput.click());
        importButton.buttonEl.addClass("mod-cta");
        new ButtonComponent(actions)
            .setButtonText(this.transferText("Export to Anki", "Экспорт в Anki"))
            .setIcon("archive-restore")
            .setDisabled(this.busy)
            .onClick(() => void this.exportTransferPackage());
        new ButtonComponent(actions)
            .setButtonText("CSV")
            .setIcon("sheet")
            .setDisabled(this.busy)
            .onClick(() => void this.exportTransferCsv());

        const promise = surface.createDiv("sr-transfer-promise");
        const promiseIcon = promise.createDiv("sr-transfer-promise-icon");
        setIcon(promiseIcon, "shield-check");
        const promiseCopy = promise.createDiv();
        promiseCopy.createEl("strong", {
            text: this.transferText(
                "Preview first, change second",
                "Сначала просмотр, затем изменения",
            ),
        });
        promiseCopy.createEl("span", {
            text: this.transferText(
                "An automatic snapshot is created before import. Markdown remains the source of truth.",
                "Перед импортом создаётся снимок. Markdown остаётся источником данных.",
            ),
        });

        if (this.error) surface.createDiv({ cls: "sr-native-error", text: this.error });
        if (this.transferProgress) {
            const progress = surface.createDiv("sr-transfer-progress");
            const spinner = progress.createDiv("sr-transfer-spinner");
            setIcon(spinner, "loader-circle");
            progress.createSpan({ text: this.transferProgress });
        }
        if (this.transferReport) this.renderTransferReport(surface, this.transferReport);
        if (this.transferPackage) this.renderAnkiPreview(surface, this.transferPackage);
        else if (this.transferCsvRows.length > 0) this.renderCsvPreview(surface);
        else {
            const empty = surface.createDiv("sr-transfer-empty");
            const icon = empty.createDiv();
            setIcon(icon, "package-open");
            empty.createEl("h2", {
                text: this.transferText(
                    "Anki and tables, one doorway",
                    "Anki и таблицы — в одном месте",
                ),
            });
            empty.createEl("p", {
                text: this.transferText(
                    "Import APKG with decks, templates, media and review history, or map CSV/TSV columns before creating notes.",
                    "Импортируйте APKG с колодами, шаблонами, медиа и историей либо сопоставьте столбцы CSV/TSV перед созданием заметок.",
                ),
            });
        }
    }

    private async loadTransferFile(file: File): Promise<void> {
        this.error = "";
        this.transferReport = null;
        this.transferFileName = file.name;
        this.transferProgress = this.transferText("Reading file…", "Читаю файл…");
        this.render();
        try {
            if (/\.(apkg|colpkg)$/i.test(file.name)) {
                this.transferPackage = await parseAnkiPackage(await file.arrayBuffer());
                this.transferSelectedDeckIds = new Set(
                    this.transferPackage.decks.map((deck) => deck.id),
                );
                this.transferCsvRows = [];
            } else {
                this.transferCsvDelimiter = /\.tsv$/i.test(file.name) ? "\t" : ",";
                this.transferCsvRows = parseDelimited(await file.text(), this.transferCsvDelimiter);
                if (this.transferCsvRows.length === 0) throw new Error("empty-table");
                this.transferPackage = null;
                this.initializeCsvMapping();
            }
        } catch (error) {
            this.error = this.transferText(
                `Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
                `Не удалось прочитать ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.transferPackage = null;
            this.transferCsvRows = [];
        } finally {
            this.transferProgress = "";
            this.render();
        }
    }

    private renderAnkiPreview(surface: HTMLElement, pkg: AnkiPackage): void {
        const service = new AnkiTransferService(this.plugin);
        const panel = surface.createDiv("sr-transfer-preview");
        const header = panel.createDiv("sr-transfer-preview-header");
        const headerCopy = header.createDiv();
        headerCopy.createEl("h2", { text: this.transferFileName });
        headerCopy.createEl("p", {
            text: this.transferText(
                `${pkg.notes.length} notes · ${pkg.decks.length} decks · ${Object.keys(pkg.media).length} media`,
                `${pkg.notes.length} заметок · ${pkg.decks.length} колод · ${Object.keys(pkg.media).length} медиа`,
            ),
        });
        const badge = header.createDiv("sr-transfer-duplicate-badge");
        badge.createEl("strong", { text: String(service.countDuplicates(pkg)) });
        badge.createSpan({ text: this.transferText("already here", "уже есть") });

        const controls = panel.createDiv("sr-transfer-control-row");
        const policyLabel = controls.createEl("label");
        policyLabel.createSpan({
            text: this.transferText("When a note already exists", "Если заметка уже существует"),
        });
        const policy = policyLabel.createEl("select");
        for (const [value, en, ru] of [
            ["skip", "Keep existing", "Оставить существующую"],
            ["replace", "Update existing", "Обновить существующую"],
            ["copy", "Create a copy", "Создать копию"],
        ] as const) {
            const option = policy.createEl("option", { text: this.transferText(en, ru) });
            option.value = value;
            option.selected = this.transferDuplicatePolicy === value;
        }
        policy.addEventListener("change", () => {
            this.transferDuplicatePolicy = policy.value as DuplicatePolicy;
        });

        panel.createEl("h3", { text: this.transferText("Decks to import", "Колоды для импорта") });
        const decks = panel.createDiv("sr-transfer-deck-list");
        for (const deck of pkg.decks) {
            const row = decks.createEl("label", { cls: "sr-transfer-deck-row" });
            const checkbox = row.createEl("input");
            checkbox.type = "checkbox";
            checkbox.checked = this.transferSelectedDeckIds.has(deck.id);
            checkbox.addEventListener("change", () => {
                if (checkbox.checked) this.transferSelectedDeckIds.add(deck.id);
                else this.transferSelectedDeckIds.delete(deck.id);
            });
            const icon = row.createSpan("sr-transfer-deck-icon");
            setIcon(icon, "folder");
            const copy = row.createSpan("sr-transfer-deck-copy");
            copy.createEl("strong", { text: deck.name.replaceAll("::", " / ") });
            copy.createEl("small", {
                text: this.transferText(
                    `${pkg.notes.filter((note) => note.cards.some((card) => card.deckId === deck.id)).length} notes`,
                    `${pkg.notes.filter((note) => note.cards.some((card) => card.deckId === deck.id)).length} заметок`,
                ),
            });
        }
        for (const warning of pkg.warnings) {
            panel.createDiv({ cls: "sr-transfer-warning", text: warning });
        }
        const footer = panel.createDiv("sr-transfer-footer");
        new ButtonComponent(footer)
            .setButtonText(
                this.busy
                    ? this.transferText("Importing…", "Импорт…")
                    : this.transferText("Import selected", "Импортировать выбранное"),
            )
            .setIcon("download")
            .setDisabled(this.busy || this.transferSelectedDeckIds.size === 0)
            .onClick(() => void this.importTransferPackage());
    }

    private async importTransferPackage(): Promise<void> {
        if (!this.transferPackage || this.busy) return;
        this.busy = true;
        this.error = "";
        this.transferProgress = this.transferText("Preparing import…", "Подготавливаю импорт…");
        this.render();
        try {
            const service = new AnkiTransferService(this.plugin);
            this.transferReport = await service.importPackage(this.transferPackage, {
                deckIds: new Set(this.transferSelectedDeckIds),
                duplicatePolicy: this.transferDuplicatePolicy,
                onProgress: (completed, total) => {
                    this.transferProgress = this.transferText(
                        `Writing notes ${completed} of ${total}…`,
                        `Записываю заметки: ${completed} из ${total}…`,
                    );
                },
            });
            new Notice(this.transferText("Anki import finished", "Импорт Anki завершён"));
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            this.transferProgress = "";
            this.render();
        }
    }

    private renderTransferReport(surface: HTMLElement, report: AnkiImportReport): void {
        const panel = surface.createDiv("sr-transfer-report");
        const icon = panel.createDiv("sr-transfer-report-icon");
        setIcon(icon, report.errors.length ? "circle-alert" : "circle-check");
        const copy = panel.createDiv();
        copy.createEl("strong", {
            text: report.errors.length
                ? this.transferText("Imported with warnings", "Импортировано с предупреждениями")
                : this.transferText("Import complete", "Импорт завершён"),
        });
        copy.createEl("span", {
            text: this.transferText(
                `${report.created} created · ${report.updated} updated · ${report.skipped} skipped`,
                `Создано: ${report.created} · обновлено: ${report.updated} · пропущено: ${report.skipped}`,
            ),
        });
        if (report.errors.length) {
            const details = copy.createEl("details");
            details.createEl("summary", {
                text: this.transferText(
                    `${report.errors.length} issues`,
                    `${report.errors.length} ошибок`,
                ),
            });
            for (const error of report.errors.slice(0, 100)) {
                details.createEl("p", { text: `${error.identity}: ${error.message}` });
            }
        }
    }

    private initializeCsvMapping(): void {
        const noteTypes = Object.values(
            this.plugin.dataManager.collectionStore.getCollectionSnapshot().noteTypes,
        ).filter((type) => !type.deletedAt && type.kind !== "image-occlusion");
        if (!noteTypes.some((type) => type.id === this.transferCsvNoteTypeId)) {
            this.transferCsvNoteTypeId = noteTypes[0]?.id ?? BASIC_NOTE_TYPE_ID;
        }
        const type = noteTypes.find((candidate) => candidate.id === this.transferCsvNoteTypeId);
        const headers = this.transferCsvRows[0] ?? [];
        this.transferCsvMapping = Object.fromEntries(
            (type?.fields ?? []).map((field) => [
                field.id,
                headers.findIndex(
                    (header) =>
                        header
                            .replace(/^Field:/i, "")
                            .trim()
                            .localeCompare(field.name, undefined, { sensitivity: "base" }) === 0,
                ),
            ]),
        );
        this.transferCsvTagsColumn = headers.findIndex((header) => /^tags?$/i.test(header.trim()));
        const deckColumn = headers.findIndex((header) => /^deck$/i.test(header.trim()));
        if (deckColumn >= 0) this.transferCsvDeck = "";
    }

    private renderCsvPreview(surface: HTMLElement): void {
        const panel = surface.createDiv("sr-transfer-preview");
        panel.createEl("h2", { text: this.transferFileName });
        panel.createEl("p", {
            text: this.transferText(
                `${Math.max(0, this.transferCsvRows.length - 1)} rows. Match each note field before import.`,
                `${Math.max(0, this.transferCsvRows.length - 1)} строк. Сопоставьте поля перед импортом.`,
            ),
        });
        const noteTypes = Object.values(
            this.plugin.dataManager.collectionStore.getCollectionSnapshot().noteTypes,
        ).filter((type) => !type.deletedAt && type.kind !== "image-occlusion");
        const top = panel.createDiv("sr-transfer-control-row");
        const typeLabel = top.createEl("label");
        typeLabel.createSpan({ text: this.transferText("Note type", "Тип заметки") });
        const typeSelect = typeLabel.createEl("select");
        for (const type of noteTypes) {
            const option = typeSelect.createEl("option", { text: type.name });
            option.value = type.id;
            option.selected = type.id === this.transferCsvNoteTypeId;
        }
        typeSelect.addEventListener("change", () => {
            this.transferCsvNoteTypeId = typeSelect.value;
            this.initializeCsvMapping();
            this.render();
        });
        const deckLabel = top.createEl("label");
        deckLabel.createSpan({ text: this.transferText("Default deck", "Колода по умолчанию") });
        const deckInput = deckLabel.createEl("input");
        deckInput.value = this.transferCsvDeck;
        deckInput.placeholder = this.transferText("Inbox", "Входящие");
        deckInput.addEventListener("input", () => (this.transferCsvDeck = deckInput.value));
        const policyLabel = top.createEl("label");
        policyLabel.createSpan({
            text: this.transferText("Duplicate rows", "Повторяющиеся строки"),
        });
        const policy = policyLabel.createEl("select");
        for (const [value, english, russian] of [
            ["skip", "Keep existing", "Оставить существующие"],
            ["replace", "Update existing", "Обновить существующие"],
            ["copy", "Create copies", "Создать копии"],
        ] as const) {
            const option = policy.createEl("option", {
                text: this.transferText(english, russian),
            });
            option.value = value;
            option.selected = this.transferDuplicatePolicy === value;
        }
        policy.addEventListener("change", () => {
            this.transferDuplicatePolicy = policy.value as DuplicatePolicy;
        });

        const headers = this.transferCsvRows[0] ?? [];
        const type = noteTypes.find((candidate) => candidate.id === this.transferCsvNoteTypeId);
        const mapping = panel.createDiv("sr-transfer-field-map");
        for (const field of type?.fields ?? []) {
            const row = mapping.createEl("label");
            row.createSpan({ text: field.name });
            const select = row.createEl("select");
            const none = select.createEl("option", {
                text: this.transferText("Do not import", "Не импортировать"),
            });
            none.value = "-1";
            for (const [index, header] of headers.entries()) {
                const option = select.createEl("option", { text: header || `Column ${index + 1}` });
                option.value = String(index);
                option.selected = this.transferCsvMapping[field.id] === index;
            }
            select.addEventListener("change", () => {
                this.transferCsvMapping[field.id] = Number(select.value);
            });
        }
        const tagsRow = mapping.createEl("label");
        tagsRow.createSpan({ text: this.transferText("Tags", "Теги") });
        const tagsSelect = tagsRow.createEl("select");
        const noTags = tagsSelect.createEl("option", {
            text: this.transferText("No tags", "Без тегов"),
        });
        noTags.value = "-1";
        for (const [index, header] of headers.entries()) {
            const option = tagsSelect.createEl("option", { text: header || `Column ${index + 1}` });
            option.value = String(index);
            option.selected = this.transferCsvTagsColumn === index;
        }
        tagsSelect.addEventListener(
            "change",
            () => (this.transferCsvTagsColumn = Number(tagsSelect.value)),
        );
        const footer = panel.createDiv("sr-transfer-footer");
        new ButtonComponent(footer)
            .setButtonText(this.transferText("Import rows", "Импортировать строки"))
            .setIcon("download")
            .setDisabled(this.busy || !type)
            .onClick(() => void this.importTransferCsv());
    }

    private transferRowKey(row: string[]): string {
        let hash = 0x811c9dc5;
        const value = `${this.transferFileName}\u001f${row.join("\u001f")}`;
        for (let index = 0; index < value.length; index++) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193);
        }
        return `csv-${(hash >>> 0).toString(16).padStart(8, "0")}`;
    }

    private async importTransferCsv(): Promise<void> {
        if (this.busy || this.transferCsvRows.length < 2) return;
        const collection = this.plugin.dataManager.collectionStore;
        const type = collection.getNoteType(this.transferCsvNoteTypeId);
        if (!type) return;
        this.busy = true;
        this.error = "";
        this.render();
        try {
            await collection.createBackup("before-csv-import");
            const snapshot = collection.getCollectionSnapshot();
            const existing = new Map(
                Object.values(snapshot.notes)
                    .filter((note) => !note.deletedAt && note.externalIds?.csvKey)
                    .map((note) => [note.externalIds.csvKey, note]),
            );
            const drafts: StructuredNoteDraft[] = [];
            let updated = 0;
            let skipped = 0;
            for (const row of this.transferCsvRows.slice(1)) {
                const key = this.transferRowKey(row);
                const fields = Object.fromEntries(
                    type.fields.map((field) => [
                        field.id,
                        this.transferCsvMapping[field.id] >= 0
                            ? (row[this.transferCsvMapping[field.id]] ?? "")
                            : "",
                    ]),
                );
                const tags =
                    this.transferCsvTagsColumn >= 0
                        ? (row[this.transferCsvTagsColumn] ?? "").split(/[ ,]+/).filter(Boolean)
                        : [];
                const deckColumn = (this.transferCsvRows[0] ?? []).findIndex((header) =>
                    /^deck$/i.test(header.trim()),
                );
                const draft: StructuredNoteDraft = {
                    noteTypeId: type.id,
                    deckPath: normalizeManagedDeckPath(
                        (deckColumn >= 0 ? row[deckColumn] : this.transferCsvDeck) ?? "",
                    ),
                    fields,
                    tags,
                    externalIds: { csvKey: key },
                    externalData: { csv: { file: this.transferFileName, row } },
                };
                const previous = existing.get(key);
                if (previous && this.transferDuplicatePolicy === "skip") skipped++;
                else if (previous && this.transferDuplicatePolicy === "replace") {
                    await this.store.updateStructuredNote(previous, draft);
                    updated++;
                } else {
                    if (previous)
                        draft.externalIds = { csvKey: `${key}-copy-${Date.now().toString(36)}` };
                    drafts.push(draft);
                }
            }
            const files = await this.store.createStructuredNotes(drafts);
            this.transferReport = {
                created: files.length,
                updated,
                skipped,
                noteTypes: 0,
                decks: 0,
                media: 0,
                scheduledCards: 0,
                errors: [],
            };
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            this.render();
        }
    }

    private async ensureTransferFolder(path: string): Promise<void> {
        let current = "";
        for (const part of normalizePath(path).split("/").filter(Boolean)) {
            current = current ? `${current}/${part}` : part;
            if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
                await this.plugin.app.vault.createFolder(current);
            }
        }
    }

    private async saveTransferBinary(fileName: string, data: ArrayBuffer): Promise<string> {
        const folder = normalizePath(
            `${this.plugin.dataManager.data.settings.scheduleDataVaultLocation}/Exports`,
        );
        await this.ensureTransferFolder(folder);
        let path = normalizePath(`${folder}/${fileName}`);
        let suffix = 2;
        const dot = fileName.lastIndexOf(".");
        const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
        const extension = dot > 0 ? fileName.slice(dot) : "";
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = normalizePath(`${folder}/${stem}-${suffix}${extension}`);
            suffix++;
        }
        await this.plugin.app.vault.createBinary(path, data);
        return path;
    }

    private async exportTransferPackage(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.transferProgress = this.transferText("Building Anki package…", "Собираю пакет Anki…");
        this.render();
        try {
            const bytes = await new AnkiTransferService(this.plugin).exportPackage();
            const path = await this.saveTransferBinary(
                `MSRE-${new Date().toISOString().slice(0, 10)}.apkg`,
                Uint8Array.from(bytes).buffer,
            );
            new Notice(this.transferText(`Saved to ${path}`, `Сохранено: ${path}`));
        } catch (error) {
            this.error = error instanceof Error ? error.message : String(error);
        } finally {
            this.busy = false;
            this.transferProgress = "";
            this.render();
        }
    }

    private async exportTransferCsv(): Promise<void> {
        const collection = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const notes = Object.values(collection.notes).filter((note) => !note.deletedAt);
        const cards = Object.values(collection.cards).filter((card) => !card.deletedAt);
        const fieldNames = [
            ...new Set(
                notes.flatMap(
                    (note) =>
                        collection.noteTypes[note.noteTypeId]?.fields.map((field) => field.name) ??
                        [],
                ),
            ),
        ].sort((left, right) => left.localeCompare(right));
        const rows = [
            ["Deck", "Note type", "Tags", ...fieldNames.map((field) => `Field:${field}`)],
            ...notes.map((note) => {
                const type = collection.noteTypes[note.noteTypeId];
                const deck = cards.find((card) => card.noteId === note.id)?.deckPath ?? "";
                const byName = new Map(
                    type.fields.map((field) => [field.name, note.fields[field.id] ?? ""]),
                );
                return [
                    deck,
                    type.name,
                    note.tags.join(" "),
                    ...fieldNames.map((name) => byName.get(name) ?? ""),
                ];
            }),
        ];
        const data = new TextEncoder().encode(`\ufeff${writeDelimited(rows, ",")}`);
        const path = await this.saveTransferBinary(
            `MSRE-${new Date().toISOString().slice(0, 10)}.csv`,
            Uint8Array.from(data).buffer,
        );
        new Notice(this.transferText(`Saved to ${path}`, `Сохранено: ${path}`));
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

        const learning = surface.createDiv("sr-native-options-section");
        learning.createEl("h2", { text: "Learning & relearning" });
        learning.createEl("p", {
            text: "Short steps run before FSRS places a card into long-term review.",
        });
        const stepGrid = learning.createDiv("sr-native-options-grid");
        this.createStepsControl(
            stepGrid,
            "Learning steps",
            draft.learningSteps ?? [1, 10],
            (value) => {
                draft.learningSteps = value;
            },
        );
        this.createStepsControl(
            stepGrid,
            "Relearning steps",
            draft.relearningSteps ?? [10],
            (value) => {
                draft.relearningSteps = value;
            },
        );

        const safeguards = surface.createDiv("sr-native-options-section");
        safeguards.createEl("h2", { text: "Workload safeguards" });
        const safeguardGrid = safeguards.createDiv("sr-native-options-grid");
        this.createNumberControl(
            safeguardGrid,
            "Leech threshold",
            draft.leechThreshold ?? 8,
            1,
            99,
            (value) => (draft.leechThreshold = value),
        );
        this.createNumberControl(
            safeguardGrid,
            "Review ahead (days)",
            draft.reviewAheadDays ?? 0,
            0,
            365,
            (value) => (draft.reviewAheadDays = value),
        );
        this.createChoiceControl(safeguards, "Leech action", [
            {
                label: "Tag",
                active: draft.leechAction === "tag",
                action: () => (draft.leechAction = "tag"),
            },
            {
                label: "Suspend",
                active: draft.leechAction === "suspend",
                action: () => (draft.leechAction = "suspend"),
            },
        ]);
        this.createChoiceControl(safeguards, "Load balancing", [
            { label: "Off", active: !draft.loadBalance, action: () => (draft.loadBalance = false) },
            { label: "On", active: draft.loadBalance, action: () => (draft.loadBalance = true) },
        ]);

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

    private createStepsControl(
        parent: HTMLElement,
        label: string,
        value: number[],
        onChange: (value: number[]) => void,
    ): void {
        const wrapper = parent.createDiv("sr-native-number-control");
        wrapper.createEl("label", { text: label });
        const input = wrapper.createEl("input", {
            cls: "sr-native-input",
            attr: { type: "text", inputmode: "numeric", placeholder: "1, 10", "aria-label": label },
        });
        input.value = value.join(", ");
        input.addEventListener("change", () => {
            const steps = input.value
                .split(/[ ,;]+/)
                .map(Number)
                .filter((step) => Number.isFinite(step) && step > 0)
                .map(Math.round);
            onChange(steps);
            input.value = steps.join(", ");
        });
    }

    private createChoiceControl(
        parent: HTMLElement,
        label: string,
        choices: Array<{ label: string; active: boolean; action: () => void }>,
    ): void {
        const group = parent.createDiv("sr-native-choice-control");
        group.createEl("span", { text: label });
        const buttons = group.createDiv("sr-native-order-switcher");
        for (const choice of choices) {
            const button = new ButtonComponent(buttons).setButtonText(choice.label).onClick(() => {
                choice.action();
                this.render();
            });
            button.buttonEl.toggleClass("is-active", choice.active);
        }
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

        const organization = surface.createDiv("sr-native-options-section");
        organization.createEl("h2", { text: this.creatorText("Organization", "Организация") });
        organization.createEl("p", {
            text: this.creatorText(
                "Nest areas and use projects for knowledge with a concrete outcome.",
                "Вкладывайте области друг в друга, а проекты используйте для конкретной цели.",
            ),
        });
        this.createChoiceControl(organization, this.creatorText("Kind", "Тип"), [
            {
                label: this.creatorText("Area", "Область"),
                active: this.areaKind === "area",
                action: () => (this.areaKind = "area"),
            },
            {
                label: this.creatorText("Project", "Проект"),
                active: this.areaKind === "project",
                action: () => (this.areaKind = "project"),
            },
        ]);
        const parentGroup = this.createFieldGroup(
            organization,
            this.creatorText("Parent area", "Родительская область"),
            this.creatorText(
                "Leave empty to keep it at the top level.",
                "Оставьте пустым для верхнего уровня.",
            ),
        );
        const parent = parentGroup.createEl("select", {
            cls: "sr-native-input",
            attr: { "aria-label": this.creatorText("Parent area", "Родительская область") },
        });
        parent.createEl("option", {
            text: this.creatorText("Top level", "Верхний уровень"),
            attr: { value: "" },
        });
        for (const area of this.store
            .getKnowledgeAreas()
            .filter((area) => area.id !== this.editingAreaId && !area.archivedAt)) {
            parent.createEl("option", { text: area.name, attr: { value: area.id } });
        }
        parent.value = this.areaParentId ?? "";
        parent.addEventListener("change", () => (this.areaParentId = parent.value || null));

        const goal = surface.createDiv("sr-native-options-section");
        goal.createEl("h2", { text: this.creatorText("Study goal", "Учебная цель") });
        const goalGrid = goal.createDiv("sr-native-options-grid");
        const targetDate = this.createFieldGroup(
            goalGrid,
            this.creatorText("Target date", "Срок"),
            this.creatorText("Optional", "Необязательно"),
        ).createEl("input", { cls: "sr-native-input", attr: { type: "date" } });
        targetDate.value = this.areaGoal.targetDate ?? "";
        targetDate.addEventListener("change", () => {
            this.areaGoal.targetDate = targetDate.value || undefined;
        });
        this.createNumberControl(
            goalGrid,
            this.creatorText("Cards per day", "Карточек в день"),
            this.areaGoal.cardsPerDay ?? 20,
            0,
            10000,
            (value) => (this.areaGoal.cardsPerDay = value),
        );
        this.createNumberControl(
            goalGrid,
            this.creatorText("Minutes per day", "Минут в день"),
            this.areaGoal.minutesPerDay ?? 20,
            0,
            1440,
            (value) => (this.areaGoal.minutesPerDay = value),
        );
        this.createNumberControl(
            goalGrid,
            this.creatorText("Target retention, %", "Целевое сохранение, %"),
            Math.round((this.areaGoal.targetRetention ?? 0.9) * 100),
            70,
            99,
            (value) => (this.areaGoal.targetRetention = value / 100),
        );

        const scheduler = surface.createDiv("sr-native-options-section");
        scheduler.createEl("h2", { text: "Scheduler override" });
        scheduler.createEl("p", {
            text: "Optional settings here override deck presets for every deck in this knowledge area.",
        });
        const grid = scheduler.createDiv("sr-native-options-grid");
        this.createNumberControl(
            grid,
            "Retention, %",
            Math.round((this.areaScheduling.desiredRetention ?? 0.9) * 100),
            70,
            99,
            (value) => (this.areaScheduling.desiredRetention = value / 100),
        );
        this.createNumberControl(
            grid,
            "Leech threshold",
            this.areaScheduling.leechThreshold ?? 8,
            1,
            99,
            (value) => (this.areaScheduling.leechThreshold = value),
        );
        this.createStepsControl(
            grid,
            "Learning steps",
            this.areaScheduling.learningSteps ?? [1, 10],
            (value) => (this.areaScheduling.learningSteps = value),
        );
        this.createStepsControl(
            grid,
            "Relearning steps",
            this.areaScheduling.relearningSteps ?? [10],
            (value) => (this.areaScheduling.relearningSteps = value),
        );
        this.createNumberControl(
            grid,
            "Review ahead (days)",
            this.areaScheduling.reviewAheadDays ?? 0,
            0,
            365,
            (value) => (this.areaScheduling.reviewAheadDays = value),
        );
        this.createChoiceControl(scheduler, "Leech action", [
            {
                label: "Tag",
                active: (this.areaScheduling.leechAction ?? "tag") === "tag",
                action: () => (this.areaScheduling.leechAction = "tag"),
            },
            {
                label: "Suspend",
                active: this.areaScheduling.leechAction === "suspend",
                action: () => (this.areaScheduling.leechAction = "suspend"),
            },
        ]);
        this.createChoiceControl(scheduler, "Load balancing", [
            {
                label: "Off",
                active: this.areaScheduling.loadBalance === false,
                action: () => (this.areaScheduling.loadBalance = false),
            },
            {
                label: "On",
                active: this.areaScheduling.loadBalance !== false,
                action: () => (this.areaScheduling.loadBalance = true),
            },
        ]);

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

        this.renderTemplateLibrary(surface);

        const list = surface.createDiv("sr-note-type-list");
        for (const noteType of this.plugin.dataManager.collectionStore.getNoteTypes()) {
            if (noteType.id === IMAGE_OCCLUSION_NOTE_TYPE_ID) continue;
            this.renderNoteTypeRow(list, noteType);
        }
    }

    private renderTemplateLibrary(parent: HTMLElement): void {
        const library = parent.createEl("details", { cls: "sr-template-library" });
        const summary = library.createEl("summary");
        const icon = summary.createSpan("sr-template-library-icon");
        setIcon(icon, "library-big");
        const copy = summary.createDiv();
        copy.createEl("strong", { text: t("TEMPLATE_LIBRARY") });
        copy.createSpan({ text: t("TEMPLATE_LIBRARY_HELP") });
        const grid = library.createDiv("sr-template-library-grid");
        for (const blueprint of TEMPLATE_LIBRARY) {
            const card = grid.createDiv("sr-template-library-card");
            const cardIcon = card.createDiv("sr-template-library-card-icon");
            setIcon(
                cardIcon,
                blueprint.id === "medicine"
                    ? "heart-pulse"
                    : blueprint.id === "law"
                      ? "scale"
                      : blueprint.id === "mathematics"
                        ? "sigma"
                        : "languages",
            );
            const body = card.createDiv();
            body.createEl("strong", { text: this.getLibraryBlueprintName(blueprint) });
            body.createSpan({ text: this.getLibraryBlueprintDescription(blueprint) });
            new ButtonComponent(card).setButtonText(t("USE_TEMPLATE")).onClick(() => {
                this.noteTypeDraft = this.createDraftFromLibrary(blueprint);
                this.templatePreviewValues = {};
                this.render();
            });
        }
    }

    private getLibraryBlueprintName(blueprint: TemplateLibraryBlueprint): string {
        if (blueprint.id === "medicine") return t("TEMPLATE_LIBRARY_MEDICINE");
        if (blueprint.id === "law") return t("TEMPLATE_LIBRARY_LAW");
        if (blueprint.id === "mathematics") return t("TEMPLATE_LIBRARY_MATHEMATICS");
        return t("TEMPLATE_LIBRARY_LANGUAGE");
    }

    private getLibraryBlueprintDescription(blueprint: TemplateLibraryBlueprint): string {
        if (blueprint.id === "medicine") return t("TEMPLATE_LIBRARY_MEDICINE_DESC");
        if (blueprint.id === "law") return t("TEMPLATE_LIBRARY_LAW_DESC");
        if (blueprint.id === "mathematics") return t("TEMPLATE_LIBRARY_MATHEMATICS_DESC");
        return t("TEMPLATE_LIBRARY_LANGUAGE_DESC");
    }

    private createDraftFromLibrary(blueprint: TemplateLibraryBlueprint): NoteTypeEditorDraft {
        const store = this.plugin.dataManager.collectionStore;
        const fields = blueprint.fields.map((field, ordinal) => ({
            id: store.createId("field"),
            name: field.name,
            ordinal,
            kind: field.kind ?? ("rich-text" as const),
            required: field.required ?? false,
        }));
        const byName = new Map(fields.map((field) => [field.name, field.id]));
        const createBlockId = () => store.createId("block");
        const templates = blueprint.templates.map((template, ordinal): CardTemplateDefinition => ({
            id: store.createId("template"),
            version: 1,
            name: template.name,
            ordinal,
            questionFormat: template.question,
            answerFormat: template.answer,
            browserFormat: template.browser ?? template.question,
            deckOverride: null,
            enabled: true,
            generator: template.generator ?? "standard",
            answerMode: canonicalAnswerMode(template.answerMode),
            answerConfig: createDefaultAnswerConfig(),
            answerFieldId: template.answerField ? (byName.get(template.answerField) ?? null) : null,
            sourceFieldId: template.sourceField ? (byName.get(template.sourceField) ?? null) : null,
            condition: conditionForField(
                template.conditionField ? (byName.get(template.conditionField) ?? null) : null,
            ),
            css: "",
            editorMode: "visual",
            questionBlocks: inferTemplateBlocks(template.question, fields, createBlockId),
            answerBlocks: inferTemplateBlocks(template.answer, fields, createBlockId),
            browserBlocks: inferTemplateBlocks(
                template.browser ?? template.question,
                fields,
                createBlockId,
            ),
            questionCss: "",
            answerCss: "",
            browserCss: "",
        }));
        return {
            id: store.createId("notetype"),
            version: 1,
            name: this.getLibraryBlueprintName(blueprint),
            kind: "standard",
            fields,
            templates,
            css: blueprint.css,
        };
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
                const previousName = field.name;
                field.name = name.value;
                if (previousName && previousName !== field.name) {
                    for (const template of draft.templates) {
                        template.questionFormat = template.questionFormat
                            .split(`{{${previousName}}}`)
                            .join(`{{${field.name}}}`);
                        template.answerFormat = template.answerFormat
                            .split(`{{${previousName}}}`)
                            .join(`{{${field.name}}}`);
                        template.browserFormat = (template.browserFormat ?? "")
                            .split(`{{${previousName}}}`)
                            .join(`{{${field.name}}}`);
                    }
                }
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
                    for (const template of draft.templates) {
                        for (const blocks of [
                            template.questionBlocks,
                            template.answerBlocks,
                            template.browserBlocks,
                        ]) {
                            for (const block of blocks ?? []) {
                                if (block.fieldId === field.id) block.fieldId = null;
                                if (block.condition.fieldId === field.id) {
                                    block.condition = {
                                        operator: "always",
                                        fieldId: null,
                                        value: "",
                                    };
                                }
                            }
                        }
                        if (template.answerFieldId === field.id) template.answerFieldId = null;
                        if (template.sourceFieldId === field.id) template.sourceFieldId = null;
                        if (template.condition?.fieldId === field.id) {
                            template.condition = {
                                operator: "always",
                                fieldId: null,
                                value: "",
                            };
                        }
                    }
                    draft.fields.splice(index, 1);
                    for (const template of draft.templates) {
                        if ((template.editorMode ?? "advanced") === "visual") {
                            this.syncTemplateBlocks(template, draft);
                        }
                    }
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
            const enabled = top.createEl("label", { cls: "sr-note-template-enabled" });
            const enabledInput = enabled.createEl("input", { attr: { type: "checkbox" } });
            enabledInput.checked = template.enabled;
            enabledInput.addEventListener("change", () => {
                template.enabled = enabledInput.checked;
                card.toggleClass("is-disabled", !template.enabled);
            });
            enabled.createSpan({ text: t("TEMPLATE_ENABLED") });
            new ButtonComponent(top)
                .setIcon("trash-2")
                .setTooltip(t("REMOVE_TEMPLATE"))
                .setDisabled(draft.templates.length === 1)
                .onClick(() => {
                    draft.templates.splice(index, 1);
                    this.render();
                });

            const behavior = card.createDiv("sr-note-template-behavior");
            this.createTemplateSelect(
                behavior,
                t("TEMPLATE_GENERATOR"),
                template.generator ?? draft.kind,
                [
                    ["standard", t("TEMPLATE_GENERATOR_STANDARD")],
                    ["cloze", t("TEMPLATE_GENERATOR_CLOZE")],
                    ["image-occlusion", t("TEMPLATE_GENERATOR_OCCLUSION")],
                ],
                (value) => {
                    template.generator = value as NoteTypeKind;
                    if (template.generator === "cloze" && !template.sourceFieldId) {
                        template.sourceFieldId = draft.fields[0]?.id ?? null;
                    }
                },
            );
            this.createTemplateSelect(
                behavior,
                t("TEMPLATE_ANSWER_MODE"),
                canonicalAnswerMode(template.answerMode),
                [
                    ["reveal", t("ANSWER_MODE_REVEAL")],
                    ["text", t("ANSWER_MODE_TEXT")],
                    ["multiple-text", t("ANSWER_MODE_MULTIPLE_TEXT")],
                    ["number", t("ANSWER_MODE_NUMBER")],
                    ["formula", t("ANSWER_MODE_FORMULA")],
                    ["ordered-list", t("ANSWER_MODE_ORDERED_LIST")],
                    ["unordered-list", t("ANSWER_MODE_UNORDERED_LIST")],
                    ["image-labels", t("ANSWER_MODE_IMAGE_LABELS")],
                    ["multiple-choice", t("ANSWER_MODE_MULTIPLE_CHOICE")],
                ],
                (value) => {
                    template.answerMode = value as CardAnswerMode;
                    template.answerConfig = normalizeAnswerConfig(template.answerConfig);
                },
            );
            if ((template.generator ?? draft.kind) === "cloze") {
                this.createTemplateSelect(
                    behavior,
                    t("TEMPLATE_SOURCE_FIELD"),
                    template.sourceFieldId ?? "",
                    [
                        ["", t("TEMPLATE_ANY_FIELD")],
                        ...draft.fields.map((field) => [field.id, field.name] as [string, string]),
                    ],
                    (value) => (template.sourceFieldId = value || null),
                );
            }
            const answerMode = canonicalAnswerMode(template.answerMode);
            if (
                ["text", "number", "formula", "ordered-list", "unordered-list"].includes(answerMode)
            ) {
                this.createTemplateSelect(
                    behavior,
                    t("TEMPLATE_ANSWER_FIELD"),
                    template.answerFieldId ?? "",
                    [
                        ["", t("TEMPLATE_RENDERED_ANSWER")],
                        ...draft.fields.map((field) => [field.id, field.name] as [string, string]),
                    ],
                    (value) => (template.answerFieldId = value || null),
                );
            }
            if (answerMode !== "reveal") {
                this.renderAnswerCheckingEditor(card, draft, template);
            }

            const mode = card.createDiv("sr-template-editor-mode");
            for (const [value, label] of [
                ["visual", t("TEMPLATE_MODE_VISUAL")],
                ["advanced", t("TEMPLATE_MODE_ADVANCED")],
            ] as const) {
                const button = new ButtonComponent(mode).setButtonText(label).onClick(() => {
                    template.editorMode = value;
                    if (value === "visual") this.ensureTemplateBlocks(template, draft);
                    this.render();
                });
                button.buttonEl.toggleClass(
                    "is-active",
                    (template.editorMode ?? "advanced") === value,
                );
                button.buttonEl.setAttribute(
                    "aria-pressed",
                    String((template.editorMode ?? "advanced") === value),
                );
            }

            const behaviorDetails = card.createEl("details", {
                cls: "sr-note-template-advanced",
            });
            behaviorDetails.createEl("summary", { text: t("TEMPLATE_BEHAVIOR_STYLE") });
            const behaviorBody = behaviorDetails.createDiv("sr-note-template-advanced-body");
            this.renderTemplateCondition(behaviorBody, draft, template);
            this.createTemplateCssEditor(
                behaviorBody,
                t("TEMPLATE_STYLE"),
                template.css ?? "",
                (value) => {
                    template.css = value;
                    this.refreshTemplatePreviewFrom(behaviorBody, draft, template);
                },
            );

            if ((template.editorMode ?? "advanced") === "visual") {
                this.ensureTemplateBlocks(template, draft);
                this.renderVisualTemplateEditor(card, draft, template);
            } else {
                this.renderAdvancedTemplateEditor(card, draft, template);
            }

            const deck = card.createDiv("sr-note-template-deck");
            const deckCopy = deck.createDiv();
            deckCopy.createEl("strong", { text: t("TEMPLATE_DECK") });
            deckCopy.createSpan({ text: t("TEMPLATE_DECK_HELP") });
            const deckButton = new ButtonComponent(deck)
                .setButtonText(template.deckOverride || t("INHERIT_NOTE_DECK"))
                .onClick(() => {
                    new DeckPickerModal(this.app, {
                        decks: this.store.getDeckPaths(),
                        current: template.deckOverride ?? "",
                        allowAll: true,
                        onChoose: (path) => {
                            template.deckOverride = path === "all" ? null : path;
                            this.render();
                        },
                        onCreate: (path) => this.store.createDeck(path),
                    }).open();
                });
            deckButton.buttonEl.addClass("sr-note-template-deck-button");

            const preview = card.createDiv("sr-note-template-preview");
            this.renderTemplatePreview(preview, draft, template);
        });

        this.renderNoteTypeStyleEditor(parent, draft);
    }

    private createTemplateSelect(
        parent: HTMLElement,
        label: string,
        current: string,
        options: Array<[string, string]>,
        onChange: (value: string) => void,
    ): void {
        const control = parent.createEl("label", { cls: "sr-note-template-control" });
        control.createSpan({ text: label });
        const select = control.createEl("select", { cls: "dropdown" });
        for (const [value, text] of options) select.createEl("option", { value, text });
        select.value = current;
        select.addEventListener("change", () => {
            onChange(select.value);
            this.render();
        });
    }

    private renderAnswerCheckingEditor(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
    ): void {
        const mode = canonicalAnswerMode(template.answerMode);
        const config = normalizeAnswerConfig(template.answerConfig);
        template.answerConfig = config;
        const details = parent.createEl("details", {
            cls: "sr-answer-check-editor sr-note-template-advanced",
        });
        details.open = true;
        details.createEl("summary", { text: t("ANSWER_CHECKING_RULES") });
        const body = details.createDiv("sr-answer-check-editor-body");

        const addTextArea = (
            label: string,
            value: string,
            placeholder: string,
            onInput: (next: string) => void,
        ) => {
            const control = body.createEl("label", { cls: "sr-answer-check-control" });
            control.createSpan({ text: label });
            const input = control.createEl("textarea", {
                cls: "sr-native-input",
                attr: { rows: "2", placeholder },
            });
            input.value = value;
            input.addEventListener("input", () => onInput(input.value));
        };
        const parseLines = (value: string) =>
            value
                .split(/\n|;/)
                .map((item) => item.trim())
                .filter(Boolean);

        if (!["multiple-text", "image-labels", "multiple-choice"].includes(mode)) {
            addTextArea(
                t("ACCEPTED_ANSWERS"),
                config.acceptedAnswers.join("\n"),
                t("ACCEPTED_ANSWERS_PLACEHOLDER"),
                (value) => (config.acceptedAnswers = parseLines(value)),
            );
        }
        if (["text", "multiple-text", "image-labels"].includes(mode)) {
            addTextArea(
                t("SYNONYM_GROUPS"),
                config.synonymGroups.map((group) => group.join(" = ")).join("\n"),
                t("SYNONYM_GROUPS_PLACEHOLDER"),
                (value) => {
                    config.synonymGroups = value
                        .split("\n")
                        .map((line) =>
                            line
                                .split(/=|\|/)
                                .map((item) => item.trim())
                                .filter(Boolean),
                        )
                        .filter((group) => group.length > 1);
                },
            );
            addTextArea(
                t("REQUIRED_KEYWORDS"),
                config.requiredKeywords.join("; "),
                t("REQUIRED_KEYWORDS_PLACEHOLDER"),
                (value) => (config.requiredKeywords = parseLines(value)),
            );
            addTextArea(
                t("OPTIONAL_KEYWORDS"),
                config.optionalKeywords.join("; "),
                t("OPTIONAL_KEYWORDS_PLACEHOLDER"),
                (value) => (config.optionalKeywords = parseLines(value)),
            );
            const toggles = body.createDiv("sr-answer-check-toggles");
            for (const [key, label] of [
                ["ignoreCase", t("IGNORE_CASE")],
                ["ignoreWhitespace", t("IGNORE_WHITESPACE")],
                ["ignorePunctuation", t("IGNORE_PUNCTUATION")],
                ["normalizeYo", t("NORMALIZE_YO")],
            ] as const) {
                const control = toggles.createEl("label");
                const input = control.createEl("input", { attr: { type: "checkbox" } });
                input.checked = config.normalization[key];
                input.addEventListener("change", () => (config.normalization[key] = input.checked));
                control.createSpan({ text: label });
            }
        }

        if (mode === "number") {
            const grid = body.createDiv("sr-answer-number-grid");
            const addNumber = (
                label: string,
                value: number | null,
                onInput: (next: number | null) => void,
            ) => {
                const control = grid.createEl("label", { cls: "sr-answer-check-control" });
                control.createSpan({ text: label });
                const input = control.createEl("input", {
                    cls: "sr-native-input",
                    attr: { type: "number", step: "any" },
                });
                input.value = value === null ? "" : String(value);
                input.addEventListener("input", () =>
                    onInput(input.value === "" ? null : Number(input.value)),
                );
            };
            addNumber(
                t("ABSOLUTE_TOLERANCE"),
                config.numeric.tolerance,
                (value) => (config.numeric.tolerance = value ?? 0),
            );
            addNumber(
                t("RELATIVE_TOLERANCE"),
                config.numeric.relativeTolerance,
                (value) => (config.numeric.relativeTolerance = value ?? 0),
            );
            addNumber(
                t("MINIMUM_VALUE"),
                config.numeric.min,
                (value) => (config.numeric.min = value),
            );
            addNumber(
                t("MAXIMUM_VALUE"),
                config.numeric.max,
                (value) => (config.numeric.max = value),
            );
            addTextArea(
                t("ACCEPTED_UNITS"),
                config.numeric.units.join("; "),
                "mg; g; kg",
                (value) => (config.numeric.units = parseLines(value)),
            );
            addTextArea(
                t("UNIT_CONVERSIONS"),
                Object.entries(config.numeric.unitFactors)
                    .map(([unit, factor]) => `${unit}=${factor}`)
                    .join("\n"),
                "mg=0.001",
                (value) => {
                    config.numeric.unitFactors = Object.fromEntries(
                        value
                            .split("\n")
                            .map((line) => line.split("="))
                            .filter(([, factor]) => Number.isFinite(Number(factor)))
                            .map(([unit, factor]) => [unit.trim(), Number(factor)]),
                    );
                },
            );
        }

        if (mode === "ordered-list" || mode === "unordered-list") {
            this.createTemplateSelect(
                body,
                t("LIST_SEPARATOR"),
                config.listSeparator,
                [
                    ["newline", t("LIST_SEPARATOR_NEWLINE")],
                    ["comma", t("LIST_SEPARATOR_COMMA")],
                    ["semicolon", t("LIST_SEPARATOR_SEMICOLON")],
                ],
                (value) => (config.listSeparator = value as typeof config.listSeparator),
            );
        }

        if (mode === "multiple-text" || mode === "image-labels") {
            const heading = body.createDiv("sr-answer-check-heading");
            heading.createEl("strong", { text: t("ANSWER_PARTS") });
            new ButtonComponent(heading)
                .setIcon("plus")
                .setTooltip(t("ADD_ANSWER_PART"))
                .onClick(() => {
                    config.parts.push({
                        id: this.plugin.dataManager.collectionStore.createId("answer-part"),
                        label: `${t("ANSWER_PART")} ${config.parts.length + 1}`,
                        answerFieldId: draft.fields[0]?.id ?? null,
                        acceptedAnswers: [],
                        requiredKeywords: [],
                        optional: false,
                        weight: 1,
                    });
                    this.render();
                });
            config.parts.forEach((part, index) => {
                const row = body.createDiv("sr-answer-part-row");
                const label = row.createEl("input", {
                    cls: "sr-native-input",
                    attr: { type: "text", placeholder: t("ANSWER_PART") },
                });
                label.value = part.label;
                label.addEventListener("input", () => (part.label = label.value));
                const field = row.createEl("select", { cls: "dropdown" });
                field.createEl("option", { value: "", text: t("CUSTOM_EXPECTED_ANSWER") });
                for (const item of draft.fields)
                    field.createEl("option", { value: item.id, text: item.name });
                field.value = part.answerFieldId ?? "";
                field.addEventListener("change", () => (part.answerFieldId = field.value || null));
                const accepted = row.createEl("input", {
                    cls: "sr-native-input",
                    attr: { type: "text", placeholder: t("ACCEPTED_ANSWERS_SHORT") },
                });
                accepted.value = part.acceptedAnswers.join("; ");
                accepted.addEventListener(
                    "input",
                    () => (part.acceptedAnswers = parseLines(accepted.value)),
                );
                new ButtonComponent(row)
                    .setIcon("trash-2")
                    .setTooltip(t("DELETE"))
                    .onClick(() => {
                        config.parts.splice(index, 1);
                        this.render();
                    });
            });
        }

        if (mode === "multiple-choice") {
            const heading = body.createDiv("sr-answer-check-heading");
            heading.createEl("strong", { text: t("ANSWER_CHOICES") });
            const multiple = heading.createEl("label", { cls: "sr-answer-choice-multiple" });
            const multipleInput = multiple.createEl("input", { attr: { type: "checkbox" } });
            multipleInput.checked = config.multipleChoice;
            multipleInput.addEventListener(
                "change",
                () => (config.multipleChoice = multipleInput.checked),
            );
            multiple.createSpan({ text: t("ALLOW_MULTIPLE_CHOICES") });
            new ButtonComponent(heading)
                .setIcon("plus")
                .setTooltip(t("ADD_CHOICE"))
                .onClick(() => {
                    config.choices.push({
                        id: this.plugin.dataManager.collectionStore.createId("choice"),
                        label: "",
                        correct: false,
                    });
                    this.render();
                });
            config.choices.forEach((choice, index) => {
                const row = body.createEl("label", { cls: "sr-answer-choice-row" });
                const correct = row.createEl("input", {
                    attr: {
                        type: config.multipleChoice ? "checkbox" : "radio",
                        name: `correct-${template.id}`,
                    },
                });
                correct.checked = choice.correct;
                correct.addEventListener("change", () => {
                    if (!config.multipleChoice)
                        config.choices.forEach((item) => (item.correct = false));
                    choice.correct = correct.checked;
                    this.render();
                });
                const label = row.createEl("input", {
                    cls: "sr-native-input",
                    attr: { type: "text", placeholder: t("CHOICE_TEXT") },
                });
                label.value = choice.label;
                label.addEventListener("input", () => (choice.label = label.value));
                new ButtonComponent(row)
                    .setIcon("trash-2")
                    .setTooltip(t("DELETE"))
                    .onClick(() => {
                        config.choices.splice(index, 1);
                        this.render();
                    });
            });
        }

        const partial = body.createEl("label", { cls: "sr-answer-partial-toggle" });
        const partialInput = partial.createEl("input", { attr: { type: "checkbox" } });
        partialInput.checked = config.allowPartial;
        partialInput.addEventListener("change", () => (config.allowPartial = partialInput.checked));
        partial.createSpan({ text: t("ALLOW_PARTIAL_CREDIT") });
    }

    private ensureTemplateBlocks(
        template: CardTemplateDefinition,
        draft: NoteTypeEditorDraft,
    ): void {
        const idFactory = () => this.plugin.dataManager.collectionStore.createId("block");
        if (!template.questionBlocks?.length) {
            template.questionBlocks = inferTemplateBlocks(
                template.questionFormat,
                draft.fields,
                idFactory,
            );
        }
        if (!template.answerBlocks?.length) {
            template.answerBlocks = inferTemplateBlocks(
                template.answerFormat,
                draft.fields,
                idFactory,
            );
        }
        if (!template.browserBlocks?.length) {
            template.browserBlocks = inferTemplateBlocks(
                template.browserFormat ?? template.questionFormat,
                draft.fields,
                idFactory,
            );
        }
    }

    private templateBlocksForSurface(
        template: CardTemplateDefinition,
        surface: TemplateSurface,
    ): TemplateVisualBlock[] {
        if (surface === "question") return (template.questionBlocks ??= []);
        if (surface === "answer") return (template.answerBlocks ??= []);
        return (template.browserBlocks ??= []);
    }

    private syncTemplateBlocks(template: CardTemplateDefinition, draft: NoteTypeEditorDraft): void {
        template.questionFormat = compileTemplateBlocks(
            template.questionBlocks ?? [],
            draft.fields,
        );
        template.answerFormat = compileTemplateBlocks(template.answerBlocks ?? [], draft.fields);
        template.browserFormat = compileTemplateBlocks(template.browserBlocks ?? [], draft.fields);
        const answerInput = [
            ...(template.questionBlocks ?? []),
            ...(template.answerBlocks ?? []),
        ].find((block) => block.kind === "answer-input" && block.fieldId);
        if (answerInput?.fieldId) {
            if (canonicalAnswerMode(template.answerMode) === "reveal") {
                template.answerMode = "text";
            }
            template.answerFieldId = answerInput.fieldId;
        }
    }

    private renderVisualTemplateEditor(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
    ): void {
        const editor = parent.createDiv("sr-visual-template-editor");
        editor.createEl("p", { cls: "sr-template-editor-help", text: t("VISUAL_EDITOR_HELP") });
        for (const surface of ["question", "answer", "browser"] as const) {
            const panel = editor.createDiv(`sr-visual-surface is-${surface}`);
            const header = panel.createDiv("sr-visual-surface-header");
            const copy = header.createDiv();
            copy.createEl("strong", { text: this.templateSurfaceLabel(surface) });
            copy.createSpan({ text: this.templateSurfaceHelp(surface) });
            const add = new ButtonComponent(header)
                .setIcon("plus")
                .setTooltip(t("ADD_BLOCK"))
                .onClick((event) => this.showTemplateBlockMenu(event, draft, template, surface));
            add.buttonEl.setAttribute("aria-label", t("ADD_BLOCK"));

            const blocks = this.templateBlocksForSurface(template, surface);
            const list = panel.createDiv("sr-visual-block-list");
            list.addEventListener("dragover", (event) => event.preventDefault());
            list.addEventListener("drop", (event) => {
                event.preventDefault();
                const id = event.dataTransfer?.getData("text/plain");
                const from = blocks.findIndex((block) => block.id === id);
                if (from < 0 || from === blocks.length - 1) return;
                blocks.push(blocks.splice(from, 1)[0]);
                this.syncTemplateBlocks(template, draft);
                this.render();
            });
            if (blocks.length === 0) {
                const empty = list.createDiv("sr-visual-block-empty");
                setIcon(empty.createSpan(), "blocks");
                empty.createSpan({ text: t("NO_TEMPLATE_BLOCKS") });
            }
            blocks.forEach((block, index) =>
                this.renderVisualTemplateBlock(list, draft, template, surface, block, index),
            );

            const style = panel.createEl("details", { cls: "sr-visual-surface-style" });
            style.createEl("summary", { text: t("SURFACE_STYLE") });
            this.createTemplateCssEditor(
                style,
                t("SURFACE_STYLE"),
                surface === "question"
                    ? (template.questionCss ?? "")
                    : surface === "answer"
                      ? (template.answerCss ?? "")
                      : (template.browserCss ?? ""),
                (value) => {
                    if (surface === "question") template.questionCss = value;
                    else if (surface === "answer") template.answerCss = value;
                    else template.browserCss = value;
                    this.refreshTemplatePreviewFrom(panel, draft, template);
                },
            );
        }
    }

    private templateSurfaceLabel(surface: TemplateSurface): string {
        if (surface === "question") return t("CARD_TEMPLATE_QUESTION");
        if (surface === "answer") return t("CARD_TEMPLATE_ANSWER");
        return t("CARD_TEMPLATE_BROWSER");
    }

    private templateSurfaceHelp(surface: TemplateSurface): string {
        if (surface === "question") return t("QUESTION_SURFACE_HELP");
        if (surface === "answer") return t("ANSWER_SURFACE_HELP");
        return t("BROWSER_SURFACE_HELP");
    }

    private showTemplateBlockMenu(
        event: MouseEvent,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
        surface: TemplateSurface,
    ): void {
        const menu = new Menu();
        const kinds: Array<[TemplateBlockKind, string, string]> = [
            ["field", t("BLOCK_FIELD"), "braces"],
            ["text", t("BLOCK_TEXT"), "type"],
            ["divider", t("BLOCK_DIVIDER"), "minus"],
            ["image", t("BLOCK_IMAGE"), "image"],
            ["hint", t("BLOCK_HINT"), "lightbulb"],
            ["answer-input", t("BLOCK_ANSWER_INPUT"), "text-cursor-input"],
            ["audio", t("BLOCK_AUDIO"), "audio-lines"],
            ["tts", t("BLOCK_TTS"), "speech"],
        ];
        for (const [kind, label, icon] of kinds) {
            if (surface === "browser" && ["answer-input", "audio", "tts"].includes(kind)) continue;
            menu.addItem((item) =>
                item
                    .setTitle(label)
                    .setIcon(icon)
                    .onClick(() => {
                        const needsField = !["text", "divider"].includes(kind);
                        const block = createTemplateVisualBlock(
                            this.plugin.dataManager.collectionStore.createId("block"),
                            kind,
                            needsField ? (draft.fields[0]?.id ?? null) : null,
                        );
                        this.templateBlocksForSurface(template, surface).push(block);
                        this.syncTemplateBlocks(template, draft);
                        this.render();
                    }),
            );
        }
        menu.showAtMouseEvent(event);
    }

    private renderVisualTemplateBlock(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
        surface: TemplateSurface,
        block: TemplateVisualBlock,
        index: number,
    ): void {
        const blocks = this.templateBlocksForSurface(template, surface);
        const row = parent.createDiv(`sr-visual-block is-${block.kind}`);
        row.draggable = true;
        row.addEventListener("dragstart", (event) => {
            event.dataTransfer?.setData("text/plain", block.id);
            event.dataTransfer?.setDragImage(row, 20, 20);
            row.addClass("is-dragging");
        });
        row.addEventListener("dragend", () => row.removeClass("is-dragging"));
        row.addEventListener("dragover", (event) => event.preventDefault());
        row.addEventListener("drop", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const id = event.dataTransfer?.getData("text/plain");
            const from = blocks.findIndex((candidate) => candidate.id === id);
            if (from < 0 || from === index) return;
            const [moved] = blocks.splice(from, 1);
            blocks.splice(index, 0, moved);
            this.syncTemplateBlocks(template, draft);
            this.render();
        });
        const handle = row.createDiv("sr-visual-block-handle");
        setIcon(handle, "grip-vertical");
        const content = row.createDiv("sr-visual-block-content");
        content.createSpan({
            cls: "sr-visual-block-kind",
            text: this.templateBlockLabel(block.kind),
        });
        if (!["text", "divider"].includes(block.kind)) {
            const select = content.createEl("select", {
                cls: "dropdown",
                attr: { "aria-label": t("FIELD_NAME") },
            });
            for (const field of draft.fields) {
                select.createEl("option", { value: field.id, text: field.name });
            }
            select.value = block.fieldId ?? draft.fields[0]?.id ?? "";
            select.addEventListener("change", () => {
                block.fieldId = select.value || null;
                this.syncTemplateBlocks(template, draft);
                this.refreshTemplatePreviewFrom(row, draft, template);
            });
        }
        if (block.kind === "text") {
            const input = content.createEl("textarea", {
                cls: "sr-native-textarea",
                attr: { rows: "2", placeholder: t("BLOCK_TEXT_PLACEHOLDER") },
            });
            input.value = block.text;
            input.addEventListener("input", () => {
                block.text = input.value;
                this.syncTemplateBlocks(template, draft);
                this.refreshTemplatePreviewFrom(row, draft, template);
            });
        }
        if (block.kind === "hint") {
            const label = content.createEl("input", {
                cls: "sr-native-input",
                attr: { type: "text", placeholder: t("BLOCK_HINT_LABEL") },
            });
            label.value = block.label;
            label.addEventListener("input", () => {
                block.label = label.value;
                this.syncTemplateBlocks(template, draft);
                this.refreshTemplatePreviewFrom(row, draft, template);
            });
        }
        const condition = content.createEl("details", { cls: "sr-visual-block-condition" });
        condition.createEl("summary", { text: t("CONDITIONAL_DISPLAY") });
        const conditionBody = condition.createDiv("sr-visual-block-condition-body");
        const operator = conditionBody.createEl("select", { cls: "dropdown" });
        for (const [value, label] of [
            ["always", t("TEMPLATE_CONDITION_ALWAYS")],
            ["not-empty", t("TEMPLATE_CONDITION_NOT_EMPTY")],
            ["empty", t("TEMPLATE_CONDITION_EMPTY")],
            ["equals", t("TEMPLATE_CONDITION_EQUALS")],
            ["not-equals", t("TEMPLATE_CONDITION_NOT_EQUALS")],
        ] as const) {
            operator.createEl("option", { value, text: label });
        }
        operator.value = block.condition.operator;
        operator.addEventListener("change", () => {
            block.condition.operator = operator.value as typeof block.condition.operator;
            if (block.condition.operator !== "always" && !block.condition.fieldId) {
                block.condition.fieldId = draft.fields[0]?.id ?? null;
            }
            this.syncTemplateBlocks(template, draft);
            this.render();
        });
        if (block.condition.operator !== "always") {
            const field = conditionBody.createEl("select", { cls: "dropdown" });
            for (const definition of draft.fields) {
                field.createEl("option", { value: definition.id, text: definition.name });
            }
            field.value = block.condition.fieldId ?? draft.fields[0]?.id ?? "";
            field.addEventListener("change", () => {
                block.condition.fieldId = field.value || null;
                this.syncTemplateBlocks(template, draft);
                this.refreshTemplatePreviewFrom(row, draft, template);
            });
        }
        if (["equals", "not-equals"].includes(block.condition.operator)) {
            const expected = conditionBody.createEl("input", {
                cls: "sr-native-input",
                attr: { type: "text", placeholder: t("CONDITION_VALUE") },
            });
            expected.value = block.condition.value;
            expected.addEventListener("input", () => {
                block.condition.value = expected.value;
                this.syncTemplateBlocks(template, draft);
                this.refreshTemplatePreviewFrom(row, draft, template);
            });
        }
        const actions = row.createDiv("sr-visual-block-actions");
        for (const [icon, delta, label] of [
            ["chevron-up", -1, t("MOVE_UP")],
            ["chevron-down", 1, t("MOVE_DOWN")],
        ] as const) {
            new ButtonComponent(actions)
                .setIcon(icon)
                .setTooltip(label)
                .setDisabled(index + delta < 0 || index + delta >= blocks.length)
                .onClick(() => {
                    const [moved] = blocks.splice(index, 1);
                    blocks.splice(index + delta, 0, moved);
                    this.syncTemplateBlocks(template, draft);
                    this.render();
                });
        }
        new ButtonComponent(actions)
            .setIcon("trash-2")
            .setTooltip(t("REMOVE_BLOCK"))
            .onClick(() => {
                blocks.splice(index, 1);
                this.syncTemplateBlocks(template, draft);
                this.render();
            });
    }

    private templateBlockLabel(kind: TemplateBlockKind): string {
        const labels: Record<TemplateBlockKind, string> = {
            field: t("BLOCK_FIELD"),
            text: t("BLOCK_TEXT"),
            divider: t("BLOCK_DIVIDER"),
            image: t("BLOCK_IMAGE"),
            hint: t("BLOCK_HINT"),
            "answer-input": t("BLOCK_ANSWER_INPUT"),
            audio: t("BLOCK_AUDIO"),
            tts: t("BLOCK_TTS"),
        };
        return labels[kind];
    }

    private renderAdvancedTemplateEditor(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
    ): void {
        const editor = parent.createDiv("sr-advanced-template-editor");
        const help = editor.createDiv("sr-advanced-template-help");
        help.createEl("strong", { text: t("ADVANCED_EDITOR") });
        help.createSpan({ text: t("ADVANCED_EDITOR_HELP") });
        this.createTemplateTextarea(
            editor,
            t("QUESTION_TEMPLATE"),
            template.questionFormat,
            draft,
            (value) => {
                template.questionFormat = value;
                template.questionBlocks = [];
                this.refreshTemplatePreviewFrom(editor, draft, template);
            },
        );
        this.createTemplateTextarea(
            editor,
            t("ANSWER_TEMPLATE"),
            template.answerFormat,
            draft,
            (value) => {
                template.answerFormat = value;
                template.answerBlocks = [];
                this.refreshTemplatePreviewFrom(editor, draft, template);
            },
        );
        this.createTemplateTextarea(
            editor,
            t("BROWSER_TEMPLATE"),
            template.browserFormat ?? template.questionFormat,
            draft,
            (value) => {
                template.browserFormat = value;
                template.browserBlocks = [];
                this.refreshTemplatePreviewFrom(editor, draft, template);
            },
        );
        const css = editor.createEl("details", { cls: "sr-advanced-css-editor" });
        css.createEl("summary", { text: t("SURFACE_STYLES") });
        for (const [surface, label, value] of [
            ["question", t("QUESTION_STYLE"), template.questionCss ?? ""],
            ["answer", t("ANSWER_STYLE"), template.answerCss ?? ""],
            ["browser", t("BROWSER_STYLE"), template.browserCss ?? ""],
        ] as const) {
            this.createTemplateCssEditor(css, label, value, (next) => {
                if (surface === "question") template.questionCss = next;
                else if (surface === "answer") template.answerCss = next;
                else template.browserCss = next;
                this.refreshTemplatePreviewFrom(editor, draft, template);
            });
        }
        const reference = editor.createEl("details", { cls: "sr-template-reference" });
        reference.createEl("summary", { text: t("TEMPLATE_REFERENCE") });
        reference.createEl("code", {
            text: "{{Field}}  {{#Field}}…{{/Field}}  {{^Field}}…{{/Field}}  {{FrontSide}}  {{upper:Field}}  {{lower:Field}}  {{text:Field}}  {{tts:Field}}",
        });
    }

    private createTemplateCssEditor(
        parent: HTMLElement,
        label: string,
        value: string,
        onChange: (value: string) => void,
    ): void {
        const control = parent.createEl("label", { cls: "sr-note-template-control" });
        control.createSpan({ text: label });
        const input = control.createEl("textarea", {
            cls: "sr-native-textarea sr-template-css-input",
            attr: {
                rows: "3",
                spellcheck: "false",
                placeholder: "font-size: 1.05em;",
            },
        });
        input.value = value;
        input.addEventListener("input", () => {
            onChange(input.value);
            this.clearError();
        });
    }

    private renderTemplateCondition(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
    ): void {
        const condition = template.condition ?? {
            operator: "always" as const,
            fieldId: null,
            value: "",
        };
        template.condition = condition;
        this.createTemplateSelect(
            parent,
            t("TEMPLATE_CREATION_RULE"),
            condition.operator,
            [
                ["always", t("TEMPLATE_CONDITION_ALWAYS")],
                ["not-empty", t("TEMPLATE_CONDITION_NOT_EMPTY")],
                ["empty", t("TEMPLATE_CONDITION_EMPTY")],
                ["equals", t("TEMPLATE_CONDITION_EQUALS")],
                ["not-equals", t("TEMPLATE_CONDITION_NOT_EQUALS")],
            ],
            (value) => (condition.operator = value as typeof condition.operator),
        );
        if (condition.operator === "always") return;
        this.createTemplateSelect(
            parent,
            t("FIELD_NAME"),
            condition.fieldId ?? draft.fields[0]?.id ?? "",
            draft.fields.map((field) => [field.id, field.name]),
            (value) => (condition.fieldId = value || null),
        );
        if (condition.operator === "equals" || condition.operator === "not-equals") {
            const value = parent.createEl("label", { cls: "sr-note-template-control" });
            value.createSpan({ text: t("TEMPLATE_CONDITION_EQUALS") });
            const input = value.createEl("input", {
                cls: "sr-native-input",
                attr: { type: "text" },
            });
            input.value = condition.value;
            input.addEventListener("input", () => (condition.value = input.value));
        }
    }

    private createTemplateTextarea(
        parent: HTMLElement,
        label: string,
        value: string,
        draft: NoteTypeEditorDraft,
        onChange: (value: string) => void,
    ): void {
        const field = parent.createDiv("sr-note-template-field");
        const header = field.createDiv("sr-note-template-field-header");
        header.createEl("label", { text: label });
        const tokens = header.createDiv("sr-note-template-tokens");
        const textarea = field.createEl("textarea", {
            cls: "sr-native-textarea sr-note-template-textarea",
            attr: { rows: "3", spellcheck: "false" },
        });
        textarea.value = value;
        for (const noteField of draft.fields) {
            const token = tokens.createEl("button", {
                text: noteField.name,
                attr: { type: "button", title: t("INSERT_FIELD") },
            });
            token.addEventListener("click", () => {
                const insertion = `{{${noteField.name}}}`;
                const start = textarea.selectionStart;
                const end = textarea.selectionEnd;
                textarea.setRangeText(insertion, start, end, "end");
                onChange(textarea.value);
                textarea.focus();
                this.clearError();
            });
        }
        const frontSide = tokens.createEl("button", {
            text: "FrontSide",
            attr: { type: "button", title: t("INSERT_FRONT_SIDE") },
        });
        frontSide.addEventListener("click", () => {
            textarea.setRangeText(
                "{{FrontSide}}",
                textarea.selectionStart,
                textarea.selectionEnd,
                "end",
            );
            onChange(textarea.value);
            textarea.focus();
        });
        const filters = tokens.createEl("select", {
            cls: "dropdown sr-template-filter-picker",
            attr: { "aria-label": t("FIELD_FILTERS") },
        });
        filters.createEl("option", { value: "", text: t("FIELD_FILTERS") });
        const defaultField = draft.fields[0]?.name ?? "Field";
        for (const [value, text] of [
            [`{{upper:${defaultField}}}`, "UPPER"],
            [`{{lower:${defaultField}}}`, "lower"],
            [`{{trim:${defaultField}}}`, "trim"],
            [`{{text:${defaultField}}}`, t("PLAIN_TEXT_FILTER")],
            [`{{tts:${defaultField}}}`, "TTS"],
        ]) {
            filters.createEl("option", { value, text });
        }
        filters.addEventListener("change", () => {
            if (!filters.value) return;
            textarea.setRangeText(
                filters.value,
                textarea.selectionStart,
                textarea.selectionEnd,
                "end",
            );
            onChange(textarea.value);
            filters.value = "";
            textarea.focus();
        });
        textarea.addEventListener("input", () => {
            onChange(textarea.value);
            this.clearError();
        });
    }

    private renderTemplatePreview(
        parent: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
    ): void {
        parent.empty();
        const toolbar = parent.createDiv("sr-note-template-preview-toolbar");
        toolbar.createEl("strong", { text: t("LIVE_PREVIEW") });
        const controls = toolbar.createDiv("sr-note-template-preview-controls");
        for (const [value, icon, label] of [
            ["phone", "smartphone", t("PREVIEW_IPHONE")],
            ["desktop", "monitor", t("PREVIEW_DESKTOP")],
        ] as const) {
            const button = new ButtonComponent(controls)
                .setIcon(icon)
                .setTooltip(label)
                .onClick(() => {
                    this.templatePreviewDevice = value;
                    this.renderTemplatePreview(parent, draft, template);
                });
            button.buttonEl.toggleClass("is-active", this.templatePreviewDevice === value);
        }
        for (const [value, icon, label] of [
            ["light", "sun", t("PREVIEW_LIGHT")],
            ["dark", "moon", t("PREVIEW_DARK")],
        ] as const) {
            const button = new ButtonComponent(controls)
                .setIcon(icon)
                .setTooltip(label)
                .onClick(() => {
                    this.templatePreviewTheme = value;
                    this.renderTemplatePreview(parent, draft, template);
                });
            button.buttonEl.toggleClass("is-active", this.templatePreviewTheme === value);
        }
        const sampleFields = this.getTemplatePreviewFields(draft);
        for (const field of draft.fields) {
            sampleFields[field.name] = sampleFields[field.id] ?? field.name;
        }
        const question = renderNoteTypeTemplate(
            template.questionFormat,
            draft as NoteTypeDefinition,
            sampleFields,
        );
        const faces = parent.createDiv(
            `sr-note-template-preview-faces is-${this.templatePreviewDevice} theme-${this.templatePreviewTheme}`,
        );
        for (const [surface, label, value] of [
            ["question", t("CARD_TEMPLATE_QUESTION"), question],
            [
                "answer",
                t("CARD_TEMPLATE_ANSWER"),
                renderNoteTypeTemplate(
                    template.answerFormat,
                    draft as NoteTypeDefinition,
                    sampleFields,
                    question,
                ),
            ],
            [
                "browser",
                t("CARD_TEMPLATE_BROWSER"),
                renderNoteTypeTemplate(
                    template.browserFormat ?? template.questionFormat,
                    draft as NoteTypeDefinition,
                    sampleFields,
                    question,
                ),
            ],
        ] as const) {
            const face = faces.createDiv("sr-note-template-preview-face");
            face.createSpan({ text: label });
            const body = face.createDiv("sr-note-template-preview-body");
            body.dataset.templateCss = template.css ?? "";
            this.applyPreviewCss(body, [
                draft.css,
                template.css ?? "",
                surface === "question"
                    ? (template.questionCss ?? "")
                    : surface === "answer"
                      ? (template.answerCss ?? "")
                      : (template.browserCss ?? ""),
            ]);
            void MarkdownRenderer.render(this.app, value, body, "", this).then(() =>
                this.bindPreviewTemplateActions(body),
            );
        }
        const samples = parent.createEl("details", { cls: "sr-template-preview-data" });
        samples.createEl("summary", { text: t("PREVIEW_DATA") });
        const grid = samples.createDiv("sr-template-preview-data-grid");
        for (const field of draft.fields) {
            const control = grid.createEl("label");
            control.createSpan({ text: field.name });
            const input = control.createEl("input", {
                cls: "sr-native-input",
                attr: { type: "text" },
            });
            input.value = sampleFields[field.id] ?? "";
            input.addEventListener("change", () => {
                this.templatePreviewValues[field.id] = input.value;
                this.renderTemplatePreview(parent, draft, template);
            });
        }
    }

    private refreshTemplatePreviewFrom(
        element: HTMLElement,
        draft: NoteTypeEditorDraft,
        template: CardTemplateDefinition,
    ): void {
        const preview = element
            .closest(".sr-note-template-card")
            ?.querySelector<HTMLElement>(".sr-note-template-preview");
        if (preview) this.renderTemplatePreview(preview, draft, template);
    }

    private getTemplatePreviewFields(draft: NoteTypeEditorDraft): Record<string, string> {
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const realNote = Object.values(snapshot.notes).find(
            (note) => !note.deletedAt && note.noteTypeId === draft.id,
        );
        return Object.fromEntries(
            draft.fields.map((field) => [
                field.id,
                this.templatePreviewValues[field.id] ??
                    realNote?.fields[field.id] ??
                    this.previewPlaceholderForField(field),
            ]),
        );
    }

    private previewPlaceholderForField(field: NoteFieldDefinition): string {
        if (field.kind === "number") return "42";
        if (field.kind === "formula") return "$E = mc^2$";
        if (field.kind === "media") return "";
        return field.name;
    }

    private applyPreviewCss(element: HTMLElement, values: string[]): void {
        const declarations = values.filter((value) => value.trim() && !value.includes("{"));
        if (declarations.length > 0) element.setAttribute("style", declarations.join(";"));
        const rules = values.filter((value) => value.includes("{"));
        if (rules.length === 0) return;
        const scope = `sr-preview-scope-${Math.random().toString(36).slice(2, 9)}`;
        element.addClass(scope);
        const selector = `.${scope}`;
        const css = rules
            .join("\n")
            .replaceAll("{{card}}", selector)
            .replaceAll("{{front}}", selector)
            .replaceAll("{{back}}", selector)
            .replaceAll("{{browser}}", selector)
            .replace(/(^|})(\s*)([^@}{][^{]*){/g, (_match, boundary, space, selectors) => {
                const scoped = String(selectors)
                    .split(",")
                    .map((candidate) => `${selector} ${candidate.trim()}`)
                    .join(", ");
                return `${boundary}${space}${scoped}{`;
            });
        element.createEl("style", { text: css });
    }

    private bindPreviewTemplateActions(root: HTMLElement): void {
        for (const button of root.querySelectorAll<HTMLElement>(".sr-template-tts")) {
            button.addEventListener("click", (event) => {
                event.preventDefault();
                const encoded = button.dataset.srTts;
                if (!encoded || !("speechSynthesis" in window)) return;
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(
                    new SpeechSynthesisUtterance(decodeURIComponent(encoded)),
                );
            });
        }
    }

    private renderNoteTypeStyleEditor(parent: HTMLElement, draft: NoteTypeEditorDraft): void {
        const section = parent.createDiv("sr-note-type-section sr-note-style-section");
        const heading = section.createDiv("sr-note-type-section-heading");
        const copy = heading.createDiv();
        copy.createEl("h3", { text: t("CARD_APPEARANCE") });
        copy.createEl("p", { text: t("CARD_APPEARANCE_HELP") });
        const presets = section.createDiv("sr-note-style-presets");
        for (const [label, css] of [
            [t("STYLE_DEFAULT"), ""],
            [t("STYLE_CENTERED"), "text-align: center; font-size: 1.15em;"],
            [t("STYLE_COMPACT"), "font-size: .92em; line-height: 1.35;"],
            [
                t("STYLE_READING"),
                "font-size: 1.08em; line-height: 1.7; max-width: 42rem; margin: auto;",
            ],
        ] as const) {
            const button = new ButtonComponent(presets).setButtonText(label).onClick(() => {
                draft.css = css;
                this.render();
            });
            button.buttonEl.toggleClass("is-active", draft.css === css);
        }
        const textarea = section.createEl("textarea", {
            cls: "sr-native-textarea sr-note-style-textarea",
            attr: { rows: "4", spellcheck: "false", placeholder: "font-size: 1.1em;" },
        });
        textarea.value = draft.css;
        textarea.addEventListener("change", () => {
            draft.css = textarea.value;
            this.render();
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
        const fields: NoteFieldDefinition[] = [
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
        ];
        return {
            id: store.createId("notetype"),
            version: 1,
            name: "",
            kind: "standard",
            fields,
            templates: [this.createEmptyTemplate(0, fields)],
            css: "",
        };
    }

    private createEmptyTemplate(
        ordinal: number,
        fields: NoteFieldDefinition[] = this.noteTypeDraft?.fields ?? [],
    ): CardTemplateDefinition {
        const front = fields[0]?.name ?? t("CARD_FRONT");
        const back = fields[1]?.name ?? fields[0]?.name ?? t("CARD_BACK");
        const createBlock = (kind: TemplateBlockKind, fieldId: string | null = null) =>
            createTemplateVisualBlock(
                this.plugin.dataManager.collectionStore.createId("block"),
                kind,
                fieldId,
            );
        return {
            id: this.plugin.dataManager.collectionStore.createId("template"),
            version: 1,
            name: `${t("CARD")} ${ordinal + 1}`,
            ordinal,
            questionFormat: `{{${front}}}`,
            answerFormat: `{{${back}}}`,
            deckOverride: null,
            enabled: true,
            generator: "standard",
            answerMode: "reveal",
            answerConfig: createDefaultAnswerConfig(),
            answerFieldId: null,
            sourceFieldId: null,
            condition: { operator: "always", fieldId: null, value: "" },
            css: "",
            editorMode: "visual",
            questionBlocks: [createBlock("field", fields[0]?.id ?? null)],
            answerBlocks: [createBlock("field", fields[1]?.id ?? fields[0]?.id ?? null)],
            browserBlocks: [createBlock("field", fields[0]?.id ?? null)],
            browserFormat: `{{${front}}}`,
            questionCss: "",
            answerCss: "",
            browserCss: "",
        };
    }

    private noteTypeToDraft(noteType: NoteTypeDefinition): NoteTypeEditorDraft {
        return {
            id: noteType.id,
            version: noteType.version,
            name: noteType.name,
            kind: noteType.kind,
            fields: noteType.fields.map((field) => ({ ...field })),
            templates: noteType.templates.map((template) => ({
                ...template,
                condition: template.condition ? { ...template.condition } : undefined,
                questionBlocks: template.questionBlocks?.map((block) => ({
                    ...block,
                    condition: { ...block.condition },
                })),
                answerBlocks: template.answerBlocks?.map((block) => ({
                    ...block,
                    condition: { ...block.condition },
                })),
                browserBlocks: template.browserBlocks?.map((block) => ({
                    ...block,
                    condition: { ...block.condition },
                })),
            })),
            css: noteType.css,
        };
    }

    private cloneNoteTypeDraft(noteType: NoteTypeDefinition): NoteTypeEditorDraft {
        const store = this.plugin.dataManager.collectionStore;
        const fieldIdMap = new Map(
            noteType.fields.map((field) => [field.id, store.createId("field")]),
        );
        const cloneBlock = (block: TemplateVisualBlock): TemplateVisualBlock => ({
            ...block,
            id: store.createId("block"),
            fieldId: block.fieldId ? (fieldIdMap.get(block.fieldId) ?? null) : null,
            condition: {
                ...block.condition,
                fieldId: block.condition.fieldId
                    ? (fieldIdMap.get(block.condition.fieldId) ?? null)
                    : null,
            },
        });
        const remapFormat = (format: string): string => {
            let result = format;
            for (const [from, to] of fieldIdMap) result = result.replaceAll(from, to);
            return result;
        };
        return {
            id: store.createId("notetype"),
            version: 1,
            name: `${noteType.name} — ${t("COPY")}`,
            kind: noteType.kind,
            fields: noteType.fields.map((field, ordinal) => ({
                ...field,
                id: fieldIdMap.get(field.id) ?? store.createId("field"),
                ordinal,
            })),
            templates: noteType.templates.map((template, ordinal) => ({
                ...template,
                id: store.createId("template"),
                version: 1,
                ordinal,
                questionFormat: remapFormat(template.questionFormat),
                answerFormat: remapFormat(template.answerFormat),
                browserFormat: template.browserFormat
                    ? remapFormat(template.browserFormat)
                    : undefined,
                answerFieldId: template.answerFieldId
                    ? (fieldIdMap.get(template.answerFieldId) ?? null)
                    : null,
                answerConfig: template.answerConfig
                    ? {
                          ...normalizeAnswerConfig(template.answerConfig),
                          parts: normalizeAnswerConfig(template.answerConfig).parts.map((part) => ({
                              ...part,
                              id: store.createId("answer-part"),
                              answerFieldId: part.answerFieldId
                                  ? (fieldIdMap.get(part.answerFieldId) ?? null)
                                  : null,
                          })),
                          choices: normalizeAnswerConfig(template.answerConfig).choices.map(
                              (choice) => ({ ...choice, id: store.createId("choice") }),
                          ),
                      }
                    : createDefaultAnswerConfig(),
                sourceFieldId: template.sourceFieldId
                    ? (fieldIdMap.get(template.sourceFieldId) ?? null)
                    : null,
                condition: template.condition
                    ? {
                          ...template.condition,
                          fieldId: template.condition.fieldId
                              ? (fieldIdMap.get(template.condition.fieldId) ?? null)
                              : null,
                      }
                    : undefined,
                questionBlocks: template.questionBlocks?.map(cloneBlock),
                answerBlocks: template.answerBlocks?.map(cloneBlock),
                browserBlocks: template.browserBlocks?.map(cloneBlock),
            })),
            css: noteType.css,
        };
    }

    private async saveNoteType(): Promise<void> {
        const draft = this.noteTypeDraft;
        if (!draft) return;
        for (const template of draft.templates) {
            if ((template.editorMode ?? "advanced") === "visual") {
                this.syncTemplateBlocks(template, draft);
            }
        }
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
        const validationIssues = draft.templates.flatMap((template) =>
            validateTemplateDesign(template, draft.fields),
        );
        if (validationIssues.length > 0) {
            const first = validationIssues[0];
            this.error = t("TEMPLATE_VALIDATION_FAILED", {
                details: first.field ? `${first.code}: ${first.field}` : first.code,
            });
            this.render();
            return;
        }
        const definition: NoteTypeEditorDraft = {
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
        };
        const preview = this.plugin.dataManager.collectionStore.previewNoteTypeChange(definition);
        if (
            preview.affectedNotes > 0 &&
            (preview.createdCards > 0 || preview.retiredCards > 0 || preview.changedTemplates > 0)
        ) {
            new ConfirmationModal(
                this.app,
                t("NOTE_TYPE_CHANGE_PREVIEW"),
                t("NOTE_TYPE_CHANGE_PREVIEW_DESC", {
                    notes: preview.affectedNotes,
                    preserved: preview.preservedCards,
                    created: preview.createdCards,
                    retired: preview.retiredCards,
                }),
                t("NOTE_TYPE_CHANGE_CONFIRMED"),
                () => this.commitNoteType(definition),
            ).open();
            return;
        }
        await this.commitNoteType(definition);
    }

    private async commitNoteType(definition: NoteTypeEditorDraft): Promise<void> {
        this.busy = true;
        this.error = "";
        this.render();
        try {
            await this.plugin.dataManager.collectionStore.saveNoteType(definition);
            await this.store.refreshStructuredNotesForType(definition.id);
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

    private createRichTextEditor(
        parent: HTMLElement,
        value: string,
        placeholder: string,
        label: string,
        target: MediaTarget,
        onChange: (value: string) => void,
    ): HTMLDivElement {
        const shell = parent.createDiv("sr-native-rich-editor");
        const toolbar = shell.createDiv("sr-native-rich-toolbar");
        const editor = shell.createDiv({
            cls: "sr-native-rich-content",
            attr: {
                contenteditable: "true",
                role: "textbox",
                "aria-label": label,
                "aria-multiline": "true",
                "data-placeholder": placeholder,
                spellcheck: "true",
                enterkeyhint: target === "front" ? "next" : "done",
            },
        });
        editor.append(
            editor.ownerDocument.createRange().createContextualFragment(this.editorHtml(value)),
        );
        const preview = shell.createDiv("sr-native-rich-preview");
        preview.hidden = true;

        const commands: Array<[string, string, string, string?]> = [
            ["bold", "bold", t("FORMAT_BOLD")],
            ["italic", "italic", t("FORMAT_ITALIC")],
            ["insertUnorderedList", "list", t("FORMAT_LIST")],
            ["formatBlock", "code-2", t("FORMAT_CODE"), "pre"],
        ];
        for (const [command, iconName, tooltip, commandValue] of commands) {
            const button = new ButtonComponent(toolbar).setIcon(iconName).setTooltip(tooltip);
            button.buttonEl.addClass("sr-native-format-button");
            button.buttonEl.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                editor.focus();
                editor.ownerDocument.execCommand(command, false, commandValue);
                onChange(this.readEditorValue(editor));
                this.saveDraft();
            });
        }
        const latex = new ButtonComponent(toolbar).setIcon("sigma").setTooltip("LaTeX");
        latex.buttonEl.addClass("sr-native-format-button");
        latex.buttonEl.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            editor.focus();
            const selected = editor.ownerDocument.getSelection()?.toString() ?? "";
            editor.ownerDocument.execCommand("insertText", false, `$${selected}$`);
            onChange(this.readEditorValue(editor));
            this.saveDraft();
        });
        if (
            (this.cardType === "cloze" || this.getSelectedNoteType().kind === "cloze") &&
            (target === "front" || target.toString().startsWith("field:"))
        ) {
            const cloze = new ButtonComponent(toolbar)
                .setIcon("scan-text")
                .setTooltip(t("CARD_TYPE_CLOZE"));
            cloze.buttonEl.addClass("sr-native-format-button");
            cloze.buttonEl.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                const selected = editor.ownerDocument.getSelection()?.toString().trim() ?? "";
                if (!selected) return;
                if (this.getSelectedNoteType().id.startsWith("builtin-")) {
                    this.front = this.readEditorValue(editor);
                    this.back = selected;
                } else {
                    editor.focus();
                    editor.ownerDocument.execCommand("insertText", false, `{{c1::${selected}}}`);
                    onChange(this.readEditorValue(editor));
                }
                this.saveDraft();
                this.render();
            });
            const batch = new ButtonComponent(toolbar)
                .setIcon("list-plus")
                .setTooltip(
                    this.creatorText("Create clozes from highlights", "Создать cloze из выделений"),
                );
            batch.buttonEl.addClass("sr-native-format-button");
            batch.buttonEl.addEventListener("pointerdown", (event) => {
                event.preventDefault();
                const seeds = extractBatchClozeSeeds(this.readEditorValue(editor));
                if (seeds.length === 0) {
                    new Notice(
                        this.creatorText(
                            "Bold or highlight the answers first.",
                            "Сначала выделите ответы жирным или маркером.",
                        ),
                    );
                    return;
                }
                this.rememberCardState();
                this.quickAddQueue = [...seeds.slice(1), ...this.quickAddQueue];
                this.applyQuickAddSeed(seeds[0]);
                this.render();
            });
        }
        this.renderMediaPicker(toolbar, target, true);
        const spacer = toolbar.createSpan("sr-native-rich-toolbar-spacer");
        spacer.setAttribute("aria-hidden", "true");
        const previewButton = new ButtonComponent(toolbar)
            .setIcon("eye")
            .setTooltip(t("PREVIEW_CARD_FIELD"));
        previewButton.buttonEl.addClass("sr-native-format-button");
        previewButton.onClick(() => {
            const willPreview = preview.hidden;
            preview.hidden = !willPreview;
            editor.hidden = willPreview;
            previewButton.buttonEl.toggleClass("is-active", willPreview);
            if (!willPreview) {
                editor.focus();
                return;
            }
            preview.empty();
            void MarkdownRenderer.render(
                this.app,
                this.readEditorValue(editor),
                preview,
                this.editingCard?.question.note.filePath ?? "",
                this,
            );
        });

        editor.addEventListener("input", () => {
            onChange(this.readEditorValue(editor));
            this.clearError();
            this.saveDraft();
        });
        editor.addEventListener("focus", () => {
            this.fieldEditStart = this.captureCardState();
        });
        editor.addEventListener("blur", () => {
            if (
                this.fieldEditStart &&
                !this.sameCardState(this.fieldEditStart, this.captureCardState())
            ) {
                this.rememberCardState(this.fieldEditStart);
            }
            this.fieldEditStart = null;
        });
        editor.addEventListener("keydown", (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onChange(this.readEditorValue(editor));
                void this.saveCurrentCard(event.shiftKey);
            } else if (
                (event.metaKey || event.ctrlKey) &&
                event.shiftKey &&
                event.key.toLowerCase() === "p"
            ) {
                event.preventDefault();
                onChange(this.readEditorValue(editor));
                this.showCardPreview = !this.showCardPreview;
                this.render();
            } else if (event.key === "Escape") {
                editor.blur();
            }
        });
        const addDroppedFiles = (files: FileList | File[]): boolean => {
            const media = Array.from(files).filter(
                (file) =>
                    file.type.startsWith("image/") ||
                    file.type.startsWith("audio/") ||
                    file.type.startsWith("video/"),
            );
            if (media.length === 0) return false;
            for (const file of media) {
                const objectUrl = URL.createObjectURL(file);
                this.pendingMedia.push({
                    id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    file,
                    target,
                    objectUrl,
                });
                if (file.type.startsWith("image/")) {
                    editor.createEl("img", {
                        cls: "sr-native-inline-attachment",
                        attr: {
                            src: objectUrl,
                            alt: file.name,
                            contenteditable: "false",
                            "data-sr-attachment": "true",
                        },
                    });
                }
            }
            onChange(this.readEditorValue(editor));
            this.saveDraft();
            return true;
        };
        editor.addEventListener("paste", (event) => {
            if (event.clipboardData && addDroppedFiles(event.clipboardData.files)) {
                event.preventDefault();
            }
        });
        editor.addEventListener("dragover", (event) => event.preventDefault());
        editor.addEventListener("drop", (event) => {
            if (event.dataTransfer && addDroppedFiles(event.dataTransfer.files)) {
                event.preventDefault();
            }
        });
        this.renderMediaAttachmentList(parent, target);
        return editor;
    }

    private editorHtml(value: string): string {
        if (!value) return "";
        return /<\/?[a-z][^>]*>/i.test(value) ? value : escapeHtml(value).replace(/\n/g, "<br>");
    }

    private readEditorValue(editor: HTMLElement): string {
        const clone = editor.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[data-sr-attachment]").forEach((element) => element.remove());
        const html = clone.innerHTML.trim();
        return html === "<br>" ? "" : html;
    }

    private creatorText(english: string, russian: string): string {
        return (activeDocument.documentElement.lang || navigator.language)
            .toLocaleLowerCase()
            .startsWith("ru")
            ? russian
            : english;
    }

    private applyQuickAddSeed(seed: QuickAddSeed): void {
        this.front = seed.front;
        this.back = seed.back;
        this.cardType = seed.type;
        this.selectedNoteTypeId = this.noteTypeIdForCardType(seed.type);
        this.customFieldValues = {};
        this.answerMode = "reveal";
        this.saveDraft();
    }

    private captureCardState(): CardEditorSnapshot {
        return {
            front: this.front,
            back: this.back,
            deckPath: this.selectedDeck,
            noteTypeId: this.selectedNoteTypeId,
            cardType: this.cardType,
            answerMode: this.answerMode,
            tagsText: this.tagsText,
            customFieldValues: { ...this.customFieldValues },
        };
    }

    private sameCardState(left: CardEditorSnapshot, right: CardEditorSnapshot): boolean {
        return JSON.stringify(left) === JSON.stringify(right);
    }

    private rememberCardState(snapshot = this.captureCardState()): void {
        const previous = this.cardUndoStack[this.cardUndoStack.length - 1];
        if (!previous || !this.sameCardState(previous, snapshot)) {
            this.cardUndoStack.push(snapshot);
            if (this.cardUndoStack.length > 40) this.cardUndoStack.shift();
        }
        this.cardRedoStack = [];
    }

    private restoreCardState(snapshot: CardEditorSnapshot): void {
        this.front = snapshot.front;
        this.back = snapshot.back;
        this.selectedDeck = snapshot.deckPath;
        this.selectedNoteTypeId = snapshot.noteTypeId;
        this.cardType = snapshot.cardType;
        this.answerMode = snapshot.answerMode;
        this.tagsText = snapshot.tagsText;
        this.customFieldValues = { ...snapshot.customFieldValues };
        this.error = "";
        this.saveDraft();
        this.render();
    }

    private undoCardEdit(): void {
        const previous = this.cardUndoStack.pop();
        if (!previous) return;
        this.cardRedoStack.push(this.captureCardState());
        this.restoreCardState(previous);
    }

    private redoCardEdit(): void {
        const next = this.cardRedoStack.pop();
        if (!next) return;
        this.cardUndoStack.push(this.captureCardState());
        this.restoreCardState(next);
    }

    private stickyKey(): string {
        return `msre-creator-sticky:${this.app.vault.getName()}`;
    }

    private lastNoteTypeKey(): string {
        return `msre-last-note-type:${this.app.vault.getName()}`;
    }

    private loadStickyPreferences(): CreatorStickyPreferences {
        try {
            const value = JSON.parse(
                localStorage.getItem(this.stickyKey()) ?? "null",
            ) as Partial<CreatorStickyPreferences> | null;
            return {
                deck: value?.deck ?? true,
                noteType: value?.noteType ?? true,
                tags: value?.tags ?? false,
                fieldIds: Array.isArray(value?.fieldIds)
                    ? value.fieldIds.filter((id): id is string => typeof id === "string")
                    : [],
            };
        } catch {
            return { deck: true, noteType: true, tags: false, fieldIds: [] };
        }
    }

    private saveStickyPreferences(): void {
        localStorage.setItem(this.stickyKey(), JSON.stringify(this.stickyPreferences));
    }

    private toggleStickyField(fieldId: string): void {
        const fields = new Set(this.stickyPreferences.fieldIds);
        if (fields.has(fieldId)) fields.delete(fieldId);
        else fields.add(fieldId);
        this.stickyPreferences.fieldIds = [...fields];
        this.saveStickyPreferences();
        this.render();
    }

    private resetForNextCard(noteType?: NoteTypeDefinition): void {
        if (!this.stickyPreferences.fieldIds.includes("front")) this.front = "";
        if (!this.stickyPreferences.fieldIds.includes("back")) this.back = "";
        if (!this.stickyPreferences.tags) this.tagsText = "";
        if (!this.stickyPreferences.noteType) {
            this.cardType = "basic";
            this.selectedNoteTypeId = BASIC_NOTE_TYPE_ID;
        }
        if (!this.stickyPreferences.deck) this.selectedDeck = "";
        if (noteType) {
            this.customFieldValues = Object.fromEntries(
                noteType.fields.map((field) => [
                    field.id,
                    this.stickyPreferences.fieldIds.includes(field.id)
                        ? (this.customFieldValues[field.id] ?? "")
                        : "",
                ]),
            );
        }
        const next = this.quickAddQueue.shift();
        if (next) this.applyQuickAddSeed(next);
        this.cardUndoStack = [];
        this.cardRedoStack = [];
        this.clearPendingMedia();
        this.existingMedia = [];
        this.saveDraft();
    }

    private draftKey(): string {
        return `msre-native-draft:${this.app.vault.getName()}`;
    }

    private lastDeckKey(): string {
        return `msre-last-deck:${this.app.vault.getName()}`;
    }

    private recentDecksKey(): string {
        return `msre-recent-decks:${this.app.vault.getName()}`;
    }

    private lastCreatedCardKey(): string {
        return `msre-last-created-card:${this.app.vault.getName()}`;
    }

    private getLastCreatedCard():
        | (NativeCardDraft & {
              noteTypeId?: string;
              media?: Array<{ path: string; target: MediaTarget }>;
          })
        | null {
        try {
            const parsed: unknown = JSON.parse(
                localStorage.getItem(this.lastCreatedCardKey()) ?? "null",
            );
            if (!parsed || typeof parsed !== "object") return null;
            const candidate = parsed as Partial<
                NativeCardDraft & {
                    noteTypeId?: string;
                    media?: Array<{ path: string; target: MediaTarget }>;
                }
            >;
            if (typeof candidate.front !== "string" || typeof candidate.back !== "string") {
                return null;
            }
            if (
                typeof candidate.deckPath !== "string" ||
                (candidate.type !== "basic" &&
                    candidate.type !== "reversed" &&
                    candidate.type !== "cloze")
            ) {
                return null;
            }
            return candidate as NativeCardDraft & {
                noteTypeId?: string;
                media?: Array<{ path: string; target: MediaTarget }>;
            };
        } catch {
            return null;
        }
    }

    private rememberLastCreatedCard(draft: NativeCardDraft): void {
        localStorage.setItem(
            this.lastCreatedCardKey(),
            JSON.stringify({
                ...draft,
                front: this.front,
                back: this.back,
                noteTypeId: this.selectedNoteTypeId,
                media: this.existingMedia.map(({ path, target }) => ({ path, target })),
            }),
        );
    }

    private duplicateLastCreatedCard(): void {
        const card = this.getLastCreatedCard();
        if (!card) return;
        this.clearPendingMedia();
        this.request = { mode: "card", deckPath: card.deckPath };
        this.editingCard = null;
        this.selectedDeck = card.deckPath;
        this.cardType = card.type;
        this.selectedNoteTypeId = card.noteTypeId ?? this.noteTypeIdForCardType(card.type);
        this.front = card.front;
        this.back = card.back;
        this.answerMode = card.answerMode ?? "reveal";
        this.tagsText = card.tags?.join(", ") ?? "";
        this.existingMedia = (card.media ?? []).map(({ path, target }, index) => ({
            id: `duplicate-${Date.now()}-${index}`,
            path,
            target,
        }));
        this.error = "";
        this.saveDraft();
        this.render();
    }

    private countMatchingFronts(value: string): number {
        if (!this.plugin.dataManager.isOsrCoreLoaded()) return 0;
        const normalize = (candidate: string): string =>
            candidate
                .replace(/<[^>]*>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .toLocaleLowerCase();
        const front = normalize(value);
        if (!front) return 0;
        return this.plugin.dataManager.osrCore
            .getAllCards()
            .filter((card) => card !== this.editingCard && normalize(card.front) === front).length;
    }

    private rememberDeck(deckPath: string): void {
        if (!deckPath) return;
        localStorage.setItem(this.lastDeckKey(), deckPath);
        const recent = this.getRecentDecks().filter((candidate) => candidate !== deckPath);
        localStorage.setItem(
            this.recentDecksKey(),
            JSON.stringify([deckPath, ...recent].slice(0, 5)),
        );
    }

    private getRecentDecks(): string[] {
        try {
            const parsed: unknown = JSON.parse(localStorage.getItem(this.recentDecksKey()) ?? "[]");
            return Array.isArray(parsed)
                ? parsed.filter((value): value is string => typeof value === "string")
                : [];
        } catch {
            return [];
        }
    }

    private sortDecksByRecent(decks: string[]): string[] {
        const order = new Map(this.getRecentDecks().map((deck, index) => [deck, index]));
        return [...decks].sort((left, right) => {
            const leftRank = order.get(left) ?? Number.MAX_SAFE_INTEGER;
            const rightRank = order.get(right) ?? Number.MAX_SAFE_INTEGER;
            return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
        });
    }

    private saveDraft(): void {
        if (this.editingCard || this.request.mode !== "card") return;
        localStorage.setItem(
            this.draftKey(),
            JSON.stringify({
                front: this.front,
                back: this.back,
                deckPath: this.selectedDeck,
                cardType: this.cardType,
                selectedNoteTypeId: this.selectedNoteTypeId,
                answerMode: this.answerMode,
                tagsText: this.tagsText,
                customFieldValues: this.customFieldValues,
            }),
        );
    }

    private restoreDraft(): void {
        this.draftRestored = true;
        try {
            const raw = localStorage.getItem(this.draftKey());
            if (!raw) {
                this.selectedDeck ||= localStorage.getItem(this.lastDeckKey()) ?? "";
                const lastType = localStorage.getItem(this.lastNoteTypeKey());
                if (lastType && this.plugin.dataManager.collectionStore.getNoteType(lastType)) {
                    this.selectedNoteTypeId = lastType;
                    this.cardType =
                        lastType === REVERSED_NOTE_TYPE_ID
                            ? "reversed"
                            : lastType === CLOZE_NOTE_TYPE_ID
                              ? "cloze"
                              : "basic";
                }
                return;
            }
            const draft = JSON.parse(raw) as {
                front?: string;
                back?: string;
                deckPath?: string;
                cardType?: NativeCardType;
                selectedNoteTypeId?: string;
                cardVariants?: NativeCardType[];
                answerMode?: "reveal" | "type";
                tagsText?: string;
                customFieldValues?: Record<string, string>;
            };
            this.front = draft.front ?? "";
            this.back = draft.back ?? "";
            this.selectedDeck = draft.deckPath ?? this.selectedDeck;
            const restoredType =
                draft.cardType ??
                draft.cardVariants?.find((type) => type === "cloze") ??
                draft.cardVariants?.[0] ??
                "basic";
            this.cardType = restoredType;
            this.selectedNoteTypeId =
                draft.selectedNoteTypeId ?? this.noteTypeIdForCardType(restoredType);
            this.answerMode = draft.answerMode ?? "reveal";
            this.tagsText = draft.tagsText ?? "";
            this.customFieldValues = draft.customFieldValues ?? {};
            if (this.front || this.back) new Notice(t("DRAFT_RESTORED"));
        } catch {
            localStorage.removeItem(this.draftKey());
        }
    }

    private clearDraft(): void {
        localStorage.removeItem(this.draftKey());
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
        input.addEventListener("focus", () => {
            this.fieldEditStart = this.captureCardState();
        });
        input.addEventListener("input", () => {
            this.tagsText = input.value;
            this.saveDraft();
        });
        input.addEventListener("blur", () => {
            if (
                this.fieldEditStart &&
                !this.sameCardState(this.fieldEditStart, this.captureCardState())
            ) {
                this.rememberCardState(this.fieldEditStart);
            }
            this.fieldEditStart = null;
        });
    }

    private getTags(): string[] {
        return this.tagsText
            .split(/[\s,]+/)
            .map((tag) => tag.trim().replace(/^#+/, ""))
            .filter(Boolean);
    }

    private openDeckMenu(_event: MouseEvent): void {
        new DeckPickerModal(this.app, {
            decks: this.sortDecksByRecent(this.store.getDeckPaths()),
            current: this.selectedDeck,
            onChoose: (deckPath) => {
                this.rememberCardState();
                this.selectedDeck = deckPath;
                this.rememberDeck(deckPath);
                this.saveDraft();
                this.render();
            },
            onCreate: async (deckPath) => await this.store.createDeck(deckPath),
        }).open();
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

    private getNativeCardTypeLabel(type: NativeCardType): string {
        if (type === "reversed") return t("CARD_TYPE_REVERSED");
        if (type === "cloze") return t("CARD_TYPE_CLOZE");
        return t("CARD_TYPE_BASIC");
    }

    private noteTypeIdForCardType(type: NativeCardType): string {
        if (type === "reversed") return REVERSED_NOTE_TYPE_ID;
        if (type === "cloze") return CLOZE_NOTE_TYPE_ID;
        return BASIC_NOTE_TYPE_ID;
    }

    private openNoteTypeMenu(event: MouseEvent): void {
        const menu = new Menu();
        for (const noteType of this.plugin.dataManager.collectionStore.getNoteTypes()) {
            if (this.editingStructuredNote && noteType.kind === "image-occlusion") continue;
            menu.addItem((item) =>
                item
                    .setTitle(this.getNoteTypeDisplayName(noteType))
                    .setIcon(
                        noteType.kind === "image-occlusion"
                            ? "scan"
                            : noteType.kind === "cloze"
                              ? "scan-text"
                              : "layout-template",
                    )
                    .setChecked(noteType.id === this.selectedNoteTypeId)
                    .onClick(() => {
                        this.rememberCardState();
                        if (noteType.id === IMAGE_OCCLUSION_NOTE_TYPE_ID) {
                            this.request = {
                                mode: "image-occlusion",
                                deckPath: this.selectedDeck,
                            };
                            this.error = "";
                            this.render();
                            return;
                        }
                        if (this.editingStructuredNote) {
                            const currentType = this.getSelectedNoteType();
                            const nextValues: Record<string, string> = {};
                            for (const field of noteType.fields) {
                                const sameId = this.customFieldValues[field.id];
                                const sameName = currentType.fields.find(
                                    (candidate) =>
                                        candidate.name.localeCompare(field.name, undefined, {
                                            sensitivity: "base",
                                        }) === 0,
                                );
                                nextValues[field.id] =
                                    sameId ??
                                    (sameName ? this.customFieldValues[sameName.id] : "") ??
                                    "";
                            }
                            this.customFieldValues = nextValues;
                        }
                        this.selectedNoteTypeId = noteType.id;
                        localStorage.setItem(this.lastNoteTypeKey(), noteType.id);
                        if (noteType.id === BASIC_NOTE_TYPE_ID) this.cardType = "basic";
                        else if (noteType.id === REVERSED_NOTE_TYPE_ID) this.cardType = "reversed";
                        else if (noteType.id === CLOZE_NOTE_TYPE_ID) this.cardType = "cloze";
                        this.error = "";
                        this.saveDraft();
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
        let firstInput: HTMLElement | null = null;
        for (const field of [...noteType.fields].sort(
            (left, right) => left.ordinal - right.ordinal,
        )) {
            const group = this.createFieldGroup(
                surface,
                field.required ? `${field.name} · ${t("REQUIRED_FIELD")}` : field.name,
            );
            if (field.kind === "number") {
                const input = group.createEl("input", {
                    cls: "sr-native-input",
                    attr: { type: "number", inputmode: "decimal", "aria-label": field.name },
                });
                input.value = this.customFieldValues[field.id] ?? "";
                input.addEventListener("input", () => {
                    this.customFieldValues[field.id] = input.value;
                    this.clearError();
                    this.saveDraft();
                });
                firstInput ??= input;
            } else {
                const input = this.createRichTextEditor(
                    group,
                    this.customFieldValues[field.id] ?? "",
                    field.name,
                    field.name,
                    `field:${field.id}`,
                    (value) => {
                        this.customFieldValues[field.id] = value;
                        this.clearError();
                    },
                );
                firstInput ??= input;
            }
        }

        const primaryField = [...noteType.fields].sort(
            (left, right) => left.ordinal - right.ordinal,
        )[0];
        const duplicateCount = primaryField
            ? this.countMatchingFronts(this.customFieldValues[primaryField.id] ?? "")
            : 0;
        if (duplicateCount > 0) {
            surface.createDiv({
                cls: "sr-native-duplicate-status",
                text: this.creatorText(
                    `${duplicateCount} possible duplicate${duplicateCount === 1 ? "" : "s"}`,
                    `Возможных дубликатов: ${duplicateCount}`,
                ),
                attr: { role: "status" },
            });
        }

        this.renderTagsField(surface);
        this.renderStickyControls(
            surface,
            noteType.fields.map((field) => field.id),
        );
        if (this.showCardPreview) this.renderStructuredCardPreview(surface, noteType);

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
                .setButtonText(
                    this.quickAddQueue.length
                        ? this.creatorText(
                              `Save & next · ${this.quickAddQueue.length} left`,
                              `Сохранить и дальше · осталось ${this.quickAddQueue.length}`,
                          )
                        : t("SAVE_AND_ADD_ANOTHER"),
                )
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
        if (firstInput && !Platform.isMobile) window.setTimeout(() => firstInput?.focus(), 0);
    }

    private async saveStructuredNote(
        noteType: NoteTypeDefinition,
        addAnother: boolean,
    ): Promise<void> {
        const hasAnyContent = noteType.fields.some(
            (field) =>
                Boolean(this.customFieldValues[field.id]?.trim()) ||
                this.hasPendingMedia(`field:${field.id}`),
        );
        const missingRequired = noteType.fields.some(
            (field) =>
                field.required &&
                !this.customFieldValues[field.id]?.trim() &&
                !this.hasPendingMedia(`field:${field.id}`),
        );
        if (!hasAnyContent || missingRequired) {
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
            this.rememberDeck(this.selectedDeck);
            localStorage.setItem(this.lastNoteTypeKey(), this.selectedNoteTypeId);
            new Notice(this.editingStructuredNote ? t("CARD_UPDATED") : t("CARD_SAVED"));
            if (addAnother) {
                this.resetForNextCard(noteType);
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

    private async saveCurrentCard(addAnother: boolean): Promise<void> {
        const noteType = this.getSelectedNoteType();
        if (this.editingStructuredNote || !noteType.id.startsWith("builtin-")) {
            await this.saveStructuredNote(noteType, addAnother);
            return;
        }
        await this.saveCard(addAnother);
    }

    private async saveCard(addAnother: boolean): Promise<void> {
        const includesCloze = this.cardType === "cloze";
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
                answerMode: this.answerMode,
                tags: this.getTags(),
            };
            if (this.editingCard) await this.saveEditedCard(draft);
            else await this.store.createCards([draft]);
            this.rememberDeck(this.selectedDeck);
            localStorage.setItem(this.lastNoteTypeKey(), this.selectedNoteTypeId);
            if (!this.editingCard) this.rememberLastCreatedCard(draft);
            new Notice(this.editingCard ? t("CARD_UPDATED") : t("CARD_SAVED"));
            this.clearDraft();
            if (addAnother) {
                this.resetForNextCard();
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
            this.rememberDeck(this.selectedDeck);
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
                await this.store.setKnowledgeAreaScheduling(
                    this.editingAreaId,
                    this.areaScheduling,
                );
                await this.store.updateKnowledgeArea(this.editingAreaId, {
                    parentId: this.areaParentId,
                    kind: this.areaKind,
                    goal: this.areaGoal,
                });
                new Notice(t("KNOWLEDGE_AREA_UPDATED"));
            } else {
                const area = await this.store.createKnowledgeArea(this.areaName, {
                    parentId: this.areaParentId,
                    kind: this.areaKind,
                    goal: this.areaGoal,
                });
                await this.store.setKnowledgeAreaScheduling(area.id, this.areaScheduling);
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
        const rawSource = card.question.questionText.actualQuestion;
        this.answerMode = /<!--\s*sr-answer-mode:\s*type\s*-->/i.test(rawSource)
            ? "type"
            : "reveal";
        const source = rawSource.replace(/\n?<!--\s*sr-answer-mode:\s*type\s*-->/gi, "").trim();
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
        await this.store.updateCard(this.editingCard, draft);
    }

    private async returnToCards(): Promise<void> {
        await this.leaf.setViewState({ type: CARD_BROWSER_VIEW_TYPE, active: true });
    }
}
