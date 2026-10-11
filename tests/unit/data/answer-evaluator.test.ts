import {
    createAnswerDiff,
    evaluateAnswer,
    formulasAreEquivalent,
    normalizeAnswer,
} from "src/data/collection/answer-evaluator";

describe("answer evaluator", () => {
    it("normalizes case, punctuation, spaces, and Russian ё", () => {
        expect(
            normalizeAnswer("  Ёлка,  ЗЕЛЁНАЯ! ", {
                ignoreCase: true,
                ignoreWhitespace: true,
                ignorePunctuation: true,
                normalizeYo: true,
            }),
        ).toBe("елка зеленая");
    });

    it("accepts alternatives and synonym groups", () => {
        const result = evaluateAnswer({
            mode: "text",
            expected: "myocardial infarction",
            values: "MI",
            config: {
                acceptedAnswers: ["heart attack"],
                synonymGroups: [["myocardial infarction", "MI", "heart attack"]],
            },
        });
        expect(result.status).toBe("correct");
        expect(result.score).toBe(1);
    });

    it("scores required elements as a partial compound answer", () => {
        const result = evaluateAnswer({
            mode: "text",
            expected: "offer acceptance consideration intention",
            values: "offer and acceptance",
            config: {
                requiredKeywords: ["offer", "acceptance", "consideration", "intention"],
                allowPartial: true,
            },
        });
        expect(result.status).toBe("partial");
        expect(result.score).toBe(0.5);
        expect(result.missingKeywords).toEqual(["consideration", "intention"]);
    });

    it("supports absolute tolerance, ranges, units, and conversions", () => {
        const tolerance = evaluateAnswer({
            mode: "number",
            expected: "1 g",
            values: "1001 mg",
            config: {
                numeric: {
                    tolerance: 0.01,
                    relativeTolerance: 0,
                    min: null,
                    max: null,
                    units: ["g", "mg"],
                    unitFactors: { g: 1, mg: 0.001 },
                },
            },
        });
        expect(tolerance.status).toBe("correct");

        const range = evaluateAnswer({
            mode: "number",
            expected: "",
            values: "7.4 mmol/l",
            config: {
                numeric: {
                    tolerance: 0,
                    relativeTolerance: 0,
                    min: 7.35,
                    max: 7.45,
                    units: ["mmol/l"],
                    unitFactors: {},
                },
            },
        });
        expect(range.status).toBe("correct");
    });

    it("compares equivalent arithmetic and LaTeX formulas", () => {
        expect(formulasAreEquivalent("x+x", "2*x")).toBe(true);
        expect(formulasAreEquivalent("\\frac{x}{2}", "x/2")).toBe(true);
        expect(formulasAreEquivalent("x+1", "x+2")).toBe(false);
    });

    it("distinguishes ordered and unordered lists", () => {
        const ordered = evaluateAnswer({
            mode: "ordered-list",
            expected: "one\ntwo\nthree",
            values: "three\ntwo\none",
        });
        const unordered = evaluateAnswer({
            mode: "unordered-list",
            expected: "one\ntwo\nthree",
            values: "three\ntwo\none",
        });
        expect(ordered.status).not.toBe("correct");
        expect(unordered.status).toBe("correct");
    });

    it("evaluates multiple fields and image labels independently", () => {
        const result = evaluateAnswer({
            mode: "image-labels",
            expected: "",
            values: { artery: "aorta", nerve: "vagus" },
            fieldValues: { expectedArtery: "aorta", expectedNerve: "phrenic" },
            config: {
                parts: [
                    {
                        id: "artery",
                        label: "Artery",
                        answerFieldId: "expectedArtery",
                        acceptedAnswers: [],
                        requiredKeywords: [],
                        optional: false,
                        weight: 1,
                    },
                    {
                        id: "nerve",
                        label: "Nerve",
                        answerFieldId: "expectedNerve",
                        acceptedAnswers: [],
                        requiredKeywords: [],
                        optional: false,
                        weight: 1,
                    },
                ],
            },
        });
        expect(result.status).toBe("partial");
        expect(result.score).toBe(0.5);
    });

    it("uses the current occlusion label when no custom label parts are configured", () => {
        const result = evaluateAnswer({
            mode: "image-labels",
            expected: "left ventricle",
            values: { label: "Left ventricle" },
        });
        expect(result.status).toBe("correct");
    });

    it("supports single and multiple correct choices", () => {
        const config = {
            choices: [
                { id: "a", label: "A", correct: true },
                { id: "b", label: "B", correct: false },
                { id: "c", label: "C", correct: true },
            ],
            multipleChoice: true,
        };
        expect(
            evaluateAnswer({ mode: "multiple-choice", expected: "", values: ["a", "c"], config })
                .status,
        ).toBe("correct");
        expect(
            evaluateAnswer({ mode: "multiple-choice", expected: "", values: ["a", "b"], config })
                .status,
        ).toBe("partial");
    });

    it("builds a word-level difference", () => {
        expect(createAnswerDiff("acute failure", "acute heart failure")).toEqual([
            { value: "acute", kind: "same" },
            { value: "heart", kind: "missing" },
            { value: "failure", kind: "same" },
        ]);
    });
});
