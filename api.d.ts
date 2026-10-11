export type MsreAutomationSource = "api" | "uri" | "mcp" | "quickadd" | "templater" | "dataview";

export interface MsreCardInput {
    deckPath: string;
    type?: "basic" | "reversed" | "cloze";
    front: string;
    back?: string;
    answerMode?: "reveal" | "type";
    tags?: string[];
}

export interface MsrePublicApi {
    readonly version: 1;
    readonly capabilities: readonly string[];
    createCard(payload: MsreCardInput, source?: MsreAutomationSource): Promise<unknown>;
    createDeck(payload: { deckPath: string }, source?: MsreAutomationSource): Promise<unknown>;
    addMedia(
        payload: { fileName: string; dataBase64: string },
        source?: MsreAutomationSource,
    ): Promise<{ path: string }>;
    findCards(
        payload?: {
            query?: string;
            deckPath?: string;
            noteId?: string;
            tags?: string[];
            limit?: number;
        },
        source?: MsreAutomationSource,
    ): Promise<unknown[]>;
    updateNote(
        payload: {
            noteId: string;
            fields?: Record<string, string>;
            tags?: string[];
            deckPath?: string;
        },
        source?: MsreAutomationSource,
    ): Promise<unknown>;
    getStatistics(source?: MsreAutomationSource): Promise<unknown>;
    checkIntegrity(source?: MsreAutomationSource): Promise<unknown>;
    importCards(
        payload: { source: string; cards: Array<MsreCardInput & { externalId?: string }> },
        source?: MsreAutomationSource,
    ): Promise<unknown>;
    on(event: string, listener: (payload: unknown) => void): () => void;
}
