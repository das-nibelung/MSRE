import { analyzeCardQuality } from "src/data/card-quality";

describe("card quality analyzer", () => {
    test("accepts a concise atomic card", () => {
        const report = analyzeCardQuality({
            kind: "basic",
            question: "What is the capital of France?",
            answer: "Paris",
        });

        expect(report).toEqual({ score: 100, status: "strong", issues: [], blocking: false });
    });

    test("blocks missing content and unavailable local media", () => {
        const report = analyzeCardQuality({
            kind: "basic",
            question: "![[missing.png]]",
            answer: "",
            mediaExists: () => false,
        });

        expect(report.blocking).toBe(true);
        expect(report.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining(["empty-answer", "missing-media"]),
        );
    });

    test("checks native cloze selection and repeated answers", () => {
        const missing = analyzeCardQuality({
            kind: "cloze-selection",
            question: "The capital is Paris.",
            answer: "London",
        });
        const repeated = analyzeCardQuality({
            kind: "cloze-selection",
            question: "Paris is written as Paris.",
            answer: "Paris",
        });

        expect(missing.issues.some((issue) => issue.code === "cloze-answer-not-found")).toBe(true);
        expect(repeated.issues.some((issue) => issue.code === "cloze-answer-repeated")).toBe(true);
    });

    test("validates cloze markup", () => {
        const invalid = analyzeCardQuality({
            kind: "cloze-markup",
            question: "Text without a deletion",
            answer: "",
            requireAnswer: false,
        });
        const valid = analyzeCardQuality({
            kind: "cloze-markup",
            question: "The capital is {{c1::Paris}}.",
            answer: "",
            requireAnswer: false,
        });

        expect(invalid.issues.some((issue) => issue.code === "cloze-pattern-required")).toBe(true);
        expect(valid.blocking).toBe(false);
    });

    test("reports cognitive overload and answer leakage", () => {
        const report = analyzeCardQuality({
            kind: "basic",
            question: "What is Paris? Why is Paris important?",
            answer: [
                "Paris",
                "- one",
                "- two",
                "- three",
                "- four",
                "- five",
                "- six",
                "- seven",
                "- eight",
            ].join("\n"),
            duplicateCount: 2,
        });
        const codes = report.issues.map((issue) => issue.code);

        expect(codes).toEqual(
            expect.arrayContaining([
                "multiple-prompts",
                "too-many-answer-items",
                "possible-duplicate",
            ]),
        );
        expect(report.status).toBe("fair");
    });

    test("checks required custom fields without requiring an arbitrary answer field", () => {
        const report = analyzeCardQuality({
            kind: "custom",
            question: "",
            answer: "",
            requireAnswer: false,
            questionHasMedia: true,
            fields: [
                { name: "Prompt", value: "", required: true, hasMedia: true },
                { name: "Optional note", value: "", required: false },
            ],
        });

        expect(report.blocking).toBe(false);
    });

    test("parses local Markdown media and ignores remote images", () => {
        const report = analyzeCardQuality({
            kind: "basic",
            question:
                "Identify this: ![scan](<Media/scan one.png>) ![source](https://example.com/a.png)",
            answer: "A scan",
            mediaReferences: ["Media/missing.mp3"],
            mediaExists: (path) => path === "Media/scan one.png",
        });

        expect(report.issues.filter((issue) => issue.code === "missing-media")).toEqual([
            expect.objectContaining({ detail: "Media/missing.mp3" }),
        ]);
    });

    test("reports empty required fields and empty cloze deletions", () => {
        const report = analyzeCardQuality({
            kind: "cloze-markup",
            question: "The capital is {{c1::}}.",
            answer: "",
            requireAnswer: false,
            fields: [{ name: "Source", value: "", required: true }],
        });

        expect(report.issues.map((issue) => issue.code)).toEqual(
            expect.arrayContaining(["empty-required-field", "cloze-empty-deletion"]),
        );
    });

    test("flags long and dense content as a rewrite opportunity", () => {
        const longQuestion = `${Array.from({ length: 50 }, () => "context").join(" ")}?`;
        const longAnswer = Array.from({ length: 145 }, () => "detail").join(" ");
        const report = analyzeCardQuality({
            kind: "basic",
            question: longQuestion,
            answer: longAnswer,
        });
        const codes = report.issues.map((issue) => issue.code);

        expect(codes).toEqual(
            expect.arrayContaining(["question-too-long", "answer-too-long", "dense-sentence"]),
        );
    });

    test("detects when a short answer is revealed verbatim", () => {
        const report = analyzeCardQuality({
            kind: "basic",
            question: "Why is mitochondria called the powerhouse?",
            answer: "mitochondria",
        });

        expect(report.issues.some((issue) => issue.code === "answer-in-question")).toBe(true);
    });
});
