import { Editor, MarkdownView, Platform, TFile } from "obsidian";

import { SettingsManager } from "src/data/settings-manager";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { ReviewResponse } from "src/scheduling/algorithms/base/repetition-item";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { createCardInEditor } from "src/ui/card-creation";
import { UIManager, UIState } from "src/ui/ui-manager";
import EmulatedPlatform from "src/utils/platform-detector";

export class CommandManager {
    private plugin: SRPlugin;
    private settingsManager: SettingsManager;
    private uiManager: UIManager;

    constructor(plugin: SRPlugin, settingsManager: SettingsManager, uiManager: UIManager) {
        this.plugin = plugin;
        this.settingsManager = settingsManager;
        this.uiManager = uiManager;
    }

    /**
     * register all the plugin commands once the plugin is loaded
     */
    public onLayoutReady() {
        if (this.settingsManager.settings.useCustomHotkeys) {
            this.addCustomHotkeys();
        }

        this.addPluginCommands();
    }

    /**
     * remove all the plugin commands once the plugin is unloaded
     */
    public onunload() {
        this.removeCustomHotkeys();
    }

    /**
     * remove all the hotkeys
     */
    public removeCustomHotkeys() {
        this.plugin.removeCommand("srs-card-review-again");
        this.plugin.removeCommand("srs-card-review-hard");
        this.plugin.removeCommand("srs-card-review-good");
        this.plugin.removeCommand("srs-card-review-easy");
        this.plugin.removeCommand("srs-card-review-show-answer");
        this.plugin.removeCommand("srs-card-review-reset");
        this.plugin.removeCommand("srs-card-review-skip");
    }

    /**
     * add all the hotkeys
     */
    public addCustomHotkeys() {
        this.plugin.addCommand({
            id: "srs-card-review-again",
            name: t("REVIEW_CARD_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardAgainText,
            }),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardBack &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._processReview(ReviewResponse.Again);
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-hard",
            name: t("REVIEW_CARD_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardHardText,
            }),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardBack &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._processReview(ReviewResponse.Hard);
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-good",
            name: t("REVIEW_CARD_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardGoodText,
            }),
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardBack &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._processReview(ReviewResponse.Good);
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-easy",
            name: t("REVIEW_CARD_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardEasyText,
            }),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardBack &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._processReview(ReviewResponse.Easy);
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-show-answer",
            name: t("SHOW_ANSWER"),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardFront &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._showAnswer();
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-skip",
            name: t("SKIP"),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    (this.uiManager.uiState === UIState.CardBack ||
                        this.uiManager.uiState === UIState.CardFront) &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._skipCurrentCard();
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-reset",
            name: t("RESET_CARD_PROGRESS"),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardBack &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._processReview(ReviewResponse.Reset);
                    }
                    return true;
                }
                return false;
            },
        });

        this.plugin.addCommand({
            id: "srs-card-review-open-in-background",
            name: t("OPEN_IN_BACKGROUND"),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                if (
                    this.plugin.isInitialized &&
                    this.uiManager.uiState === UIState.CardBack &&
                    this.uiManager.isSRInFocus &&
                    this.uiManager.contentManager !== null &&
                    !(
                        Platform.isMobile || // No keyboard events on mobile
                        EmulatedPlatform().isMobile
                    ) &&
                    !(
                        activeDocument.activeElement !== null &&
                        (activeDocument.activeElement.nodeName === "TEXTAREA" ||
                            activeDocument.activeElement.nodeName === "INPUT")
                    )
                ) {
                    if (!checking) {
                        void this.uiManager.contentManager._jumpToCurrentCard();
                    }
                    return true;
                }
                return false;
            },
        });
    }

    /**
     * add all the plugin commands
     */
    private getQuickAddSource(editor: Editor): string {
        const selection = editor.getSelection().trim();
        if (selection) return selection;
        const cursorLine = editor.getCursor().line;
        const current = editor.getLine(cursorLine);
        const heading = current.match(/^(#{1,6})\s+/);
        let start = cursorLine;
        let end = cursorLine;
        if (heading) {
            const level = heading[1].length;
            while (end + 1 < editor.lineCount()) {
                const next = editor.getLine(end + 1);
                const nextHeading = next.match(/^(#{1,6})\s+/);
                if (nextHeading && nextHeading[1].length <= level) break;
                end++;
            }
        } else {
            while (start > 0 && editor.getLine(start - 1).trim()) start--;
            while (end + 1 < editor.lineCount() && editor.getLine(end + 1).trim()) end++;
        }
        return Array.from({ length: end - start + 1 }, (_, index) => editor.getLine(start + index))
            .join("\n")
            .trim();
    }

    private addPluginCommands() {
        this.plugin.addCommand({
            id: "open-native-card-creator",
            name: t("NEW_CARD"),
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openNativeCardCreator();
            },
        });

        this.plugin.addCommand({
            id: "quick-add-from-selection",
            name: "Quick Add from selection or current block",
            editorCallback: (editor: Editor) => {
                const source = this.getQuickAddSource(editor);
                if (source) void this.uiManager.openNativeQuickAdd(source);
            },
        });

        this.plugin.addCommand({
            id: "open-native-deck-creator",
            name: t("NEW_DECK"),
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openNativeDeckCreator();
            },
        });

        this.plugin.addCommand({
            id: "create-basic-card",
            name: t("CREATE_CARD"),
            editorCallback: (editor: Editor, view: MarkdownView) => {
                createCardInEditor(
                    editor,
                    this.settingsManager.settings,
                    "basic",
                    view.file?.basename ?? "",
                );
            },
        });

        this.plugin.addCommand({
            id: "create-reversed-card",
            name: t("CREATE_REVERSED_CARD"),
            editorCallback: (editor: Editor, view: MarkdownView) => {
                createCardInEditor(
                    editor,
                    this.settingsManager.settings,
                    "reversed",
                    view.file?.basename ?? "",
                );
            },
        });

        this.plugin.addCommand({
            id: "create-cloze-card",
            name: t("CREATE_CLOZE_CARD"),
            editorCallback: (editor: Editor, view: MarkdownView) => {
                createCardInEditor(
                    editor,
                    this.settingsManager.settings,
                    "cloze",
                    view.file?.basename ?? "",
                );
            },
        });

        this.plugin.addCommand({
            id: "open-card-browser",
            name: t("BROWSE_CARDS"),
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openCardBrowser();
            },
        });

        this.plugin.addCommand({
            id: "browse-cards-in-current-note",
            name: t("BROWSE_CARDS_IN_NOTE"),
            checkCallback: (checking) => {
                const file = this.plugin.app.workspace.getActiveFile();
                if (!this.plugin.isInitialized || !file || file.extension !== "md") return false;
                if (!checking) void this.uiManager.openCardBrowser(file.path);
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-note-review-open-note",
            name: t("OPEN_NOTE_FOR_REVIEW"),
            callback: async () => {
                if (
                    !this.plugin.dataManager.syncLock &&
                    this.plugin.nextNoteReviewHandler !== null &&
                    this.plugin.isInitialized
                ) {
                    await this.plugin.dataManager.sync();
                    await this.plugin.nextNoteReviewHandler.reviewNextNoteModal();
                }
            },
        });

        this.plugin.addCommand({
            id: "srs-note-review-easy",
            name: t("REVIEW_NOTE_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardEasyText,
            }),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                const openFile: TFile | null = this.plugin.app.workspace.getActiveFile();

                if (openFile === null || openFile.extension !== "md" || !this.plugin.isInitialized)
                    return false;

                if (!checking) {
                    void this.plugin.dataManager.saveNoteReviewResponse(
                        openFile,
                        ReviewResponse.Easy,
                    );
                }
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-note-review-good",
            name: t("REVIEW_NOTE_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardGoodText,
            }),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                const openFile: TFile | null = this.plugin.app.workspace.getActiveFile();

                if (openFile === null || openFile.extension !== "md" || !this.plugin.isInitialized)
                    return false;

                if (!checking) {
                    void this.plugin.dataManager.saveNoteReviewResponse(
                        openFile,
                        ReviewResponse.Good,
                    );
                }
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-note-review-hard",
            name: t("REVIEW_NOTE_DIFFICULTY_CMD", {
                difficulty: this.settingsManager.settings.flashcardHardText,
            }),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                const openFile: TFile | null = this.plugin.app.workspace.getActiveFile();

                if (openFile === null || openFile.extension !== "md" || !this.plugin.isInitialized)
                    return false;

                if (!checking) {
                    void this.plugin.dataManager.saveNoteReviewResponse(
                        openFile,
                        ReviewResponse.Hard,
                    );
                }
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-review-flashcards",
            name: t("REVIEW_ALL_CARDS"),
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openDeckContainer(FlashcardReviewMode.Review);
            },
        });

        this.plugin.addCommand({
            id: "srs-cram-flashcards",
            name: t("CRAM_ALL_CARDS"),
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openDeckContainer(FlashcardReviewMode.Cram);
            },
        });

        this.plugin.addCommand({
            id: "srs-review-flashcards-in-note",
            name: t("REVIEW_CARDS_IN_NOTE"),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                const openFile: TFile | null = this.plugin.app.workspace.getActiveFile();

                if (openFile === null || openFile.extension !== "md" || !this.plugin.isInitialized)
                    return false;

                if (!checking) {
                    void this.uiManager.openDeckContainer(FlashcardReviewMode.Review, openFile);
                }
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-cram-flashcards-in-note",
            name: t("CRAM_CARDS_IN_NOTE"),
            repeatable: false,
            checkCallback: (checking: boolean) => {
                const openFile: TFile | null = this.plugin.app.workspace.getActiveFile();

                if (openFile === null || openFile.extension !== "md" || !this.plugin.isInitialized)
                    return false;

                if (!checking) {
                    void this.uiManager.openDeckContainer(FlashcardReviewMode.Cram, openFile);
                }
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-import-export",
            name: "Open import and export",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openNativeTransferManager();
            },
        });

        this.plugin.addCommand({
            id: "srs-open-review-queue-view",
            name: t("OPEN_REVIEW_QUEUE_VIEW"),
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.sidebarManager.openReviewQueueView();
            },
        });
    }
}
