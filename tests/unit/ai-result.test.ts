import { normalizeAiResult } from "src/intelligence/ai-result";

describe("normalizeAiResult", () => {
    test("keeps valid grounded card drafts and cleans metadata", () => {
        expect(
            normalizeAiResult({
                summary: "  Two facts  ",
                cards: [
                    {
                        front: "  What is ATP? ",
                        back: "Adenosine triphosphate ",
                        type: "basic",
                        tags: ["#biology", " energy ", 4],
                        deckPath: " Medicine/Biology ",
                    },
                    { front: "Cells use {{c1::ATP}}", back: "ATP", type: "cloze" },
                ],
            }),
        ).toEqual({
            summary: "Two facts",
            cards: [
                {
                    front: "What is ATP?",
                    back: "Adenosine triphosphate",
                    type: "basic",
                    tags: ["biology", "energy"],
                    deckPath: "Medicine/Biology",
                    rationale: undefined,
                },
                {
                    front: "Cells use {{c1::ATP}}",
                    back: "ATP",
                    type: "cloze",
                    tags: undefined,
                    deckPath: undefined,
                    rationale: undefined,
                },
            ],
        });
    });

    test("rejects a response without usable cards", () => {
        expect(() => normalizeAiResult({ cards: [{ front: "", back: "missing" }] })).toThrow(
            "empty-ai-response",
        );
        expect(() => normalizeAiResult({ value: [] })).toThrow("invalid-ai-response");
    });
});
