import { AutomationBridge } from "src/automation/automation-bridge";
import {
    calculatePublicStatistics,
    deckPathAllowed,
    findPublicCards,
    isWriteOperation,
    requestDeckPaths,
    safeAutomationId,
} from "src/automation/automation-core";
import {
    AddMediaPayload,
    AutomationAuditEntry,
    AutomationOperationKind,
    AutomationOperationPayloadMap,
    AutomationRequest,
    AutomationSource,
    CreateCardPayload,
    CreateDeckPayload,
    FindCardsPayload,
    ImportCardsPayload,
    MSRE_PUBLIC_API_VERSION,
    MsreEventMap,
    MsrePublicApi,
    PublicCardRecord,
    PublicStatistics,
    UpdateNotePayload,
} from "src/automation/automation-types";
import {
    BACK_FIELD_ID,
    FRONT_FIELD_ID,
    noteTypeIdForNativeType,
    TEXT_FIELD_ID,
} from "src/data/collection/builtin-note-types";
import { CollectionIntegrityReport, CollectionNote } from "src/data/collection/collection-types";
import {
    NativeCardStore,
    normalizeManagedDeckPath,
    StructuredNoteDraft,
} from "src/data/native-card-store";
import { AiProvider, AiProviderDescriptor } from "src/intelligence/ai-types";
import SRPlugin from "src/main";

const CAPABILITIES: readonly AutomationOperationKind[] = [
    "create-card",
    "create-deck",
    "add-media",
    "find-cards",
    "update-note",
    "get-statistics",
    "check-integrity",
    "import-cards",
];

function decodeBase64(value: string): ArrayBuffer {
    const normalized = value.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
    const binary = atob(normalized);
    if (binary.length > 20 * 1024 * 1024) throw new Error("media-too-large");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
}

export class PersonalSpacedRepetitionApi implements MsrePublicApi {
    readonly version = MSRE_PUBLIC_API_VERSION;
    readonly capabilities = CAPABILITIES;
    readonly bridge: AutomationBridge;

    private tail: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Map<keyof MsreEventMap, Set<(payload: unknown) => void>>();

    constructor(private readonly plugin: SRPlugin) {
        this.bridge = new AutomationBridge(plugin, async (request) => {
            if (!safeAutomationId(request.id)) throw new Error("invalid-request-id");
            return await this.run(request.operation, request.payload, request.source, request);
        });
    }

    async start(): Promise<void> {
        await this.ensureAccessToken();
        const settings = this.plugin.dataManager.data.settings;
        if (settings.automationEnabled && settings.automationQueueEnabled) {
            await this.bridge.start();
        }
    }

    stop(): void {
        this.bridge.stop();
        this.listeners.clear();
    }

    async ensureAccessToken(): Promise<string> {
        const settings = this.plugin.dataManager.data.settings;
        if (settings.automationAccessToken) return settings.automationAccessToken;
        const bytes = new Uint8Array(24);
        crypto.getRandomValues(bytes);
        settings.automationAccessToken = Array.from(bytes, (value) =>
            value.toString(16).padStart(2, "0"),
        ).join("");
        await this.plugin.dataManager.settingsManager.save();
        return settings.automationAccessToken;
    }

    createCard(payload: CreateCardPayload, source: AutomationSource = "api"): Promise<unknown> {
        return this.execute("create-card", payload, source);
    }

    createDeck(payload: CreateDeckPayload, source: AutomationSource = "api"): Promise<unknown> {
        return this.execute("create-deck", payload, source);
    }

    addMedia(payload: AddMediaPayload, source: AutomationSource = "api"): Promise<unknown> {
        return this.execute("add-media", payload, source);
    }

    async findCards(
        payload: FindCardsPayload = {},
        source: AutomationSource = "api",
    ): Promise<PublicCardRecord[]> {
        return (await this.execute("find-cards", payload, source)) as PublicCardRecord[];
    }

    updateNote(payload: UpdateNotePayload, source: AutomationSource = "api"): Promise<unknown> {
        return this.execute("update-note", payload, source);
    }

    async getStatistics(source: AutomationSource = "api"): Promise<PublicStatistics> {
        return (await this.execute("get-statistics", {}, source)) as PublicStatistics;
    }

    async checkIntegrity(source: AutomationSource = "api"): Promise<CollectionIntegrityReport> {
        return (await this.execute("check-integrity", {}, source)) as CollectionIntegrityReport;
    }

    importCards(payload: ImportCardsPayload, source: AutomationSource = "api"): Promise<unknown> {
        return this.execute("import-cards", payload, source);
    }

    execute<K extends AutomationOperationKind>(
        operation: K,
        payload: AutomationOperationPayloadMap[K],
        source: AutomationSource = "api",
    ): Promise<unknown> {
        const task = () => this.run(operation, payload, source);
        const result = this.tail.then(task, task);
        this.tail = result.catch((): undefined => undefined);
        return result;
    }

    async executeUri(
        operation: AutomationOperationKind,
        payload: AutomationOperationPayloadMap[AutomationOperationKind],
        token: string,
    ): Promise<unknown> {
        const expected = this.plugin.dataManager.data.settings.automationAccessToken;
        if (!token || !expected || token !== expected) throw new Error("access-denied");
        return await this.execute(operation, payload, "uri");
    }

    on<K extends keyof MsreEventMap>(
        event: K,
        listener: (payload: MsreEventMap[K]) => void,
    ): () => void {
        const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
        return () => listeners.delete(listener);
    }

    emit<K extends keyof MsreEventMap>(event: K, payload: MsreEventMap[K]): void {
        for (const listener of this.listeners.get(event) ?? []) listener(payload);
    }

    notifyReviewRecorded(reviewId: string): void {
        this.emit("review-recorded", { reviewId });
    }

    registerAiProvider(provider: AiProvider): () => void {
        return this.plugin.ai.registerProvider(provider);
    }

    async listAiProviders(): Promise<AiProviderDescriptor[]> {
        return await this.plugin.ai.listProviders();
    }

    private async run<K extends AutomationOperationKind>(
        operation: K,
        payload: AutomationOperationPayloadMap[K],
        source: AutomationSource,
        request?: AutomationRequest,
    ): Promise<unknown> {
        const settings = this.plugin.dataManager.data.settings;
        const requestForPolicy: AutomationRequest = request ?? {
            version: 1,
            id: `direct-${Date.now().toString(36)}`,
            operation,
            payload,
            source,
            requestedAt: Date.now(),
        };
        const requestedAt = requestForPolicy.requestedAt;
        let audit: AutomationAuditEntry;
        try {
            if (!this.plugin.isInitialized) throw new Error("plugin-not-ready");
            if (!settings.automationEnabled) throw new Error("automation-disabled");
            if (isWriteOperation(operation) && !settings.automationWriteAccess) {
                throw new Error("write-access-disabled");
            }
            for (const deckPath of requestDeckPaths(requestForPolicy)) {
                if (!deckPathAllowed(deckPath, settings.automationAllowedDeckPaths)) {
                    throw new Error("deck-access-denied");
                }
            }
            if (operation === "update-note") {
                const noteId = (payload as UpdateNotePayload).noteId;
                const currentCard = Object.values(
                    this.plugin.dataManager.collectionStore.getCollectionSnapshot().cards,
                ).find((card) => !card.deletedAt && card.noteId === noteId);
                if (
                    currentCard &&
                    !deckPathAllowed(currentCard.deckPath, settings.automationAllowedDeckPaths)
                ) {
                    throw new Error("deck-access-denied");
                }
            }
            const result = await this.executeOperation(operation, payload);
            audit = {
                version: 1,
                id: requestForPolicy.id,
                operation,
                source,
                requestedAt,
                completedAt: Date.now(),
                ok: true,
            };
            return result;
        } catch (error) {
            audit = {
                version: 1,
                id: requestForPolicy.id,
                operation,
                source,
                requestedAt,
                completedAt: Date.now(),
                ok: false,
                errorCode: error instanceof Error ? error.message : "automation-failed",
            };
            throw error;
        } finally {
            await this.bridge.appendAudit(audit);
            this.emit("automation-completed", audit);
        }
    }

    private async executeOperation<K extends AutomationOperationKind>(
        operation: K,
        rawPayload: AutomationOperationPayloadMap[K],
    ): Promise<unknown> {
        const store = new NativeCardStore(this.plugin);
        if (operation === "create-card") {
            const payload = rawPayload as CreateCardPayload;
            const file = await store.createCard({
                deckPath: payload.deckPath,
                type: payload.type ?? "basic",
                front: payload.front,
                back: payload.back ?? "",
                answerMode: payload.answerMode,
                tags: payload.tags,
            });
            return { sourcePath: file.path };
        }
        if (operation === "create-deck") {
            const deckPath = await store.createDeck((rawPayload as CreateDeckPayload).deckPath);
            return { deckPath };
        }
        if (operation === "add-media") {
            const payload = rawPayload as AddMediaPayload;
            return {
                path: await store.saveMediaAsset(
                    payload.fileName,
                    decodeBase64(payload.dataBase64),
                ),
            };
        }
        if (operation === "find-cards") {
            const records = findPublicCards(
                this.plugin.dataManager.collectionStore.getCollectionSnapshot(),
                rawPayload as FindCardsPayload,
            );
            const allowed = this.plugin.dataManager.data.settings.automationAllowedDeckPaths;
            return records.filter((record) => deckPathAllowed(record.card.deckPath, allowed));
        }
        if (operation === "update-note") {
            return await this.updateStructuredNote(store, rawPayload as UpdateNotePayload);
        }
        if (operation === "get-statistics") {
            return calculatePublicStatistics(
                this.plugin.dataManager.collectionStore.getCollectionSnapshot(),
                this.plugin.dataManager.collectionStore.getReviewLogSnapshot(),
            );
        }
        if (operation === "check-integrity") {
            return await this.plugin.dataManager.collectionStore.checkIntegrity();
        }
        return await this.importStructuredCards(store, rawPayload as ImportCardsPayload);
    }

    private async updateStructuredNote(
        store: NativeCardStore,
        payload: UpdateNotePayload,
    ): Promise<{ noteId: string; sourcePath: string }> {
        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const note = snapshot.notes[payload.noteId];
        if (!note || note.deletedAt) throw new Error("note-not-found");
        const card = Object.values(snapshot.cards).find(
            (candidate) => !candidate.deletedAt && candidate.noteId === note.id,
        );
        const deckPath = normalizeManagedDeckPath(payload.deckPath ?? card?.deckPath ?? "");
        const file = await store.updateStructuredNote(note, {
            deckPath,
            noteTypeId: note.noteTypeId,
            fields: { ...note.fields, ...(payload.fields ?? {}) },
            tags: payload.tags ?? note.tags,
            externalIds: note.externalIds,
            externalData: note.externalData,
        });
        return { noteId: note.id, sourcePath: file.path };
    }

    private async importStructuredCards(
        store: NativeCardStore,
        payload: ImportCardsPayload,
    ): Promise<{ imported: number; sourcePaths: string[] }> {
        const max = this.plugin.dataManager.data.settings.automationMaxBatchSize;
        if (!Array.isArray(payload.cards) || payload.cards.length > max) {
            throw new Error("batch-limit-exceeded");
        }
        const drafts: StructuredNoteDraft[] = payload.cards.map((card) => {
            const type = card.type ?? "basic";
            const fields =
                type === "cloze"
                    ? { [TEXT_FIELD_ID]: card.front }
                    : { [FRONT_FIELD_ID]: card.front, [BACK_FIELD_ID]: card.back ?? "" };
            return {
                deckPath: card.deckPath,
                noteTypeId: noteTypeIdForNativeType(type),
                fields,
                tags: card.tags,
                externalIds: card.externalId
                    ? { [payload.source || "external"]: card.externalId }
                    : undefined,
                externalData: { importedBy: "msre-api", source: payload.source },
            };
        });
        const files = await store.createStructuredNotes(drafts);
        return { imported: files.length, sourcePaths: files.map((file) => file.path) };
    }
}

export type { MsrePublicApi } from "src/automation/automation-types";
export type { CollectionNote };
