import type { NativeCardType } from "src/data/native-card-store";

export type AiAssistantTask =
    "draft-cards" | "improve-card" | "split-card" | "make-cloze" | "suggest-answer";

export interface AiCardDraft {
    front: string;
    back: string;
    type: NativeCardType;
    tags?: string[];
    deckPath?: string;
    rationale?: string;
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
}

export interface AiAssistantResult {
    cards: AiCardDraft[];
    summary?: string;
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
