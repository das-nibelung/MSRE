import "src/ui/obsidian-ui-components/content-container/settings-page/data-page.css";
import { ButtonComponent, Notice, setIcon, Setting, SettingGroup, TFile } from "obsidian";

import {
    CollectionIntegrityIssue,
    CollectionIntegrityReport,
    IntegrityIssueCode,
} from "src/data/collection/collection-types";
import { DataManager } from "src/data/data-manager";
import { DataStore } from "src/data/data-store/base/data-store";
import { DEFAULT_SETTINGS } from "src/data/settings";
import { SettingsManager } from "src/data/settings-manager";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { SettingsPage } from "src/ui/obsidian-ui-components/content-container/settings-page/settings-page";
import { SettingsPageType } from "src/ui/obsidian-ui-components/content-container/settings-page/settings-page-manager";
import { ConfirmationModal } from "src/ui/obsidian-ui-components/modals/confirmation-modal";

/**
 * Settings page for data storage options and scheduling data management.
 *
 * @class DataPage
 * @extends {SettingsPage}
 */
export class DataPage extends SettingsPage {
    private safetyEl: HTMLDivElement;
    private integrityReport: CollectionIntegrityReport | null = null;
    private safetyBusy = false;

    constructor(
        pageContainerEl: HTMLElement,
        plugin: SRPlugin,
        settingsManager: SettingsManager,
        dataManager: DataManager,
        pageType: SettingsPageType,
        applySettingsUpdate: (callback: () => unknown) => void,
        display: () => void,
        openPage: (pageType: SettingsPageType) => void,
        scrollListener: (scrollPosition: number) => void,
    ) {
        super(
            pageContainerEl,
            plugin,
            settingsManager,
            dataManager,
            pageType,
            applySettingsUpdate,
            display,
            openPage,
            scrollListener,
        );

        this.safetyEl = this.containerEl.createDiv("sr-collection-safety");
        void this.renderCollectionSafety();

        const automationGroup = new SettingGroup(this.containerEl).setHeading("Automation & MCP");
        automationGroup
            .addSetting((setting: Setting) => {
                setting
                    .setName("Enable automation API")
                    .setDesc("Expose the versioned API to trusted Obsidian plugins and scripts.")
                    .addToggle((toggle) =>
                        toggle
                            .setValue(this.settingsManager.settings.automationEnabled)
                            .onChange(async (value) => {
                                this.settingsManager.settings.automationEnabled = value;
                                await this.settingsManager.save();
                                if (value) await this.plugin.api.start();
                                else this.plugin.api.bridge.stop();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Allow changes")
                    .setDesc("Required for creating decks, cards, media, and editing fields.")
                    .addToggle((toggle) =>
                        toggle
                            .setValue(this.settingsManager.settings.automationWriteAccess)
                            .onChange(async (value) => {
                                this.settingsManager.settings.automationWriteAccess = value;
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Enable MCP queue")
                    .setDesc("Process signed requests from the vault-local Automation inbox.")
                    .addToggle((toggle) =>
                        toggle
                            .setValue(this.settingsManager.settings.automationQueueEnabled)
                            .onChange(async (value) => {
                                this.settingsManager.settings.automationQueueEnabled = value;
                                await this.settingsManager.save();
                                if (value) await this.plugin.api.start();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Allowed deck paths")
                    .setDesc("Optional comma-separated roots. Leave empty to allow every deck.")
                    .addText((text) =>
                        text
                            .setPlaceholder("Medicine, Law/Private")
                            .setValue(
                                this.settingsManager.settings.automationAllowedDeckPaths.join(", "),
                            )
                            .onChange(async (value) => {
                                this.settingsManager.settings.automationAllowedDeckPaths = value
                                    .split(",")
                                    .map((path) => path.trim())
                                    .filter(Boolean);
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Maximum cards per import")
                    .setDesc("Limits a single external request.")
                    .addText((text) => {
                        text.inputEl.type = "number";
                        text.inputEl.min = "1";
                        text.inputEl.max = "1000";
                        text.setValue(
                            String(this.settingsManager.settings.automationMaxBatchSize),
                        ).onChange(async (value) => {
                            this.settingsManager.settings.automationMaxBatchSize = Math.max(
                                1,
                                Math.min(1000, Number.parseInt(value, 10) || 1),
                            );
                            await this.settingsManager.save();
                        });
                    });
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Access token")
                    .setDesc("Keep this secret. Regenerating it disconnects existing clients.")
                    .addButton((button) =>
                        button.setButtonText("Copy").onClick(async () => {
                            await navigator.clipboard.writeText(
                                await this.plugin.api.ensureAccessToken(),
                            );
                            new Notice("Automation token copied");
                        }),
                    )
                    .addExtraButton((button) =>
                        button
                            .setIcon("refresh-cw")
                            .setTooltip("Regenerate token")
                            .onClick(async () => {
                                this.settingsManager.settings.automationAccessToken = "";
                                await this.settingsManager.save();
                                await this.plugin.api.ensureAccessToken();
                                new Notice("Automation token regenerated");
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Queue and action log")
                    .setDesc("Process pending requests or inspect the local automation audit log.")
                    .addButton((button) =>
                        button.setButtonText("Process now").onClick(async () => {
                            const count = await this.plugin.api.bridge.processNow();
                            new Notice(
                                `Processed ${count} automation request${count === 1 ? "" : "s"}`,
                            );
                        }),
                    )
                    .addButton((button) =>
                        button.setButtonText("Open log").onClick(async () => {
                            const file = this.plugin.app.vault.getAbstractFileByPath(
                                this.plugin.api.bridge.auditPath,
                            );
                            if (file instanceof TFile) {
                                await this.plugin.app.workspace.getLeaf("tab").openFile(file);
                            }
                        }),
                    );
            });

        const aiGroup = new SettingGroup(this.containerEl).setHeading("AI co-author");
        aiGroup
            .addSetting((setting: Setting) => {
                setting
                    .setName("Preferred connection")
                    .setDesc(
                        "Choose the default route. You always review generated cards before they change the draft.",
                    )
                    .addDropdown((dropdown) =>
                        dropdown
                            .addOptions({
                                "direct-api": "Direct API",
                                mcp: "MCP / Codex",
                                codex: "Codex plugin",
                            })
                            .setValue(this.settingsManager.settings.aiPreferredProvider)
                            .onChange(async (value) => {
                                this.settingsManager.settings.aiPreferredProvider = value;
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("API format")
                    .setDesc(
                        "Use Responses for OpenAI, or Chat Completions for compatible services.",
                    )
                    .addDropdown((dropdown) =>
                        dropdown
                            .addOptions({
                                responses: "OpenAI Responses",
                                "chat-completions": "Chat Completions compatible",
                            })
                            .setValue(this.settingsManager.settings.aiApiProtocol)
                            .onChange(async (value) => {
                                this.settingsManager.settings.aiApiProtocol = value as
                                    "responses" | "chat-completions";
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("API endpoint")
                    .setDesc("HTTPS is required; HTTP is accepted only for localhost.")
                    .addText((text) =>
                        text
                            .setPlaceholder("https://api.openai.com/v1/responses")
                            .setValue(this.settingsManager.settings.aiApiEndpoint)
                            .onChange(async (value) => {
                                this.settingsManager.settings.aiApiEndpoint = value.trim();
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("Model")
                    .setDesc("Enter the exact model supported by your provider.")
                    .addText((text) =>
                        text
                            .setPlaceholder("Model ID")
                            .setValue(this.settingsManager.settings.aiApiModel)
                            .onChange(async (value) => {
                                this.settingsManager.settings.aiApiModel = value.trim();
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                const hasKey = Boolean(this.plugin.ai.getApiKey());
                setting
                    .setName("API key on this device")
                    .setDesc(
                        "Stored only in this device's local Obsidian storage, never in cards or the vault queue.",
                    )
                    .addText((text) => {
                        text.inputEl.type = "password";
                        text.setPlaceholder(
                            hasKey ? "Saved on this device" : "Optional for local APIs",
                        );
                        text.onChange((value) => this.plugin.ai.setApiKey(value));
                    })
                    .addExtraButton((button) =>
                        button
                            .setIcon("trash-2")
                            .setTooltip("Forget API key")
                            .onClick(() => {
                                this.plugin.ai.setApiKey("");
                                new Notice("AI API key removed from this device");
                                this.display();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("MCP / Codex bridge")
                    .setDesc(
                        "Let a connected local MCP agent answer AI requests through the signed vault queue.",
                    )
                    .addToggle((toggle) =>
                        toggle
                            .setValue(this.settingsManager.settings.aiMcpEnabled)
                            .onChange(async (value) => {
                                this.settingsManager.settings.aiMcpEnabled = value;
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName("MCP response window")
                    .setDesc("How long the AI panel waits for the connected agent.")
                    .addText((text) => {
                        text.inputEl.type = "number";
                        text.inputEl.min = "15";
                        text.inputEl.max = "600";
                        text.setValue(
                            String(this.settingsManager.settings.aiMcpWaitSeconds),
                        ).onChange(async (value) => {
                            this.settingsManager.settings.aiMcpWaitSeconds = Math.max(
                                15,
                                Math.min(600, Number.parseInt(value, 10) || 180),
                            );
                            await this.settingsManager.save();
                        });
                    });
            });

        // TODO: Implement this when the other data stores are implemented

        const dataStorageGroup = new SettingGroup(this.containerEl).setHeading(
            t("GROUP_DATA_STORAGE"),
        );
        //     .addSetting((setting: Setting) => {
        //         setting
        //             .setName(t("GROUP_DATA_STORAGE"))
        //             .setDesc(t("GROUP_DATA_STORAGE_DESC"))
        //             .addDropdown((dropdown) => {
        //                 dropdown
        //                     .addOptions({
        //                         [StorageType.NOTES]: t("STORE_IN_NOTES"),
        //                         // [StorageType.FOLDER]: "Store in vault folder (beta)",
        //                         // [StorageType.PLUGIN_DATA]: "Store in plugin data (beta)",
        //                     })
        //                     .setValue(this.settingsManager.settings.dataStore)
        //                     .onChange(async (value) => {
        //                         const oldMode = this.settingsManager.settings
        //                             .dataStore as StorageType;
        //                         const newMode = value as StorageType;

        //                         // Revert the dropdown immediately; only apply after confirmation.
        //                         dropdown.setValue(oldMode);

        //                         let migrateMessage: string = "";
        //                         let confirmMessage: string = "";
        //                         let migratingMessage: string = "";

        //                         switch (newMode) {
        //                             // case StorageType.FOLDER:
        //                             //     migrateMessage = t("MIGRATE_TO_FOLDER");
        //                             //     confirmMessage = t("CONFIRM_MIGRATE_TO_FOLDER");
        //                             //     migratingMessage = t("MIGRATING_TO_FOLDER");
        //                             //     break;
        //                             // case StorageType.PLUGIN_DATA:
        //                             //     migrateMessage = t("MIGRATE_TO_PLUGIN_DATA");
        //                             //     confirmMessage = t("CONFIRM_MIGRATE_TO_PLUGIN_DATA");
        //                             //     migratingMessage = t("MIGRATING_TO_PLUGIN_DATA");
        //                             //     break;
        //                             case StorageType.NOTES:
        //                                 migrateMessage = t("MIGRATE_TO_NOTES");
        //                                 confirmMessage = t("CONFIRM_MIGRATE_TO_NOTES");
        //                                 migratingMessage = t("MIGRATING_TO_NOTES");
        //                                 break;
        //                         }

        //                         new ConfirmationModal(
        //                             this.plugin.app,
        //                             migrateMessage,
        //                             confirmMessage,
        //                             migratingMessage,
        //                             async () => {
        //                                 dropdown.setValue(newMode);
        //                                 this.settingsManager.settings.dataStore = newMode;
        //                                 this.dataManager.setupDataStoreAndAlgorithmInstances(
        //                                     this.settingsManager.settings,
        //                                 );
        //                                 await DataStore.instance.isStructureInitialized.then(
        //                                     async (isInitialized) => {
        //                                         if (!isInitialized) {
        //                                             await DataStore.instance.isStructureInitialized;
        //                                         }
        //                                         await DataStore.instance.migrateDataStore(oldMode);
        //                                         await this.settingsManager.save();
        //                                         this.display();
        //                                     },
        //                                 );
        //                             },
        //                         ).open();
        //                     });
        //             });
        //     });

        // dataStorageGroup.addSetting((setting: Setting) => {
        //     setting.infoEl.insertAdjacentText("beforeend", t("PLUGIN_DATA_STORE_INFO"));
        // });

        // if (this.settingsManager.settings.dataStore === StorageType.FOLDER) {
        //     dataStorageGroup.addSetting((setting: Setting) => {
        //         setting
        //             .setName("Schedule data location in vault")
        //             .setDesc(
        //                 'Root folder for schedule files. Data is stored in "Schedule Data" as markdown files.',
        //             )
        //             .addText((text) => {
        //                 const commitValue = async () => {
        //                     this.settingsManager.settings.scheduleDataVaultLocation =
        //                         text.getValue().trim() ||
        //                         DEFAULT_SETTINGS.scheduleDataVaultLocation;
        //                     await this.settingsManager.save();
        //                 };

        //                 text.setPlaceholder(DEFAULT_SETTINGS.scheduleDataVaultLocation)
        //                     .setValue(this.settingsManager.settings.scheduleDataVaultLocation)
        //                     .onChange(() => {
        //                         this.settingsManager.settings.scheduleDataVaultLocation =
        //                             text.getValue().trim() ||
        //                             DEFAULT_SETTINGS.scheduleDataVaultLocation;
        //                     });

        //                 text.inputEl.addEventListener("blur", () => {
        //                     void commitValue();
        //                 });
        //             });
        //     });
        // }

        dataStorageGroup
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("INLINE_SCHEDULING_COMMENTS"))
                    .setDesc(t("INLINE_SCHEDULING_COMMENTS_DESC"))
                    .addToggle((toggle) =>
                        toggle
                            .setValue(this.settingsManager.settings.cardCommentOnSameLine)
                            .onChange(async (value) => {
                                this.settingsManager.settings.cardCommentOnSameLine = value;
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("USE_CALLOUTS_FOR_SCHEDULING_COMMENTS"))
                    .setDesc(t("USE_CALLOUTS_FOR_SCHEDULING_COMMENTS_DESC"))
                    .addToggle((toggle) =>
                        toggle
                            .setValue(
                                this.settingsManager.settings.useCalloutsForSchedulingComments,
                            )
                            .onChange(async (value) => {
                                this.settingsManager.settings.useCalloutsForSchedulingComments =
                                    value;
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("MIGRATE_SCHEDULING_COMMENTS_TO_CALLOUT"))
                    .setDesc(t("MIGRATE_SCHEDULING_COMMENTS_TO_CALLOUT_DESC"))
                    .addButton((button) => {
                        button
                            .setButtonText(t("MIGRATE_SCHEDULING_COMMENTS_TO_CALLOUT_BUTTON"))
                            .setClass("mod-warning")
                            .onClick(() => {
                                new ConfirmationModal(
                                    this.plugin.app,
                                    t("MIGRATE_SCHEDULING_COMMENTS_TO_CALLOUT"),
                                    t("CONFIRM_MIGRATE_SCHEDULING_COMMENTS_TO_CALLOUT"),
                                    t("MIGRATING_SCHEDULING_COMMENTS_TO_CALLOUT"),
                                    async () => {
                                        await DataStore.instance.fileModifier.migrateCommentsToCallouts();
                                        this.display();
                                    },
                                ).open();
                            });
                    });
            });

        new SettingGroup(this.containerEl)
            .setHeading(t("DELETE_SCHEDULING_DATA_ALL"))
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("DELETE_TAGS_WHEN_DELETING_SCHEDULING_DATA"))
                    .setDesc(t("DELETE_TAGS_WHEN_DELETING_SCHEDULING_DATA_DESC"))
                    .addToggle((toggle) =>
                        toggle
                            .setValue(
                                this.settingsManager.settings.deleteTagsOnSchedulingDataDeletion,
                            )
                            .onChange(async (value) => {
                                this.settingsManager.settings.deleteTagsOnSchedulingDataDeletion =
                                    value;
                                await this.settingsManager.save();
                            }),
                    );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("DELETE_SCHEDULING_DATA_ALL"))
                    .setDesc(t("DELETE_SCHEDULING_DATA_ALL_DESC"))
                    .addButton((button) => {
                        button
                            .setButtonText(t("DELETE"))
                            .setClass("mod-warning")
                            .onClick(() => {
                                new ConfirmationModal(
                                    this.plugin.app,
                                    t("DELETE_SCHEDULING_DATA_ALL"),
                                    t("CONFIRM_SCHEDULING_DATA_ALL_DELETION"),
                                    t("SCHEDULING_DATA_ALL_DELETION_IN_PROGRESS"),
                                    async () => {
                                        const settings = this.settingsManager.settings;
                                        await DataStore.instance.fileModifier.deleteAllSchedulingData(
                                            settings.deleteTagsOnSchedulingDataDeletion,
                                            settings.flashcardTags,
                                            settings.tagsToReview,
                                        );
                                    },
                                ).open();
                            });
                    });
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("DELETE_SCHEDULING_DATA_IN_NOTES"))
                    .setDesc(t("DELETE_SCHEDULING_DATA_IN_NOTES_DESC"))
                    .addButton((button) => {
                        button
                            .setButtonText(t("DELETE"))
                            .setClass("mod-warning")
                            .onClick(() => {
                                new ConfirmationModal(
                                    this.plugin.app,
                                    t("DELETE_SCHEDULING_DATA_IN_NOTES"),
                                    t("CONFIRM_SCHEDULING_DATA_IN_NOTES_DELETION"),
                                    t("SCHEDULING_DATA_IN_NOTES_DELETION_IN_PROGRESS"),
                                    async () => {
                                        await DataStore.instance.fileModifier.deleteAllSchedulingDataInNotes(
                                            this.settingsManager.settings
                                                .deleteTagsOnSchedulingDataDeletion,
                                            this.settingsManager.settings.tagsToReview,
                                        );
                                    },
                                ).open();
                            });
                    });
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("DELETE_SCHEDULING_DATA_IN_CARDS"))
                    .setDesc(t("DELETE_SCHEDULING_DATA_IN_CARDS_DESC"))
                    .addButton((button) => {
                        button
                            .setButtonText(t("DELETE"))
                            .setClass("mod-warning")
                            .onClick(() => {
                                new ConfirmationModal(
                                    this.plugin.app,
                                    t("DELETE_SCHEDULING_DATA_IN_CARDS"),
                                    t("CONFIRM_SCHEDULING_DATA_IN_CARDS_DELETION"),
                                    t("SCHEDULING_DATA_IN_CARDS_DELETION_IN_PROGRESS"),
                                    async () => {
                                        await DataStore.instance.fileModifier.deleteAllSchedulingDataInCards(
                                            this.settingsManager.settings
                                                .deleteTagsOnSchedulingDataDeletion,
                                            this.settingsManager.settings.flashcardTags,
                                        );
                                    },
                                ).open();
                            });
                    });
            });

        new SettingGroup(this.containerEl)
            .setHeading(t("GROUP_RESET_SETTINGS"))
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("GROUP_RESET_SETTINGS"))
                    .setDesc(t("GROUP_RESET_SETTINGS_DESC"))
                    .addButton((button) => {
                        button
                            .setButtonText(t("RESET_SETTINGS"))
                            .setClass("mod-warning")
                            .onClick(() => {
                                new ConfirmationModal(
                                    this.plugin.app,
                                    t("RESET_SETTINGS"),
                                    t("CONFIRM_RESET_SETTINGS"),
                                    t("RESET_SETTINGS_CONFIRMATION"),
                                    async () => {
                                        await this.settingsManager.saveSettings(DEFAULT_SETTINGS);
                                        this.display();
                                    },
                                ).open();
                            });
                    });
            });
    }

    private async renderCollectionSafety(): Promise<void> {
        this.safetyEl.empty();
        const hero = this.safetyEl.createDiv("sr-collection-safety-hero");
        const icon = hero.createDiv("sr-collection-safety-icon");
        setIcon(icon, this.integrityReport?.issues.length ? "shield-alert" : "shield-check");
        const copy = hero.createDiv("sr-collection-safety-copy");
        copy.createEl("h2", { text: t("COLLECTION_SAFETY") });
        copy.createEl("p", { text: t("COLLECTION_SAFETY_DESC") });

        const actions = hero.createDiv("sr-collection-safety-actions");
        new ButtonComponent(actions)
            .setIcon("archive")
            .setTooltip(t("CREATE_COLLECTION_BACKUP"))
            .setDisabled(this.safetyBusy)
            .onClick(() => void this.createCollectionBackup());
        new ButtonComponent(actions)
            .setButtonText(this.safetyBusy ? t("CHECKING_COLLECTION") : t("RUN_INTEGRITY_CHECK"))
            .setCta()
            .setDisabled(this.safetyBusy)
            .onClick(() => void this.runIntegrityCheck());

        if (this.integrityReport) this.renderIntegrityResult(this.integrityReport);

        const recovery = this.safetyEl.createDiv("sr-collection-recovery");
        const recoveryHeader = recovery.createDiv("sr-collection-recovery-header");
        recoveryHeader.createEl("h3", { text: t("COLLECTION_BACKUPS") });
        const backups = await this.dataManager.collectionStore.listBackups();
        if (backups.length === 0) {
            recovery.createDiv({
                cls: "sr-collection-empty",
                text: t("NO_COLLECTION_BACKUPS"),
            });
            return;
        }
        const list = recovery.createDiv("sr-collection-backup-list");
        for (const backup of backups.slice(0, 12)) {
            const row = list.createDiv("sr-collection-backup-row");
            const rowIcon = row.createDiv("sr-collection-backup-icon");
            setIcon(rowIcon, "history");
            const details = row.createDiv("sr-collection-backup-copy");
            details.createEl("strong", {
                text: new Date(backup.createdAt).toLocaleString(),
            });
            details.createSpan({ text: `${backup.reason} · schema ${backup.schemaVersion}` });
            new ButtonComponent(row)
                .setButtonText(t("RESTORE_COLLECTION_BACKUP"))
                .setDisabled(this.safetyBusy)
                .onClick(() => this.confirmRestoreBackup(backup.path));
        }
    }

    private renderIntegrityResult(report: CollectionIntegrityReport): void {
        const result = this.safetyEl.createDiv("sr-collection-health");
        const errors = report.issues.filter((issue) => issue.severity === "error").length;
        const warnings = report.issues.length - errors;
        result.toggleClass("is-healthy", report.issues.length === 0);
        const heading = result.createDiv("sr-collection-health-heading");
        heading.createEl("strong", {
            text:
                report.issues.length === 0
                    ? t("COLLECTION_HEALTHY")
                    : t("COLLECTION_ISSUES_FOUND", { count: report.issues.length }),
        });
        heading.createSpan({
            text: t("COLLECTION_COUNTS", {
                notes: report.counts.notes,
                cards: report.counts.cards,
                reviews: report.counts.reviews,
                media: report.counts.mediaReferences,
            }),
        });
        if (report.issues.length === 0) return;

        const badges = result.createDiv("sr-collection-health-badges");
        badges.createSpan({ cls: "is-error", text: t("INTEGRITY_ERRORS", { count: errors }) });
        badges.createSpan({
            cls: "is-warning",
            text: t("INTEGRITY_WARNINGS", { count: warnings }),
        });
        const issues = result.createDiv("sr-collection-issue-list");
        for (const issue of report.issues.slice(0, 12)) this.renderIntegrityIssue(issues, issue);
    }

    private renderIntegrityIssue(parent: HTMLElement, issue: CollectionIntegrityIssue): void {
        const row = parent.createDiv("sr-collection-issue-row");
        const icon = row.createDiv("sr-collection-issue-icon");
        setIcon(icon, issue.severity === "error" ? "circle-x" : "triangle-alert");
        const copy = row.createDiv("sr-collection-issue-copy");
        copy.createEl("strong", { text: this.integrityIssueLabel(issue.code) });
        copy.createSpan({
            text: [issue.entityId, issue.details].filter(Boolean).join(" · "),
        });
    }

    private integrityIssueLabel(code: IntegrityIssueCode): string {
        const labels: Record<IntegrityIssueCode, Parameters<typeof t>[0]> = {
            "missing-note-type": "INTEGRITY_MISSING_NOTE_TYPE",
            "missing-required-field": "INTEGRITY_MISSING_REQUIRED_FIELD",
            "orphan-card": "INTEGRITY_ORPHAN_CARD",
            "missing-template": "INTEGRITY_MISSING_TEMPLATE",
            "missing-deck": "INTEGRITY_MISSING_DECK",
            "missing-deck-options": "INTEGRITY_MISSING_DECK_OPTIONS",
            "duplicate-stable-key": "INTEGRITY_DUPLICATE_STABLE_KEY",
            "invalid-stable-key": "INTEGRITY_INVALID_STABLE_KEY",
            "invalid-schedule": "INTEGRITY_INVALID_SCHEDULE",
            "missing-source": "INTEGRITY_MISSING_SOURCE",
            "missing-media": "INTEGRITY_MISSING_MEDIA",
            "empty-generated-card": "INTEGRITY_EMPTY_GENERATED_CARD",
            "orphan-review": "INTEGRITY_ORPHAN_REVIEW",
            "sync-conflict": "INTEGRITY_SYNC_CONFLICT",
        };
        return t(labels[code]);
    }

    private async runIntegrityCheck(): Promise<void> {
        this.safetyBusy = true;
        await this.renderCollectionSafety();
        this.integrityReport = await this.dataManager.collectionStore.checkIntegrity();
        this.safetyBusy = false;
        await this.renderCollectionSafety();
    }

    private async createCollectionBackup(): Promise<void> {
        this.safetyBusy = true;
        await this.renderCollectionSafety();
        try {
            await this.dataManager.collectionStore.createBackup("manual");
            new Notice(t("COLLECTION_BACKUP_CREATED"));
        } catch {
            new Notice(t("COLLECTION_BACKUP_FAILED"));
        }
        this.safetyBusy = false;
        await this.renderCollectionSafety();
    }

    private confirmRestoreBackup(path: string): void {
        new ConfirmationModal(
            this.plugin.app,
            t("RESTORE_COLLECTION_BACKUP"),
            t("RESTORE_COLLECTION_BACKUP_CONFIRM"),
            t("COLLECTION_BACKUP_RESTORED"),
            async () => {
                this.safetyBusy = true;
                await this.renderCollectionSafety();
                try {
                    await this.dataManager.collectionStore.restoreBackup(path);
                    await this.dataManager.sync();
                    this.integrityReport = await this.dataManager.collectionStore.checkIntegrity();
                } catch {
                    new Notice(t("COLLECTION_RESTORE_FAILED"));
                }
                this.safetyBusy = false;
                await this.renderCollectionSafety();
            },
        ).open();
    }
}
