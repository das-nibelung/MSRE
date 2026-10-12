import { Notice, Plugin, TFile } from "obsidian";

import {
    AutomationOperationKind,
    AutomationOperationPayloadMap,
} from "src/automation/automation-types";
import { PersonalSpacedRepetitionApi } from "src/automation/public-api";
import { CommandManager } from "src/command-manager";
import { DataManager } from "src/data/data-manager";
import { DebugLoggerInstance } from "src/data/debug-logger";
import { PluginDataError, PluginDataManager } from "src/data/plugin-data-manager";
import { SRSettings } from "src/data/settings";
import { SettingsManager } from "src/data/settings-manager";
import { AiAssistantService } from "src/intelligence/ai-assistant";
import { LocaleManagerInstance } from "src/lang/locale-manager";
import { NextNoteReviewHandler } from "src/note/next-note-review-handler";
import { NoteReviewQueue } from "src/note/note-review-queue";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { ReminderManager } from "src/scheduling/reminder-manager";
import { filterCardBrowserRecords } from "src/ui/card-browser/card-browser-model";
import { openCanvasAreaPicker } from "src/ui/obsidian-integrations/knowledge-area-picker";
import {
    controlKnowledgeCanvas,
    generateKnowledgeCanvas,
    KnowledgeCanvasAutoUpdater,
} from "src/ui/obsidian-integrations/knowledge-canvas";
import { SR_HOVER_SOURCE } from "src/ui/obsidian-integrations/obsidian-links";
import {
    generateKnowledgeMoc,
    registerStudyMarkdownBlocks,
    syncStudyProperties,
} from "src/ui/obsidian-integrations/obsidian-study-integration";
import {
    createStudyBase,
    refreshStudyBasesViews,
    STUDY_BASES_VIEW_TYPE,
    StudyBasesView,
} from "src/ui/obsidian-integrations/study-bases-view";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";
import { REVIEW_QUEUE_VIEW_TYPE } from "src/ui/obsidian-ui-components/item-views/review-queue-list-view";
import { UIManager } from "src/ui/ui-manager";
import { TextDirection } from "src/utils/strings";

export default class SRPlugin extends Plugin {
    private _uiManager: UIManager | null = null;
    private _dataManager: DataManager | null = null;

    private _nextNoteReviewHandler: NextNoteReviewHandler | null = null;
    private _commandManager: CommandManager | null = null;
    private _reminderManager: ReminderManager | null = null;
    private _api: PersonalSpacedRepetitionApi | null = null;
    private _ai: AiAssistantService | null = null;
    private _knowledgeCanvasUpdater: KnowledgeCanvasAutoUpdater | null = null;
    public isInitialized: boolean = false;

    async onload(): Promise<void> {
        try {
            // Load the plugin data and settings first, as other components depend on it being available during their initialization.
            const pluginDataManager = new PluginDataManager(this);
            await pluginDataManager.loadData();

            const settingsManager = new SettingsManager(
                pluginDataManager.pluginData.settings,
                async (settings: SRSettings) => {
                    await pluginDataManager.writeSettings(settings);
                },
            );

            this.dataManager = new DataManager(this, pluginDataManager, settingsManager);
            this._ai = new AiAssistantService(this);
            this._api = new PersonalSpacedRepetitionApi(this);
            const uiManager = new UIManager(this, settingsManager);
            this.uiManager = uiManager;
            this.commandManager = new CommandManager(this, settingsManager, uiManager);
            this.registerHoverLinkSource(SR_HOVER_SOURCE, {
                display: "Personal Spaced Repetition",
                defaultMod: false,
            });
            registerStudyMarkdownBlocks(this);
            this.registerBasesView(STUDY_BASES_VIEW_TYPE, {
                name: "Study",
                icon: "graduation-cap",
                factory: (controller, containerEl) =>
                    new StudyBasesView(controller, containerEl, this),
                options: () => [
                    {
                        key: "preset",
                        type: "dropdown",
                        displayName: "Study view",
                        default: "all",
                        options: {
                            all: "All cards",
                            today: "Today",
                            errors: "Errors",
                            weak: "Weak",
                            "no-area": "No knowledge area",
                        },
                    },
                    {
                        key: "showEmpty",
                        type: "toggle",
                        displayName: "Show notes without cards",
                        default: false,
                    },
                    {
                        key: "density",
                        type: "dropdown",
                        displayName: "Row density",
                        default: "compact",
                        options: {
                            compact: "Compact",
                            comfortable: "Comfortable",
                        },
                    },
                    {
                        key: "showCards",
                        type: "toggle",
                        displayName: "Expand cards by default",
                        default: false,
                    },
                ],
            });

            this.app.workspace.onLayoutReady(async () => {
                this.dataManager.loadData();

                // Set the preferred locale if it is not the default
                if (settingsManager.settings.preferredLocale !== "-") {
                    LocaleManagerInstance.getInstance().currentLocale =
                        settingsManager.settings.preferredLocale;
                }

                const noteReviewQueue = new NoteReviewQueue();
                this._nextNoteReviewHandler = new NextNoteReviewHandler(
                    this.app,
                    settingsManager.settings,
                    noteReviewQueue,
                );

                await this.dataManager.initOSRCore(noteReviewQueue, async () => {
                    await this.onOsrVaultDataChanged();
                });

                await this.uiManager.onLayoutReady();
                this.commandManager.onLayoutReady();
                this._reminderManager = new ReminderManager(this, this.uiManager, this.dataManager);

                this.isInitialized = true;
                this._knowledgeCanvasUpdater = new KnowledgeCanvasAutoUpdater(this);
                this._knowledgeCanvasUpdater.start();
                await this.api.start();
                this._reminderManager.restartReviewReminders();
            });

            this.registerObsidianProtocolHandler("msre", async (params) => {
                if (!this.isInitialized) return;
                const action = params.action ?? "open-creator";
                if (action === "open-creator") {
                    await this.uiManager.openNativeCardCreator();
                    return;
                }
                if (action === "open-browser") {
                    await this.uiManager.openCardBrowser(
                        params.note ?? null,
                        params.query ?? "",
                        params.deck ?? "all",
                    );
                    return;
                }
                if (action === "open-source") {
                    if (!params.file) {
                        new Notice("MSRE: Missing source file");
                        return;
                    }
                    const block = params.block
                        ? `#${params.block.startsWith("^") ? params.block : `^${params.block}`}`
                        : "";
                    await this.app.workspace.openLinkText(
                        `${params.file}${block}`,
                        params.file,
                        false,
                    );
                    return;
                }
                if (action === "knowledge-map") {
                    await generateKnowledgeCanvas(this);
                    return;
                }
                if (action === "canvas-control") {
                    await controlKnowledgeCanvas(this, params);
                    return;
                }
                if (action === "canvas-new-area") {
                    await this.uiManager.openNativeKnowledgeAreaCreator();
                    return;
                }
                if (action === "canvas-edit-area") {
                    await this.uiManager.openNativeKnowledgeAreaCreator(params.area);
                    return;
                }
                if (action === "canvas-assign-deck") {
                    if (params.deck) openCanvasAreaPicker(this, params.deck);
                    return;
                }
                if (action === "knowledge-hub") {
                    await generateKnowledgeMoc(this, { open: true, notify: true });
                    return;
                }
                if (action === "sync-properties") {
                    const files = params.file
                        ? [this.app.vault.getFileByPath(params.file)].filter(
                              (file): file is TFile => Boolean(file),
                          )
                        : undefined;
                    const updated = await syncStudyProperties(this, files);
                    new Notice(`MSRE: Updated ${updated} note properties`);
                    return;
                }
                if (action === "study-base") {
                    await createStudyBase(this);
                    return;
                }
                if (action === "review") {
                    const records = filterCardBrowserRecords(
                        createStudyRecords(this),
                        params.query ?? "",
                        "all",
                        params.deck ?? "all",
                    ).filter((record) => record.lifecycleState === "active");
                    const stableIds = records
                        .map((record) => record.card.stableId)
                        .filter((id): id is string => Boolean(id));
                    if (!stableIds.length) {
                        new Notice("MSRE: No cards match this study link");
                        return;
                    }
                    await this.uiManager.openDeckContainer(
                        FlashcardReviewMode.Review,
                        undefined,
                        stableIds,
                    );
                    return;
                }
                const operation = action as AutomationOperationKind;
                if (!this.api.capabilities.includes(operation)) {
                    new Notice("MSRE: Unsupported automation action");
                    return;
                }
                try {
                    const payload = this.uriPayload(operation, params);
                    await this.api.executeUri(operation, payload, params.token ?? "");
                    new Notice("MSRE: Automation completed");
                } catch (error) {
                    new Notice(
                        `MSRE: ${error instanceof Error ? error.message : "Automation failed"}`,
                    );
                }
            });
        } catch (error) {
            if (error instanceof PluginDataError || error instanceof Error) {
                console.warn("SRPlugin: Error in onLoad", error.message);
                DebugLoggerInstance.getInstance().log(
                    "SRPlugin: Error in onLoad: " + error.message,
                    "error",
                );
            } else {
                console.warn("SRPlugin: Error in onLoad");
                DebugLoggerInstance.getInstance().log("SRPlugin: Error in onLoad", "error");
            }
        }
    }

    get reminderManager(): ReminderManager {
        if (this._reminderManager === null) throw new Error("Reminder manager not initialized!!!");
        return this._reminderManager;
    }

    get api(): PersonalSpacedRepetitionApi {
        if (this._api === null) throw new Error("Public API not initialized!!!");
        return this._api;
    }

    get ai(): AiAssistantService {
        if (this._ai === null) throw new Error("AI assistant not initialized!!!");
        return this._ai;
    }

    isApiLoaded(): boolean {
        return this._api !== null;
    }

    get uiManager(): UIManager {
        if (this._uiManager === null) throw new Error("UI manager not initialized!!!");
        return this._uiManager;
    }

    set uiManager(uiManager: UIManager) {
        this._uiManager = uiManager;
    }

    get nextNoteReviewHandler(): NextNoteReviewHandler {
        if (this._nextNoteReviewHandler === null)
            throw new Error("Next note review handler not initialized!!!");
        return this._nextNoteReviewHandler;
    }

    get commandManager(): CommandManager {
        if (this._commandManager === null) throw new Error("Command manager not initialized!!!");
        return this._commandManager;
    }

    set commandManager(commandManager: CommandManager) {
        this._commandManager = commandManager;
    }

    isUiManagerLoaded(): boolean {
        return this._uiManager !== null;
    }

    get dataManager(): DataManager {
        if (this._dataManager === null) throw new Error("Data manager not initialized!!!");
        return this._dataManager;
    }

    set dataManager(dataManager: DataManager) {
        this._dataManager = dataManager;
    }

    isDataManagerLoaded(): boolean {
        return this._dataManager !== null;
    }

    onunload(): void {
        this._api?.stop();
        this._reminderManager?.stopReviewReminders();
        this._dataManager?.close();
        this.app.workspace.getLeavesOfType(REVIEW_QUEUE_VIEW_TYPE).forEach((leaf) => leaf.detach());
        this._uiManager?.destroy();
        this._commandManager?.onunload();
    }

    public addCustomHotkeys() {
        this.commandManager.addCustomHotkeys();
    }

    public removeCustomHotkeys() {
        this.commandManager.removeCustomHotkeys();
    }

    /**
     * Gets the text direction setting for the current Obsidian instance.
     */
    public getObsidianRtlSetting(): TextDirection {
        return activeDocument.body.hasClass("mod-rtl") ? TextDirection.Rtl : TextDirection.Ltr;
    }

    /**
     * Called when the OSR app core's data has changed.
     *
     * Anything that needs to be updated in the UI because of this change should be done here.
     */
    private async onOsrVaultDataChanged() {
        await this.uiManager.updateStatusBar();
        this.uiManager.tabViewManager.refreshCardBrowser();
        refreshStudyBasesViews();
        this._knowledgeCanvasUpdater?.schedule();
        if (this.dataManager.data.settings.enableNoteReviewPaneOnStartup) {
            this.uiManager.sidebarManager.redraw();
        }
    }

    private uriPayload(
        operation: AutomationOperationKind,
        params: Record<string, string>,
    ): AutomationOperationPayloadMap[AutomationOperationKind] {
        if (params.payload) {
            return JSON.parse(
                params.payload,
            ) as AutomationOperationPayloadMap[AutomationOperationKind];
        }
        if (operation === "create-card") {
            return {
                deckPath: params.deck ?? "Inbox",
                type: params.type === "cloze" || params.type === "reversed" ? params.type : "basic",
                front: params.front ?? "",
                back: params.back ?? "",
                tags: params.tags
                    ?.split(",")
                    .map((tag) => tag.trim())
                    .filter(Boolean),
            };
        }
        if (operation === "create-deck") return { deckPath: params.deck ?? "" };
        if (operation === "find-cards") {
            return { query: params.query, deckPath: params.deck, noteId: params.noteId };
        }
        if (operation === "get-statistics" || operation === "check-integrity") return {};
        throw new Error("payload-required");
    }
}
