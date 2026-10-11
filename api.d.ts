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
    registerAiProvider(provider: {
        id: string;
        label: string;
        description?: string;
        isAvailable?: () => boolean | Promise<boolean>;
        run(request: {
            id: string;
            task:
                | "draft-cards"
                | "improve-card"
                | "split-card"
                | "make-cloze"
                | "suggest-answer"
                | "shorten"
                | "clarify"
                | "merge-card"
                | "reverse-card"
                | "accepted-answers"
                | "generate-hint"
                | "explain-card"
                | "generate-templates";
            locale: string;
            sourceText: string;
            currentCard?: {
                front: string;
                back: string;
                type: "basic" | "reversed" | "cloze";
                tags: string[];
                deckPath: string;
            };
            maximumCards: number;
        }): Promise<{
            cards: Array<{
                front: string;
                back: string;
                type: "basic" | "reversed" | "cloze";
                tags?: string[];
                deckPath?: string;
                rationale?: string;
            }>;
            summary?: string;
            replacement?: string;
            acceptedAnswers?: string[];
            hint?: string;
            explanation?: string;
        }>;
    }): () => void;
    listAiProviders(): Promise<
        Array<{
            id: string;
            label: string;
            description: string;
            kind: "api" | "mcp" | "plugin";
            available: boolean;
        }>
    >;
    on(event: string, listener: (payload: unknown) => void): () => void;
}
