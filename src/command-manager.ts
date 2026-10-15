import { Editor, MarkdownView, Notice, Platform, TFile } from "obsidian";

import { SettingsManager } from "src/data/settings-manager";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { ReviewResponse } from "src/scheduling/algorithms/base/repetition-item";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { createCardInEditor } from "src/ui/card-creation";
import { generateKnowledgeCanvas } from "src/ui/obsidian-integrations/knowledge-canvas";
import {
    generateKnowledgeMoc,
    syncStudyProperties,
} from "src/ui/obsidian-integrations/obsidian-study-integration";
import { createStudyBase } from "src/ui/obsidian-integrations/study-bases-view";
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
            id: "open-reminder-center",
            name: "Open Reminder Center",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openReminderCenter();
            },
        });

        this.plugin.addCommand({
            id: "open-intelligence-center",
            name: "Open Intelligence Center",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openIntelligenceCenter();
            },
        });

        this.plugin.addCommand({
            id: "check-review-reminders-now",
            name: "Check review reminders now",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                const count = await this.plugin.reminderManager.checkNow();
                if (!count) new Notice("No reminder rules match right now");
            },
        });

        this.plugin.addCommand({
            id: "generate-knowledge-canvas",
            name: "Generate knowledge map Canvas",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await generateKnowledgeCanvas(this.plugin);
            },
        });

        this.plugin.addCommand({
            id: "open-interactive-knowledge-graph",
            name: "Open interactive knowledge graph",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.uiManager.openKnowledgeGraph();
            },
        });

        this.plugin.addCommand({
            id: "compile-current-note",
            name: "Compile current note into knowledge cards",
            checkCallback: (checking) => {
                if (!this.plugin.isInitialized) return false;
                const file = this.plugin.app.workspace.getActiveFile();
                if (!(file instanceof TFile) || file.extension !== "md") return false;
                if (!checking) void this.uiManager.openKnowledgeCompiler(file.path);
                return true;
            },
        });

        this.plugin.addCommand({
            id: "open-study-base",
            name: "Create or open study Base",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await createStudyBase(this.plugin);
            },
        });

        this.plugin.addCommand({
            id: "open-knowledge-hub",
            name: "Create or open Knowledge Hub",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await generateKnowledgeMoc(this.plugin, { open: true, notify: true });
            },
        });

        this.plugin.addCommand({
            id: "sync-study-properties",
            name: "Update study Properties in all card notes",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                const updated = await syncStudyProperties(this.plugin);
                new Notice(`Updated study Properties in ${updated} notes`);
            },
        });

        this.plugin.addCommand({
            id: "sync-current-note-study-properties",
            name: "Update study Properties in current note",
            checkCallback: (checking) => {
                const file = this.plugin.app.workspace.getActiveFile();
                if (!this.plugin.isInitialized || !file || file.extension !== "md") return false;
                if (!checking) {
                    void syncStudyProperties(this.plugin, [file]).then(
                        (updated) =>
                            new Notice(
                                updated ? "Study Properties updated" : "No cards in this note",
                            ),
                    );
                }
                return true;
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

        this.plugin.addCommand({
            id: "srs-edit-cards-in-current-note",
            name: "Edit cards in current note",
            checkCallback: (checking) => {
                const file = this.plugin.app.workspace.getActiveFile();
                if (!this.plugin.isInitialized || !file || file.extension !== "md") return false;
                if (!checking) void this.uiManager.openCardBrowser(file.path);
                return true;
            },
        });

        this.plugin.addCommand({
            id: "srs-automation-process-queue",
            name: "Automation: Process external queue",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                const count = await this.plugin.api.bridge.processNow();
                new Notice(`MSRE: Processed ${count} automation request${count === 1 ? "" : "s"}`);
            },
        });

        this.plugin.addCommand({
            id: "srs-automation-copy-token",
            name: "Automation: Copy access token",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await navigator.clipboard.writeText(await this.plugin.api.ensureAccessToken());
                new Notice("MSRE automation token copied");
            },
        });

        this.plugin.addCommand({
            id: "srs-check-collection-integrity",
            name: "Check collection integrity",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                const report = await this.plugin.dataManager.collectionStore.checkIntegrity();
                new Notice(
                    report.issues.length === 0
                        ? "MSRE: Collection is healthy"
                        : `MSRE: Found ${report.issues.length} integrity issue${report.issues.length === 1 ? "" : "s"}`,
                );
            },
        });

        this.plugin.addCommand({
            id: "srs-rebuild-semantic-index",
            name: "Rebuild local semantic index",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                const count = await this.plugin.dataManager.rebuildSemanticIndex();
                this.uiManager.tabViewManager.refreshCardBrowser();
                new Notice(`MSRE: Local semantic index rebuilt · ${count} notes`);
            },
        });

        this.plugin.addCommand({
            id: "srs-clear-semantic-index",
            name: "Delete local semantic index",
            callback: async () => {
                if (!this.plugin.isInitialized) return;
                await this.plugin.dataManager.clearSemanticIndex();
                this.uiManager.tabViewManager.refreshCardBrowser();
                new Notice("MSRE: Local semantic index deleted. Markdown cards were not changed.");
            },
        });
    }
}
