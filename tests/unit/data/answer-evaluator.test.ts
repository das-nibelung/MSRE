import {
    canonicalAnswerMode,
    createAnswerDiff,
    createDefaultAnswerConfig,
    evaluateAnswer,
    formulasAreEquivalent,
    normalizeAnswer,
    normalizeAnswerConfig,
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

    it("normalizes incomplete template settings without retaining empty values", () => {
        const defaults = createDefaultAnswerConfig();
        const config = normalizeAnswerConfig({
            acceptedAnswers: [" answer ", "answer", ""],
            synonymGroups: [["only"], [" infarction ", "MI", "MI"]],
            parts: [
                {
                    id: "",
                    label: "",
                    answerFieldId: undefined as unknown as null,
                    acceptedAnswers: [" value ", ""],
                    requiredKeywords: [" key ", "key"],
                    optional: false,
                    weight: -2,
                },
            ],
            numeric: {
                ...defaults.numeric,
                units: [" mg ", "mg"],
                unitFactors: { mg: 0.001 },
            },
            choices: [{ id: "", label: " Choice ", correct: 1 as unknown as boolean }],
        });

        expect(defaults.normalization.ignoreCase).toBe(true);
        expect(config.acceptedAnswers).toEqual(["answer"]);
        expect(config.synonymGroups).toEqual([["infarction", "MI"]]);
        expect(config.parts[0]).toMatchObject({
            id: "part-1",
            label: "Part 1",
            answerFieldId: null,
            acceptedAnswers: ["value"],
            requiredKeywords: ["key"],
            optional: false,
            weight: 0,
        });
        expect(config.numeric.units).toEqual(["mg"]);
        expect(config.choices[0]).toEqual({ id: "choice-1", label: "Choice", correct: true });
        expect(canonicalAnswerMode("type")).toBe("text");
        expect(canonicalAnswerMode()).toBe("reveal");
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

    it("handles relative tolerance, one-sided ranges, invalid numbers, and rejected units", () => {
        expect(
            evaluateAnswer({
                mode: "number",
                expected: "100 kg",
                values: "105 kg",
                config: {
                    numeric: {
                        tolerance: 0,
                        relativeTolerance: 0.05,
                        min: null,
                        max: null,
                        units: ["kg"],
                        unitFactors: {},
                    },
                },
            }).status,
        ).toBe("correct");
        expect(
            evaluateAnswer({
                mode: "number",
                expected: "",
                values: "10",
                config: { numeric: { ...createDefaultAnswerConfig().numeric, min: 5 } },
            }).status,
        ).toBe("correct");
        expect(
            evaluateAnswer({
                mode: "number",
                expected: "",
                values: "10",
                config: { numeric: { ...createDefaultAnswerConfig().numeric, max: 9 } },
            }).status,
        ).toBe("incorrect");
        expect(
            evaluateAnswer({ mode: "number", expected: "10", values: "not a number" }).status,
        ).toBe("incorrect");
        expect(
            evaluateAnswer({
                mode: "number",
                expected: "10 kg",
                values: "10 lb",
                config: {
                    numeric: { ...createDefaultAnswerConfig().numeric, units: ["kg"] },
                },
            }).status,
        ).toBe("incorrect");
    });

    it("compares equivalent arithmetic and LaTeX formulas", () => {
        expect(formulasAreEquivalent("x+x", "2*x")).toBe(true);
        expect(formulasAreEquivalent("\\frac{x}{2}", "x/2")).toBe(true);
        expect(formulasAreEquivalent("-(x^2)+\\sqrt{4}+\\pi+e", "-x**2+2+pi+e")).toBe(true);
        expect(formulasAreEquivalent("x+1", "x+2")).toBe(false);
        expect(formulasAreEquivalent("(x+1", "x+1")).toBe(false);
    });

    it("evaluates formula answers and their accepted equivalents", () => {
        expect(
            evaluateAnswer({
                mode: "formula",
                expected: "x+x",
                values: "2*x",
                config: { acceptedAnswers: ["2x"] },
            }).status,
        ).toBe("correct");
        expect(evaluateAnswer({ mode: "formula", expected: "x+1", values: "x+3" }).status).toBe(
            "incorrect",
        );
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

    it("supports compact comma and semicolon separated lists", () => {
        expect(
            evaluateAnswer({
                mode: "ordered-list",
                expected: "one,two",
                values: "one,two",
                config: { listSeparator: "comma" },
            }).status,
        ).toBe("correct");
        expect(
            evaluateAnswer({
                mode: "unordered-list",
                expected: "one;two;three",
                values: "three;one",
                config: { listSeparator: "semicolon" },
            }).status,
        ).toBe("partial");
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

        expect(
            evaluateAnswer({
                mode: "multiple-choice",
                expected: "",
                values: "a",
                config: { choices: config.choices, multipleChoice: false },
            }).status,
        ).toBe("partial");
    });

    it("can disable partial credit and safely handle a template without answer parts", () => {
        expect(
            evaluateAnswer({
                mode: "text",
                expected: "acute heart failure",
                values: "acute failure",
                config: { allowPartial: false },
            }).status,
        ).toBe("incorrect");
        expect(evaluateAnswer({ mode: "multiple-text", expected: "", values: {} }).status).toBe(
            "incorrect",
        );
        expect(evaluateAnswer({ mode: "reveal", expected: "", values: "" }).status).toBe(
            "unanswered",
        );
    });

    it("builds a word-level difference", () => {
        expect(createAnswerDiff("acute failure", "acute heart failure")).toEqual([
            { value: "acute", kind: "same" },
            { value: "heart", kind: "missing" },
            { value: "failure", kind: "same" },
        ]);
        expect(createAnswerDiff("acute severe failure", "acute failure")).toEqual([
            { value: "acute", kind: "same" },
            { value: "severe", kind: "extra" },
            { value: "failure", kind: "same" },
        ]);
    });
});
