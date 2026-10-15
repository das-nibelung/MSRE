import { AiAssistantResult, AiCardDraft } from "src/intelligence/ai-types";

const MAX_CARDS = 12;

export function normalizeAiResult(value: unknown): AiAssistantResult {
    if (!value || typeof value !== "object") throw new Error("invalid-ai-response");
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.cards)) throw new Error("invalid-ai-response");
    const cards = record.cards.slice(0, MAX_CARDS).flatMap((candidate): AiCardDraft[] => {
        if (!candidate || typeof candidate !== "object") return [];
        const card = candidate as Record<string, unknown>;
        const front = typeof card.front === "string" ? card.front.trim() : "";
        const back = typeof card.back === "string" ? card.back.trim() : "";
        if (!front || !back) return [];
        const type =
            card.type === "cloze" || card.type === "reversed" ? card.type : ("basic" as const);
        return [
            {
                front,
                back,
                type,
                tags: Array.isArray(card.tags)
                    ? card.tags
                          .filter((tag): tag is string => typeof tag === "string")
                          .map((tag) => tag.trim().replace(/^#+/, ""))
                          .filter(Boolean)
                          .slice(0, 12)
                    : undefined,
                deckPath:
                    typeof card.deckPath === "string" && card.deckPath.trim()
                        ? card.deckPath.trim()
                        : undefined,
                rationale: typeof card.rationale === "string" ? card.rationale.trim() : undefined,
                concept:
                    typeof card.concept === "string" && card.concept.trim()
                        ? card.concept.trim().slice(0, 160)
                        : undefined,
                sourceQuote:
                    typeof card.sourceQuote === "string" && card.sourceQuote.trim()
                        ? card.sourceQuote.trim().slice(0, 500)
                        : undefined,
                prerequisitePaths: Array.isArray(card.prerequisitePaths)
                    ? card.prerequisitePaths
                          .filter((path): path is string => typeof path === "string")
                          .map((path) => path.trim().replace(/^\[\[|\]\]$/g, ""))
                          .filter(Boolean)
                          .filter((path, index, all) => all.indexOf(path) === index)
                          .slice(0, 12)
                    : undefined,
                prerequisiteCardIndexes: Array.isArray(card.prerequisiteCardIndexes)
                    ? card.prerequisiteCardIndexes
                          .map(Number)
                          .filter(
                              (index, position, all) =>
                                  Number.isInteger(index) &&
                                  index >= 0 &&
                                  index < MAX_CARDS &&
                                  all.indexOf(index) === position,
                          )
                          .slice(0, 12)
                    : undefined,
                confidence:
                    typeof card.confidence === "number" && Number.isFinite(card.confidence)
                        ? Math.max(0, Math.min(1, card.confidence))
                        : undefined,
            },
        ];
    });
    const replacement = typeof record.replacement === "string" ? record.replacement.trim() : "";
    const acceptedAnswers = Array.isArray(record.acceptedAnswers)
        ? record.acceptedAnswers
              .filter((answer): answer is string => typeof answer === "string")
              .map((answer) => answer.trim())
              .filter(Boolean)
              .filter((answer, index, all) => all.indexOf(answer) === index)
              .slice(0, 24)
        : [];
    const hint = typeof record.hint === "string" ? record.hint.trim() : "";
    const explanation = typeof record.explanation === "string" ? record.explanation.trim() : "";
    if (
        cards.length === 0 &&
        !replacement &&
        acceptedAnswers.length === 0 &&
        !hint &&
        !explanation
    ) {
        throw new Error("empty-ai-response");
    }
    return {
        cards,
        summary: typeof record.summary === "string" ? record.summary.trim() : undefined,
        replacement: replacement || undefined,
        acceptedAnswers: acceptedAnswers.length ? acceptedAnswers : undefined,
        hint: hint || undefined,
        explanation: explanation || undefined,
    };
}
