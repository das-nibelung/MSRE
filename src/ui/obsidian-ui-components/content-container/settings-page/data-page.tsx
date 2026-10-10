import "src/ui/obsidian-ui-components/content-container/settings-page/data-page.css";
import { ButtonComponent, Notice, setIcon, Setting, SettingGroup } from "obsidian";

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
