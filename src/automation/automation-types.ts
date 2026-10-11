import {
    CollectionCard,
    CollectionIntegrityReport,
    CollectionNote,
} from "src/data/collection/collection-types";
import { AiProvider, AiProviderDescriptor } from "src/intelligence/ai-types";

export const MSRE_PUBLIC_API_VERSION = 1;

export type AutomationOperationKind =
    | "create-card"
    | "create-deck"
    | "add-media"
    | "find-cards"
    | "update-note"
    | "get-statistics"
    | "check-integrity"
    | "import-cards";

export type AutomationSource = "api" | "uri" | "mcp" | "quickadd" | "templater" | "dataview";

export interface CreateCardPayload {
    deckPath: string;
    type?: "basic" | "reversed" | "cloze";
    front: string;
    back?: string;
    answerMode?: "reveal" | "type";
    tags?: string[];
}

export interface CreateDeckPayload {
    deckPath: string;
}

export interface AddMediaPayload {
    fileName: string;
    dataBase64: string;
}

export interface FindCardsPayload {
    query?: string;
    deckPath?: string;
    noteId?: string;
    tags?: string[];
    limit?: number;
}

export interface UpdateNotePayload {
    noteId: string;
    fields?: Record<string, string>;
    tags?: string[];
    deckPath?: string;
}

export interface ImportCardInput extends CreateCardPayload {
    externalId?: string;
}

export interface ImportCardsPayload {
    source: string;
    cards: ImportCardInput[];
}

export interface AutomationOperationPayloadMap {
    "create-card": CreateCardPayload;
    "create-deck": CreateDeckPayload;
    "add-media": AddMediaPayload;
    "find-cards": FindCardsPayload;
    "update-note": UpdateNotePayload;
    "get-statistics": Record<string, never>;
    "check-integrity": Record<string, never>;
    "import-cards": ImportCardsPayload;
}

export interface AutomationRequest<K extends AutomationOperationKind = AutomationOperationKind> {
    version: 1;
    id: string;
    operation: K;
    payload: AutomationOperationPayloadMap[K];
    token?: string;
    source: AutomationSource;
    requestedAt: number;
}

export interface AutomationResponse {
    version: 1;
    id: string;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
    completedAt: number;
}

export interface AutomationAuditEntry {
    version: 1;
    id: string;
    operation: AutomationOperationKind;
    source: AutomationSource;
    requestedAt: number;
    completedAt: number;
    ok: boolean;
    errorCode?: string;
}

export interface PublicCardRecord {
    card: CollectionCard;
    note: CollectionNote;
}

export interface PublicStatistics {
    notes: number;
    cards: number;
    decks: number;
    due: number;
    newCards: number;
    suspended: number;
    reviews: number;
}

export type MsreEventMap = {
    "card-created": { sourcePath: string };
    "card-updated": { noteId: string; sourcePath: string };
    "deck-created": { deckPath: string };
    "review-recorded": { reviewId: string };
    "automation-completed": AutomationAuditEntry;
};

export interface MsrePublicApi {
    readonly version: typeof MSRE_PUBLIC_API_VERSION;
    readonly capabilities: readonly AutomationOperationKind[];
    createCard(payload: CreateCardPayload, source?: AutomationSource): Promise<unknown>;
    createDeck(payload: CreateDeckPayload, source?: AutomationSource): Promise<unknown>;
    addMedia(payload: AddMediaPayload, source?: AutomationSource): Promise<unknown>;
    findCards(payload?: FindCardsPayload, source?: AutomationSource): Promise<PublicCardRecord[]>;
    updateNote(payload: UpdateNotePayload, source?: AutomationSource): Promise<unknown>;
    getStatistics(source?: AutomationSource): Promise<PublicStatistics>;
    checkIntegrity(source?: AutomationSource): Promise<CollectionIntegrityReport>;
    importCards(payload: ImportCardsPayload, source?: AutomationSource): Promise<unknown>;
    registerAiProvider(provider: AiProvider): () => void;
    listAiProviders(): Promise<AiProviderDescriptor[]>;
    execute<K extends AutomationOperationKind>(
        operation: K,
        payload: AutomationOperationPayloadMap[K],
        source?: AutomationSource,
    ): Promise<unknown>;
    on<K extends keyof MsreEventMap>(
        event: K,
        listener: (payload: MsreEventMap[K]) => void,
    ): () => void;
}
