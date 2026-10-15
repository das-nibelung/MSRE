import { analyzeCardQuality, CardQualityIssue } from "src/data/card-quality";
import { AiAssistantResult, AiCardDraft } from "src/intelligence/ai-types";

export interface CompiledKnowledgeCard extends AiCardDraft {
    sourceIndex: number;
    selected: boolean;
    grounded: boolean;
    qualityScore: number;
    issues: CardQualityIssue[];
    prerequisiteCardIndexes: number[];
    prerequisitePaths: string[];
}

export interface KnowledgeCompilation {
    cards: CompiledKnowledgeCard[];
    summary: string;
    sourceCoverage: number;
    dependencyCount: number;
    warnings: string[];
}

function normalized(value: string): string {
    return value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isGrounded(sourceText: string, quote: string | undefined): boolean {
    const source = normalized(sourceText);
    const candidate = normalized(quote ?? "");
    return candidate.length >= 8 && source.includes(candidate);
}

/**
 * Converts untrusted provider output into an auditable blueprint. Invalid graph references are
 * removed here, before the UI can display or write them into the vault.
 */
export function prepareKnowledgeCompilation(
    result: AiAssistantResult,
    sourceText: string,
    allowedPrerequisitePaths: Iterable<string>,
): KnowledgeCompilation {
    const allowed = new Set(allowedPrerequisitePaths);
    const warnings: string[] = [];
    const cards = result.cards.map((card, sourceIndex): CompiledKnowledgeCard => {
        const prerequisiteCardIndexes = [...new Set(card.prerequisiteCardIndexes ?? [])].filter(
            (index) => index >= 0 && index < sourceIndex,
        );
        const prerequisitePaths = [...new Set(card.prerequisitePaths ?? [])].filter((path) =>
            allowed.has(path),
        );
        const quality = analyzeCardQuality({
            kind: card.type === "cloze" ? "cloze-selection" : "basic",
            question: card.front,
            answer: card.back,
        });
        const grounded = isGrounded(sourceText, card.sourceQuote);
        if (!grounded) warnings.push(`Card ${sourceIndex + 1} has no exact source quote`);
        if (quality.blocking) warnings.push(`Card ${sourceIndex + 1} has a blocking quality issue`);
        if ((card.prerequisiteCardIndexes?.length ?? 0) !== prerequisiteCardIndexes.length) {
            warnings.push(`Card ${sourceIndex + 1} contained an invalid dependency`);
        }
        if ((card.prerequisitePaths?.length ?? 0) !== prerequisitePaths.length) {
            warnings.push(`Card ${sourceIndex + 1} referenced a note outside local context`);
        }
        return {
            ...card,
            sourceIndex,
            selected: grounded && !quality.blocking,
            grounded,
            qualityScore: quality.score,
            issues: quality.issues,
            prerequisiteCardIndexes,
            prerequisitePaths,
        };
    });
    const groundedCharacters = cards.reduce(
        (sum, card) => sum + (card.grounded ? normalized(card.sourceQuote ?? "").length : 0),
        0,
    );
    const sourceLength = Math.max(1, normalized(sourceText).length);
    return {
        cards,
        summary: result.summary?.trim() || `${cards.length} atomic knowledge units`,
        sourceCoverage: Math.min(1, groundedCharacters / sourceLength),
        dependencyCount: cards.reduce(
            (sum, card) =>
                sum + card.prerequisiteCardIndexes.length + card.prerequisitePaths.length,
            0,
        ),
        warnings: [...new Set(warnings)],
    };
}
