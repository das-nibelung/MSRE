import { Notice, TFile } from "obsidian";

import { createCardIndexStorage } from "src/data/card-index/card-index-storage";
import { IncrementalCardIndex } from "src/data/card-index/incremental-card-index";
import {
    COLLECTION_PATH,
    CollectionStore,
    REVIEW_LOG_PATH,
    VaultCollectionStorage,
} from "src/data/collection/collection-store";
import { OsrCore } from "src/data/core";
import { DataStore, StorageType } from "src/data/data-store/base/data-store";
import { DataStoreAlgorithm } from "src/data/data-store/base/data-store-algorithm";
import { NoteDataFileModifier } from "src/data/data-store/notes-data-store/note-data-file-modifier";
import { NoteDataStoreAlgorithmOsr } from "src/data/data-store/notes-data-store/note-data-store-algorithm-osr";
import { NotesDataStore } from "src/data/data-store/notes-data-store/notes-data-store";
import {
    SCHEDULE_LEDGER_PATH,
    ScheduleLedger,
    VaultScheduleLedgerStorage,
} from "src/data/data-store/schedule-ledger";
import { QuestionPostponementList } from "src/data/data-structures/card/questions/question-postponement-list";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { ISRNoteTFile, SRNoteTFile } from "src/data/data-structures/file/note-file";
import {
    FILE_NATIVE_CATALOG_PATH,
    FILE_NATIVE_SCHEMA_VERSION,
    FileNativeCatalog,
    FileNativeNoteRecord,
    hashVisibleMarkdown,
    readFileNativeDocument,
    writeFileNativeDocument,
} from "src/data/file-native/file-native-format";
import { FileNativeStore } from "src/data/file-native/file-native-store";
import { PluginData } from "src/data/plugin-data";
import { PluginDataManager } from "src/data/plugin-data-manager";
import { AtomicVaultWriter, VaultRecoveryReport } from "src/data/reliability/atomic-vault-writer";
import {
    createSemanticIndexStorage,
    SemanticIndexService,
} from "src/data/semantic/local-semantic-index";
import { SettingsUtil, SRSettings } from "src/data/settings";
import { SettingsManager } from "src/data/settings-manager";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { Note } from "src/note/note";
import { NoteFileLoader } from "src/note/note-file-loader";
import { NoteReviewQueue } from "src/note/note-review-queue";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { ReviewResponse } from "src/scheduling/algorithms/base/repetition-item";
import { SRAlgorithm } from "src/scheduling/algorithms/base/sr-algorithm";
import { SrsAlgorithmFsrs } from "src/scheduling/algorithms/fsrs/sr-algorithm-fsrs";
import { ObsidianVaultNoteLinkInfoFinder } from "src/scheduling/algorithms/osr/obsidian-vault-notelink-info-finder";
import { SRAlgorithmOsr } from "src/scheduling/algorithms/osr/srs-algorithm-osr";

/**
 * Manages all the data related systems of the Spaced Repetition plugin and exposes them to the other parts of the plugin.
 *
 * This includes the plugin data, the OSR app core, and the scheduling data repository.
 */
export class DataManager {
    private plugin: SRPlugin;
    public pluginDataManager: PluginDataManager; // TODO: Refactor so that the plugin data manager and the settings manager are separate from the data manager
    public settingsManager: SettingsManager; // TODO: Refactor so that the plugin data manager and the settings manager are separate from the data manager
    private _osrCore: OsrCore | null = null;
    private _syncLock = false;
    private cardIndex: IncrementalCardIndex;
    private scheduleLedger: ScheduleLedger | null = null;
    public readonly collectionStore: CollectionStore;
    public readonly semanticIndex: SemanticIndexService;
    public readonly vaultWriter: AtomicVaultWriter;
    private readonly fileNativeStore: FileNativeStore;
    private hasLoadedVault = false;
    private lastSyncContext: string | null = null;
    private requiresFullScan = false;
    private hydratingFileNative = false;

    constructor(
        plugin: SRPlugin,
        pluginDataManager: PluginDataManager,
        settingsManager: SettingsManager,
    ) {
        this.plugin = plugin;
        this.pluginDataManager = pluginDataManager;
        this.settingsManager = settingsManager;

        const databaseName = `${plugin.manifest.id}:card-index:${plugin.app.vault.getName()}`;
        this.cardIndex = new IncrementalCardIndex(
            settingsManager.settings,
            createCardIndexStorage(databaseName),
            plugin.getObsidianRtlSetting(),
        );
        this.vaultWriter = new AtomicVaultWriter(plugin.app.vault);
        this.collectionStore = new CollectionStore(
            new VaultCollectionStorage(plugin.app.vault, this.vaultWriter),
        );
        this.semanticIndex = new SemanticIndexService(
            createSemanticIndexStorage(
                `${plugin.manifest.id}:semantic-index:${plugin.app.vault.getName()}`,
            ),
        );
        this.fileNativeStore = new FileNativeStore(plugin.app.vault, this.vaultWriter);
        this.registerCardIndexEvents();
    }

    /**
     * Checks if the data has been loaded.
     */
    isDataLoaded(): boolean {
        return this.pluginDataManager.isLoaded;
    }

    /**
     * Checks if the OSR app core has been loaded.
     */
    isOsrCoreLoaded(): boolean {
        return this._osrCore !== null;
    }

    // TODO: Remove once everything is migrated to the settings manager and plugin data manager
    get data(): PluginData {
        return this.pluginDataManager.pluginData;
    }

    set data(data: PluginData) {
        this.pluginDataManager.pluginData = data;
    }

    get osrCore(): OsrCore {
        if (this._osrCore === null) throw new Error("SR plugin or OSR core not initialized!!!");
        return this._osrCore;
    }

    set osrCore(osrCore: OsrCore) {
        this._osrCore = osrCore;
    }

    get syncLock(): boolean {
        return this._syncLock;
    }

    /**
     * Loads the plugin data from the data.json from the plugin's folder.
     */
    loadData(): void {
        this.setupDataStoreAndAlgorithmInstances(this.settingsManager.settings);
    }

    /**
     * Initializes the OSR app core.
     *
     * @param {NoteReviewQueue} noteReviewQueue - The note review queue.
     * @param {() => void} onOsrVaultDataChanged - A callback function that is called when the OSR vault data changes.
     * @returns {Promise<void>} - A promise that resolves when the OSR app core is initialized.
     */
    async initOSRCore(
        noteReviewQueue: NoteReviewQueue,
        onOsrVaultDataChanged: () => Promise<void>,
    ): Promise<void> {
        const recovery = await this.vaultWriter.recover();
        this.reportVaultRecovery(recovery);
        await this.collectionStore.initialize();
        await this.hydrateFileNativeState();
        await this.semanticIndex.initialize(
            this.collectionStore.getCollectionSnapshot(),
            this.data.knowledgeAreas,
        );
        this.collectionStore.setChangeListener(async () => {
            if (this.hydratingFileNative) return;
            await this.persistFileNativeCatalog();
            await this.refreshSemanticIndex();
        });
        const questionPostponementList: QuestionPostponementList = new QuestionPostponementList(
            this.pluginDataManager,
            this.settingsManager.settings,
            this.pluginDataManager.pluginData.buryList,
        );
        await questionPostponementList.clearIfNewDay(this.pluginDataManager.pluginData);

        this.osrCore = new OsrCore(
            questionPostponementList,
            new ObsidianVaultNoteLinkInfoFinder(this.plugin.app.metadataCache),
            this.settingsManager.settings,
            onOsrVaultDataChanged,
            noteReviewQueue,
            this.plugin.getObsidianRtlSetting(),
            this.cardIndex,
        );
        this.applyManagedDecks();
    }

    private reportVaultRecovery(report: VaultRecoveryReport): void {
        if (report.recovered > 0) {
            new Notice(`Spaced Repetition recovered ${report.recovered} interrupted save(s).`);
        }
        if (report.conflicts > 0) {
            new Notice(
                `Spaced Repetition preserved ${report.conflicts} sync conflict(s) in Spaced Repetition/Recovery/Conflicts.`,
                10_000,
            );
        }
        if (report.failed > 0) {
            new Notice(
                `Spaced Repetition could not automatically recover ${report.failed} save(s). Recovery data was kept.`,
                10_000,
            );
        }
    }

    /** Applies deck paths created through the native UI to the in-memory deck tree. */
    applyManagedDecks(): void {
        if (this._osrCore === null) return;
        const rootTag = this.settingsManager.settings.flashcardTags[0] ?? "#flashcards";
        const rootPath = TopicPath.getTopicPathFromTag(rootTag).path;
        const paths = this.data.managedDecks.map(
            (path) => new TopicPath([...rootPath, ...path.split("/").filter(Boolean)]),
        );
        this._osrCore.setManagedDeckPaths(paths);
    }

    private registerCardIndexEvents(): void {
        this.plugin.registerEvent(
            this.plugin.app.vault.on("modify", (file) => {
                if (file instanceof TFile && file.path === FILE_NATIVE_CATALOG_PATH) {
                    void this.hydrateFileNativeCatalog();
                    return;
                }
                if (file instanceof TFile && this.isCollectionDataPath(file.path)) {
                    void this.reloadCollectionAndSemanticIndex();
                    return;
                }
                if (file instanceof TFile && file.path === SCHEDULE_LEDGER_PATH) {
                    void this.scheduleLedger?.reload();
                    return;
                }
                if (
                    file instanceof TFile &&
                    file.extension === "md" &&
                    file.path !== SCHEDULE_LEDGER_PATH
                ) {
                    void this.reconcileFileNativeFile(file);
                    void this.cardIndex.invalidate(file.path);
                }
            }),
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on("create", (file) => {
                if (file instanceof TFile && file.path === FILE_NATIVE_CATALOG_PATH) {
                    void this.hydrateFileNativeCatalog();
                    return;
                }
                if (file instanceof TFile && this.isCollectionDataPath(file.path)) {
                    void this.reloadCollectionAndSemanticIndex();
                    return;
                }
                if (file instanceof TFile && file.path === SCHEDULE_LEDGER_PATH) {
                    void this.scheduleLedger?.reload();
                    return;
                }
                if (
                    file instanceof TFile &&
                    file.extension === "md" &&
                    file.path !== SCHEDULE_LEDGER_PATH
                ) {
                    void this.reconcileFileNativeFile(file);
                    void this.cardIndex.invalidate(file.path);
                }
            }),
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on("delete", (file) => {
                if (file instanceof TFile && file.path === FILE_NATIVE_CATALOG_PATH) {
                    this.fileNativeStore.resetCatalogCache();
                    void this.persistFileNativeCatalog();
                    return;
                }
                if (file instanceof TFile && this.isCollectionDataPath(file.path)) {
                    this.collectionStore.reset();
                    void this.hydrateFileNativeState();
                    return;
                }
                if (file instanceof TFile && file.path === SCHEDULE_LEDGER_PATH) {
                    this.scheduleLedger?.reset();
                    return;
                }
                if (
                    file instanceof TFile &&
                    file.extension === "md" &&
                    file.path !== SCHEDULE_LEDGER_PATH
                ) {
                    void this.collectionStore.deleteNoteBySource(file.path);
                    void this.cardIndex.invalidate(file.path);
                } else if (!(file instanceof TFile)) {
                    this.requiresFullScan = true;
                }
            }),
        );
        this.plugin.registerEvent(
            this.plugin.app.vault.on("rename", (file, oldPath) => {
                if (oldPath === FILE_NATIVE_CATALOG_PATH) {
                    this.fileNativeStore.resetCatalogCache();
                    void this.persistFileNativeCatalog();
                } else if (this.isCollectionDataPath(oldPath)) {
                    this.collectionStore.reset();
                    void this.hydrateFileNativeState();
                }
                if (file instanceof TFile && this.isCollectionDataPath(file.path)) {
                    void this.reloadCollectionAndSemanticIndex();
                    return;
                }
                if (oldPath === SCHEDULE_LEDGER_PATH) {
                    this.scheduleLedger?.reset();
                }
                if (file instanceof TFile && file.path === SCHEDULE_LEDGER_PATH) {
                    void this.scheduleLedger?.reload();
                    return;
                }
                if (
                    file instanceof TFile &&
                    file.extension === "md" &&
                    file.path !== SCHEDULE_LEDGER_PATH
                ) {
                    void this.collectionStore.renameSourcePath(oldPath, file.path);
                    void this.cardIndex.invalidate(oldPath);
                    void this.cardIndex.invalidate(file.path);
                } else if (!(file instanceof TFile)) {
                    this.requiresFullScan = true;
                }
            }),
        );
        this.plugin.registerEvent(
            this.plugin.app.metadataCache.on("changed", (file) => {
                if (
                    file.extension === "md" &&
                    file.path !== SCHEDULE_LEDGER_PATH &&
                    !this.isCollectionDataPath(file.path)
                ) {
                    void this.cardIndex.invalidate(file.path);
                }
            }),
        );
    }

    private isCollectionDataPath(path: string): boolean {
        return (
            path === COLLECTION_PATH ||
            path === REVIEW_LOG_PATH ||
            path === FILE_NATIVE_CATALOG_PATH
        );
    }

    private async reloadCollectionAndSemanticIndex(): Promise<void> {
        await this.collectionStore.reload();
        await this.refreshSemanticIndex();
    }

    private async refreshSemanticIndex(): Promise<void> {
        await this.semanticIndex.refresh(
            this.collectionStore.getCollectionSnapshot(),
            this.data.knowledgeAreas,
        );
    }

    private async hydrateFileNativeState(): Promise<void> {
        const catalog = await this.fileNativeStore.readCatalog();
        if (catalog) await this.applyFileNativeCatalog(catalog);
        else await this.persistFileNativeCatalog();

        await this.migrateManagedNotesToFileManifests();
        const documents = await this.fileNativeStore.readAllDocuments();
        const records = documents.flatMap(({ path, manifest }) =>
            manifest.notes.map((note) => ({ path, note })),
        );
        await this.collectionStore.reconcileFileNativeNotes(records);
    }

    /** One-time, lossless migration of pre-stage-8 managed notes into their own Markdown files. */
    private async migrateManagedNotesToFileManifests(): Promise<void> {
        const snapshot = this.collectionStore.getCollectionSnapshot();
        const cards = Object.values(snapshot.cards).filter((card) => !card.deletedAt);
        for (const note of Object.values(snapshot.notes)) {
            if (note.deletedAt || note.source.kind !== "managed") continue;
            const file = this.plugin.app.vault.getAbstractFileByPath(note.source.path);
            if (!(file instanceof TFile)) continue;
            const contents = await this.plugin.app.vault.read(file);
            const manifest = readFileNativeDocument(contents);
            if (manifest?.notes.some((record) => record.id === note.id)) continue;
            const noteCards = cards
                .filter((card) => card.noteId === note.id)
                .sort((left, right) => left.ordinal - right.ordinal);
            const deckPath = noteCards[0]?.deckPath ?? "";
            const baseQuestionId = note.source.questionId;
            const legacyStableIds = Object.fromEntries(
                noteCards
                    .filter((card) => card.legacyStableId)
                    .map((card) => [card.ordinal, card.legacyStableId]),
            );
            const legacyQuestionIds = Object.fromEntries(
                noteCards.map((card) => [
                    card.ordinal,
                    noteCards.length > 1 && baseQuestionId
                        ? `${baseQuestionId}-${card.ordinal + 1}`
                        : (baseQuestionId ?? `^sr-data-id-${note.id}`),
                ]),
            );
            const record: FileNativeNoteRecord = {
                id: note.id,
                noteTypeId: note.noteTypeId,
                fields: { ...note.fields },
                answerMode: note.answerMode,
                tags: [...note.tags],
                deckPath,
                questionId: baseQuestionId,
                legacyQuestionIds,
                legacyStableIds,
                bodyHash: hashVisibleMarkdown(contents),
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
            };
            await this.vaultWriter.writeText(
                file.path,
                writeFileNativeDocument(contents, [...(manifest?.notes ?? []), record]),
            );
        }
    }

    private async hydrateFileNativeCatalog(): Promise<void> {
        const catalog = await this.fileNativeStore.readCatalog();
        if (catalog) await this.applyFileNativeCatalog(catalog);
    }

    private async applyFileNativeCatalog(catalog: FileNativeCatalog): Promise<void> {
        this.hydratingFileNative = true;
        try {
            await this.collectionStore.importFileNativeCatalog(catalog);
            this.data.managedDecks = [...new Set(catalog.managedDecks)];
            this.data.knowledgeAreas = catalog.knowledgeAreas.map((area) => ({
                ...area,
                deckPaths: [...area.deckPaths],
            }));
            await this.pluginDataManager.savePluginData();
        } finally {
            this.hydratingFileNative = false;
        }
    }

    private async reconcileFileNativeFile(file: TFile): Promise<void> {
        const manifest = await this.fileNativeStore.readDocument(file);
        if (!manifest) {
            await this.collectionStore.deleteNoteBySource(file.path);
            return;
        }
        await this.collectionStore.reconcileFileNativeNotes(
            manifest.notes.map((note) => ({ path: file.path, note })),
        );
    }

    async persistFileNativeCatalog(): Promise<void> {
        if (!this.pluginDataManager.isLoaded) return;
        const snapshot = this.collectionStore.getCollectionSnapshot();
        const noteTypes = Object.values(snapshot.noteTypes).filter((item) => !item.deletedAt);
        const deckOptions = Object.values(snapshot.deckOptions).filter((item) => !item.deletedAt);
        const decks = Object.values(snapshot.decks).filter((item) => !item.deletedAt);
        const updatedAt = Math.max(
            0,
            ...noteTypes.map((item) => item.updatedAt),
            ...deckOptions.map((item) => item.updatedAt),
            ...decks.map((item) => item.updatedAt),
        );
        await this.fileNativeStore.writeCatalog({
            schemaVersion: FILE_NATIVE_SCHEMA_VERSION,
            updatedAt,
            noteTypes,
            deckOptions,
            decks,
            managedDecks: [...this.data.managedDecks],
            knowledgeAreas: this.data.knowledgeAreas.map((area) => ({
                ...area,
                deckPaths: [...area.deckPaths],
            })),
        });
    }

    async loadVault(): Promise<void> {
        if (this._syncLock) {
            return;
        }
        this._syncLock = true;

        try {
            await DataStore.getInstance().isStructureInitialized;
            const defaultTextDirection = this.plugin.getObsidianRtlSetting();
            const parserContextChanged = this.cardIndex.setContext(
                this.settingsManager.settings,
                defaultTextDirection,
            );
            const syncContext = JSON.stringify({
                settings: this.settingsManager.settings,
                defaultTextDirection,
            });
            const settingsChanged = syncContext !== this.lastSyncContext;
            const changeToken = this.cardIndex.getChangeToken();

            this.cardIndex.resetStats();
            if (
                this.hasLoadedVault &&
                !parserContextChanged &&
                !settingsChanged &&
                !this.requiresFullScan &&
                !this.cardIndex.hasPendingChanges()
            ) {
                await this.osrCore.finalizeLoad();
                return;
            }

            const pendingPaths = this.cardIndex.getPendingPaths();
            if (
                this.hasLoadedVault &&
                !parserContextChanged &&
                !settingsChanged &&
                !this.requiresFullScan &&
                pendingPaths.length <= 500
            ) {
                for (const path of pendingPaths) {
                    if (path === SCHEDULE_LEDGER_PATH || this.isCollectionDataPath(path)) {
                        this.osrCore.removeFile(path);
                        continue;
                    }
                    const file = this.plugin.app.vault.getAbstractFileByPath(path);
                    if (!(file instanceof TFile) || file.extension !== "md") {
                        this.osrCore.removeFile(path);
                        continue;
                    }
                    if (
                        SettingsUtil.isPathInFoldersToIgnore(
                            this.settingsManager.settings,
                            file.path,
                        )
                    ) {
                        this.osrCore.removeFile(path);
                        continue;
                    }
                    await this.osrCore.replaceFile(this.createSRNoteTFile(file));
                }

                await this.osrCore.finalizeLoad();
                this.cardIndex.markSynchronized(changeToken);
                this.lastSyncContext = syncContext;
                return;
            }

            this.osrCore.loadInitialStateOfCore();

            const notes: TFile[] = this.plugin.app.vault
                .getMarkdownFiles()
                .filter(
                    (note) =>
                        note.path !== SCHEDULE_LEDGER_PATH && !this.isCollectionDataPath(note.path),
                );
            await this.cardIndex.prune(new Set(notes.map((note) => note.path)));
            for (const noteFile of notes) {
                // Skip files in the note ignore folder
                if (
                    SettingsUtil.isPathInFoldersToIgnore(
                        this.settingsManager.settings,
                        noteFile.path,
                    )
                )
                    continue;

                const file: SRNoteTFile = this.createSRNoteTFile(noteFile);
                await this.osrCore.processFile(file);
            }

            await this.osrCore.finalizeLoad();
            this.cardIndex.markSynchronized(changeToken);
            this.hasLoadedVault = true;
            this.lastSyncContext = syncContext;
            this.requiresFullScan = false;
            if (this.settingsManager.settings.showSchedulingDebugMessages) {
                const stats = this.cardIndex.getStats();
                console.log(
                    `SR: card index ${stats.hits} hits, ${stats.misses} misses, ${stats.writes} writes`,
                );
            }
        } finally {
            this._syncLock = false;
        }
    }

    /**
     * Creates a SRNoteTFile object from a note file.
     *
     * @param {TFile} note - The note file.
     * @returns {SRNoteTFile} - The SRNoteTFile object.
     */
    createSRNoteTFile(note: TFile): SRNoteTFile {
        return new SRNoteTFile(
            this.plugin.app.vault,
            this.plugin.app.metadataCache,
            this.plugin.app.fileManager,
            note,
            this.vaultWriter,
        );
    }

    /**
     * Sets up the data store and algorithm instances based on the settings.
     *
     * @param {SRSettings} settings - The settings object.
     */
    setupDataStoreAndAlgorithmInstances(settings: SRSettings) {
        switch (settings.dataStore) {
            case StorageType.NOTES: {
                const scheduleLedger = new ScheduleLedger(
                    new VaultScheduleLedgerStorage(this.plugin.app.vault, this.vaultWriter),
                );
                this.scheduleLedger = scheduleLedger;
                DataStore.instance = new NotesDataStore(
                    settings,
                    new NoteDataFileModifier(this.plugin, scheduleLedger),
                    scheduleLedger,
                );
                DataStoreAlgorithm.instance = new NoteDataStoreAlgorithmOsr(settings);
                break;
            }
        }

        // TODO: Move this to the scheduling manager once it is implemented
        SRAlgorithm.instance =
            settings.algorithm === SRAlgorithmType.FSRS
                ? new SrsAlgorithmFsrs(settings)
                : new SRAlgorithmOsr(settings);
    }

    /**
     * Synchronizes the data with the Obsidian vault.
     *
     * @returns {Promise<void>} - A promise that resolves when the synchronization is complete.
     */
    async sync(): Promise<void> {
        if (this.osrCore === null) throw new Error("OSR app core not initialized!!!");
        if (this.syncLock) {
            return;
        }

        const now = window.moment(Date.now());
        this.osrCore.defaultTextDirection = this.plugin.getObsidianRtlSetting();
        this.applyManagedDecks();

        await this.loadVault();

        if (this.settingsManager.settings.showSchedulingDebugMessages) {
            console.log(`SR: ${t("DECKS")}`, this.osrCore.reviewableDeckTree);
            console.log(
                "SR: " +
                    t("SYNC_TIME_TAKEN", {
                        t: Date.now() - now.valueOf(),
                    }),
            );
        }
    }

    /**
     * Loads a note from the Obsidian vault.
     *
     * @param {TFile} noteFile - The note file.
     * @returns {Promise<Note | null>} - A promise that resolves with the loaded note or null if not found.
     */
    async loadNote(noteFile: TFile): Promise<Note | null> {
        const loader: NoteFileLoader = new NoteFileLoader(this.settingsManager.settings);
        const srFile: ISRNoteTFile = this.createSRNoteTFile(noteFile);
        const folderTopicPath: TopicPath = TopicPath.getFolderPathFromFilename(
            srFile,
            this.settingsManager.settings,
        );

        const note: Note | null = await loader.load(
            this.createSRNoteTFile(noteFile),
            this.plugin.getObsidianRtlSetting(),
            folderTopicPath,
        );
        if (note && note.hasChanged) {
            await note.writeNoteFile(this.settingsManager.settings);
        }
        return note;
    }

    /**
     * Saves the review response for a note.
     *
     * @param {TFile} note - The note file.
     * @param {ReviewResponse} response - The review response.
     * @returns {Promise<void>} - A promise that resolves when the review response is saved.
     */
    async saveNoteReviewResponse(note: TFile, response: ReviewResponse): Promise<void> {
        if (this.osrCore === null) throw new Error("OSR app core not initialized!!!");
        if (this.plugin.nextNoteReviewHandler === null)
            throw new Error("Next note review handler not initialized!!!");

        const noteSrTFile: ISRNoteTFile = this.createSRNoteTFile(note);

        if (SettingsUtil.isPathInFoldersToIgnore(this.settingsManager.settings, note.path)) {
            new Notice(t("NOTE_IN_IGNORED_FOLDER"));
            return;
        }

        const tags = noteSrTFile.getAllTagsFromCache();
        if (!SettingsUtil.isAnyTagANoteReviewTag(this.settingsManager.settings, tags)) {
            new Notice(t("PLEASE_TAG_NOTE"));
            return;
        }

        await this.osrCore.saveNoteReviewResponse(
            noteSrTFile,
            response,
            this.settingsManager.settings,
        );

        new Notice(t("RESPONSE_RECEIVED"));

        if (this.settingsManager.settings.autoNextNote) {
            await this.plugin.nextNoteReviewHandler.autoReviewNextNote();
        }
    }

    /**
     * Saves the plugin data.
     *
     * @returns {Promise<void>} - A promise that resolves when the plugin data is saved.
     */
    async savePluginData(): Promise<void> {
        try {
            await this.pluginDataManager.savePluginData();
            await this.persistFileNativeCatalog();
            await this.refreshSemanticIndex();
        } catch (error) {
            console.warn("DataManager: Error saving plugin data", error);
        }
    }

    async rebuildSemanticIndex(): Promise<number> {
        await this.semanticIndex.clear();
        await this.semanticIndex.initialize(
            this.collectionStore.getCollectionSnapshot(),
            this.data.knowledgeAreas,
        );
        return this.semanticIndex.status.documents;
    }

    async clearSemanticIndex(): Promise<void> {
        await this.semanticIndex.clear();
    }

    close(): void {
        this.cardIndex.close();
        this.semanticIndex.close();
    }
}
