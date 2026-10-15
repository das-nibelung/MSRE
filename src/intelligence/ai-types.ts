import type { NativeCardType } from "src/data/native-card-store";

export type AiAssistantTask =
    | "compile-knowledge"
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

export interface AiCardDraft {
    front: string;
    back: string;
    type: NativeCardType;
    tags?: string[];
    deckPath?: string;
    rationale?: string;
    /** Stable human-readable concept represented by this atomic card. */
    concept?: string;
    /** Short verbatim fragment that grounds the proposal in the source. */
    sourceQuote?: string;
    /** Existing vault note paths that must be understood before this card. */
    prerequisitePaths?: string[];
    /** Zero-based indexes of other proposed cards that are prerequisites. */
    prerequisiteCardIndexes?: number[];
    /** Provider confidence, clamped to 0…1. */
    confidence?: number;
}

export interface AiContextNote {
    path: string;
    title: string;
    excerpt: string;
}

export interface AiAttachment {
    name: string;
    mimeType: string;
    kind: "image" | "audio";
    /** Vault-local path remains useful to MCP and registered Obsidian providers. */
    vaultPath: string;
    /** Direct API providers receive an in-memory data URL; it is never persisted. */
    dataUrl?: string;
}

export interface AiAssistantRequest {
    id: string;
    task: AiAssistantTask;
    locale: string;
    sourceText: string;
    currentCard?: {
        front: string;
        back: string;
        type: NativeCardType;
        tags: string[];
        deckPath: string;
    };
    maximumCards: number;
    /** Read-only candidates selected locally; they may be used only as prerequisite references. */
    contextNotes?: AiContextNote[];
    attachments?: AiAttachment[];
}

export interface AiAssistantResult {
    cards: AiCardDraft[];
    summary?: string;
    /** Replacement for the exact field or selection supplied by the user. */
    replacement?: string;
    /** Alternative answers that should grade as correct for this card only. */
    acceptedAnswers?: string[];
    /** A short, non-answer-revealing hint. */
    hint?: string;
    /** Read-only diagnosis of why the current material is difficult to review. */
    explanation?: string;
}

export type AiProviderKind = "api" | "mcp" | "plugin";

export interface AiProviderDescriptor {
    id: string;
    label: string;
    description: string;
    kind: AiProviderKind;
    available: boolean;
}

export interface AiProvider {
    id: string;
    label: string;
    description?: string;
    isAvailable?: () => boolean | Promise<boolean>;
    run(request: AiAssistantRequest): Promise<AiAssistantResult>;
}

export interface AiBridgeRequest extends AiAssistantRequest {
    version: 1;
    requestedAt: number;
    responseSchema: "msre-ai-cards-v1";
}

export interface AiBridgeResponse {
    version: 1;
    id: string;
    ok: boolean;
    result?: AiAssistantResult;
    error?: { code: string; message: string };
    completedAt: number;
}
