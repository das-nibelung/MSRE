import {
    AnswerNormalizationOptions,
    AnswerPartDefinition,
    CardAnswerConfig,
    CardAnswerMode,
} from "src/data/collection/collection-types";

export type AnswerValue = string | string[] | Record<string, string>;
export type AnswerEvaluationStatus = "unanswered" | "correct" | "partial" | "incorrect";

export interface AnswerDiffToken {
    value: string;
    kind: "same" | "missing" | "extra";
}

export interface AnswerPartResult {
    id: string;
    label: string;
    submitted: string;
    expected: string;
    score: number;
    correct: boolean;
    optional: boolean;
    weight: number;
    missingKeywords: string[];
    missingOptionalKeywords: string[];
    diff: AnswerDiffToken[];
}

export interface AnswerEvaluationResult {
    status: AnswerEvaluationStatus;
    score: number;
    parts: AnswerPartResult[];
    missingKeywords: string[];
    missingOptionalKeywords: string[];
    expected: string[];
}

export interface AnswerEvaluationContext {
    mode: CardAnswerMode;
    expected: string;
    config?: Partial<CardAnswerConfig>;
    values: AnswerValue;
    fieldValues?: Record<string, string>;
}

export function createDefaultAnswerConfig(): CardAnswerConfig {
    return {
        acceptedAnswers: [],
        synonymGroups: [],
        requiredKeywords: [],
        optionalKeywords: [],
        normalization: {
            ignoreCase: true,
            ignoreWhitespace: true,
            ignorePunctuation: true,
            normalizeYo: true,
        },
        allowPartial: true,
        parts: [],
        numeric: {
            tolerance: 0,
            relativeTolerance: 0,
            min: null,
            max: null,
            units: [],
            unitFactors: {},
        },
        listSeparator: "newline",
        choices: [],
        multipleChoice: false,
    };
}

export function normalizeAnswerConfig(config?: Partial<CardAnswerConfig>): CardAnswerConfig {
    const base = createDefaultAnswerConfig();
    return {
        ...base,
        ...config,
        acceptedAnswers: cleanList(config?.acceptedAnswers),
        synonymGroups: (config?.synonymGroups ?? [])
            .map((group) => cleanList(group))
            .filter((group) => group.length > 1),
        requiredKeywords: cleanList(config?.requiredKeywords),
        optionalKeywords: cleanList(config?.optionalKeywords),
        normalization: { ...base.normalization, ...(config?.normalization ?? {}) },
        parts: (config?.parts ?? []).map((part, index) => ({
            id: part.id || `part-${index + 1}`,
            label: part.label || `Part ${index + 1}`,
            answerFieldId: part.answerFieldId ?? null,
            acceptedAnswers: cleanList(part.acceptedAnswers),
            requiredKeywords: cleanList(part.requiredKeywords),
            optional: Boolean(part.optional),
            weight: Math.max(0, Number(part.weight) || 1),
        })),
        numeric: {
            ...base.numeric,
            ...(config?.numeric ?? {}),
            units: cleanList(config?.numeric?.units),
            unitFactors: { ...(config?.numeric?.unitFactors ?? {}) },
        },
        choices: (config?.choices ?? []).map((choice, index) => ({
            id: choice.id || `choice-${index + 1}`,
            label: choice.label.trim(),
            correct: Boolean(choice.correct),
        })),
    };
}

function cleanList(values?: string[]): string[] {
    return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function canonicalAnswerMode(mode?: CardAnswerMode): CardAnswerMode {
    return mode === "type" ? "text" : (mode ?? "reveal");
}

export function normalizeAnswer(value: string, options: AnswerNormalizationOptions): string {
    let result = value.normalize("NFKC").trim();
    if (options.normalizeYo) result = result.replaceAll("ё", "е").replaceAll("Ё", "Е");
    if (options.ignoreCase) result = result.toLocaleLowerCase();
    if (options.ignorePunctuation) result = result.replace(/[\p{P}\p{S}]+/gu, " ");
    if (options.ignoreWhitespace) result = result.replace(/\s+/g, " ").trim();
    return result;
}

function applySynonyms(value: string, config: CardAnswerConfig): string {
    let normalized = normalizeAnswer(value, config.normalization);
    for (const group of config.synonymGroups) {
        const terms = group
            .map((term) => normalizeAnswer(term, config.normalization))
            .filter(Boolean)
            .sort((left, right) => right.length - left.length);
        const canonical = terms[0];
        if (!canonical) continue;
        for (const term of terms) {
            const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            normalized = normalized.replace(
                new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, "gu"),
                `$1${canonical}`,
            );
        }
    }
    return normalized;
}

function words(value: string): string[] {
    return value.split(/\s+/).filter(Boolean);
}

/** Small LCS diff for concise review feedback; input is already normalized. */
export function createAnswerDiff(submitted: string, expected: string): AnswerDiffToken[] {
    const left = words(submitted);
    const right = words(expected);
    const table = Array.from({ length: left.length + 1 }, () =>
        Array.from({ length: right.length + 1 }, () => 0),
    );
    for (let i = left.length - 1; i >= 0; i--) {
        for (let j = right.length - 1; j >= 0; j--) {
            table[i][j] =
                left[i] === right[j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const result: AnswerDiffToken[] = [];
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
        if (left[i] === right[j]) {
            result.push({ value: left[i], kind: "same" });
            i++;
            j++;
        } else if (j < right.length && (i >= left.length || table[i][j + 1] >= table[i + 1][j])) {
            result.push({ value: right[j], kind: "missing" });
            j++;
        } else {
            result.push({ value: left[i], kind: "extra" });
            i++;
        }
    }
    return result;
}

function keywordCoverage(submitted: string, keywords: string[], config: CardAnswerConfig) {
    const value = applySynonyms(submitted, config);
    const missing = keywords.filter((keyword) => !value.includes(applySynonyms(keyword, config)));
    return {
        missing,
        score: keywords.length === 0 ? 1 : (keywords.length - missing.length) / keywords.length,
    };
}

function levenshteinSimilarity(left: string, right: string): number {
    if (left === right) return 1;
    if (!left || !right) return 0;
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let i = 1; i <= left.length; i++) {
        let diagonal = previous[0];
        previous[0] = i;
        for (let j = 1; j <= right.length; j++) {
            const above = previous[j];
            previous[j] = Math.min(
                previous[j] + 1,
                previous[j - 1] + 1,
                diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
            );
            diagonal = above;
        }
    }
    return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function evaluateTextPart(
    submitted: string,
    expected: string,
    acceptedAnswers: string[],
    requiredKeywords: string[],
    config: CardAnswerConfig,
    part: Pick<AnswerPartDefinition, "id" | "label" | "optional"> & { weight?: number },
): AnswerPartResult {
    const candidates = cleanList([expected, ...acceptedAnswers]);
    const normalizedSubmitted = applySynonyms(submitted, config);
    const normalizedCandidates = candidates.map((candidate) => applySynonyms(candidate, config));
    const exact = normalizedCandidates.some((candidate) => candidate === normalizedSubmitted);
    const keywordResult = keywordCoverage(submitted, requiredKeywords, config);
    const optionalKeywordResult = keywordCoverage(submitted, config.optionalKeywords, config);
    const similarity = Math.max(
        0,
        ...normalizedCandidates.map((candidate) =>
            levenshteinSimilarity(normalizedSubmitted, candidate),
        ),
    );
    const score = exact ? 1 : requiredKeywords.length > 0 ? keywordResult.score : similarity;
    const closest = normalizedCandidates.reduce(
        (best, candidate) =>
            levenshteinSimilarity(normalizedSubmitted, candidate) >
            levenshteinSimilarity(normalizedSubmitted, best)
                ? candidate
                : best,
        normalizedCandidates[0] ?? "",
    );
    return {
        id: part.id,
        label: part.label,
        submitted,
        expected: candidates[0] ?? "",
        score,
        correct: exact || (requiredKeywords.length > 0 && keywordResult.missing.length === 0),
        optional: part.optional,
        weight: Math.max(0, part.weight ?? 1),
        missingKeywords: keywordResult.missing,
        missingOptionalKeywords: optionalKeywordResult.missing,
        diff: createAnswerDiff(normalizedSubmitted, closest),
    };
}

function parseNumeric(
    value: string,
    config: CardAnswerConfig,
): { value: number; unit: string } | null {
    const normalized = value.trim().replace(",", ".");
    const match = normalized.match(/[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?/i);
    if (!match) return null;
    let numeric = Number(match[0]);
    if (!Number.isFinite(numeric)) return null;
    const unit = normalized
        .slice((match.index ?? 0) + match[0].length)
        .trim()
        .toLocaleLowerCase();
    const factors = Object.fromEntries(
        Object.entries(config.numeric.unitFactors).map(([key, factor]) => [
            key.toLocaleLowerCase(),
            factor,
        ]),
    );
    numeric *= factors[unit] ?? 1;
    return { value: numeric, unit };
}

function evaluateNumber(
    submitted: string,
    expected: string,
    config: CardAnswerConfig,
): AnswerPartResult {
    const actual = parseNumeric(submitted, config);
    const target = parseNumeric(expected, config);
    const unitAllowed =
        !actual ||
        config.numeric.units.length === 0 ||
        config.numeric.units.map((unit) => unit.toLocaleLowerCase()).includes(actual.unit) ||
        actual.unit in config.numeric.unitFactors;
    let correct = false;
    let score = 0;
    if (actual && unitAllowed) {
        if (config.numeric.min !== null || config.numeric.max !== null) {
            const min = config.numeric.min ?? Number.NEGATIVE_INFINITY;
            const max = config.numeric.max ?? Number.POSITIVE_INFINITY;
            correct = actual.value >= min && actual.value <= max;
        } else if (target) {
            const tolerance = Math.max(
                config.numeric.tolerance,
                Math.abs(target.value) * config.numeric.relativeTolerance,
            );
            correct = Math.abs(actual.value - target.value) <= tolerance;
            score = correct
                ? 1
                : Math.max(
                      0,
                      1 -
                          Math.abs(actual.value - target.value) /
                              Math.max(1, Math.abs(target.value)),
                  );
        }
    }
    if (correct) score = 1;
    return {
        id: "answer",
        label: "Answer",
        submitted,
        expected,
        score,
        correct,
        optional: false,
        weight: 1,
        missingKeywords: [],
        missingOptionalKeywords: [],
        diff: createAnswerDiff(submitted, expected),
    };
}

function normalizeFormula(value: string): string {
    let result = value
        .replace(/\$+/g, "")
        .replace(/\\left|\\right/g, "")
        .replace(/\\cdot|\\times/g, "*")
        .replace(/\\pi/g, "pi")
        .replace(/\s+/g, "")
        .replaceAll("{", "(")
        .replaceAll("}", ")")
        .replaceAll("^", "**");
    for (let pass = 0; pass < 4; pass++) {
        result = result.replace(/\\frac\(([^()]*)\)\(([^()]*)\)/g, "(($1)/($2))");
        result = result.replace(/\\sqrt\(([^()]*)\)/g, "sqrt($1)");
    }
    return result.toLocaleLowerCase();
}

class FormulaParser {
    private index = 0;
    constructor(
        private readonly source: string,
        private readonly variables: Record<string, number>,
    ) {}

    parse(): number {
        const result = this.expression();
        if (this.index !== this.source.length || !Number.isFinite(result))
            throw new Error("invalid");
        return result;
    }

    private expression(): number {
        let value = this.term();
        while (this.peek() === "+" || this.peek() === "-") {
            const operator = this.source[this.index++];
            const next = this.term();
            value = operator === "+" ? value + next : value - next;
        }
        return value;
    }

    private term(): number {
        let value = this.unary();
        while (this.peek() === "*" || this.peek() === "/") {
            const operator = this.source[this.index++];
            if (operator === "*" && this.peek() === "*") {
                this.index--;
                break;
            }
            const next = this.unary();
            value = operator === "*" ? value * next : value / next;
        }
        return value;
    }

    private unary(): number {
        if (this.peek() === "+" || this.peek() === "-") {
            const sign = this.source[this.index++] === "-" ? -1 : 1;
            return sign * this.unary();
        }
        return this.power();
    }

    private power(): number {
        let value = this.atom();
        if (this.source.slice(this.index, this.index + 2) === "**") {
            this.index += 2;
            value **= this.unary();
        }
        return value;
    }

    private atom(): number {
        if (this.peek() === "(") {
            this.index++;
            const value = this.expression();
            if (this.source[this.index++] !== ")") throw new Error("invalid");
            return value;
        }
        const number = this.source.slice(this.index).match(/^\d+(?:\.\d+)?/);
        if (number) {
            this.index += number[0].length;
            return Number(number[0]);
        }
        const identifier = this.source.slice(this.index).match(/^[a-z][a-z0-9_]*/);
        if (!identifier) throw new Error("invalid");
        this.index += identifier[0].length;
        if (identifier[0] === "sqrt" && this.peek() === "(") return Math.sqrt(this.atom());
        if (identifier[0] === "pi") return Math.PI;
        if (identifier[0] === "e") return Math.E;
        return this.variables[identifier[0]] ?? 1.731;
    }

    private peek(): string {
        return this.source[this.index] ?? "";
    }
}

export function formulasAreEquivalent(submitted: string, expected: string): boolean {
    const left = normalizeFormula(submitted);
    const right = normalizeFormula(expected);
    if (left === right) return true;
    const samples = [
        { x: 0.7, y: 1.3, z: 2.1, a: 1.1, b: 2.3, c: 3.7, n: 2 },
        { x: 2.2, y: -0.4, z: 1.7, a: 3.2, b: 0.8, c: -1.1, n: 3 },
        { x: -1.3, y: 2.4, z: 0.6, a: -0.7, b: 4.1, c: 2.2, n: 4 },
    ];
    try {
        return samples.every((variables) => {
            const leftValue = new FormulaParser(left, variables).parse();
            const rightValue = new FormulaParser(right, variables).parse();
            return Math.abs(leftValue - rightValue) <= 1e-8 * Math.max(1, Math.abs(rightValue));
        });
    } catch {
        return false;
    }
}

function splitList(value: string, separator: CardAnswerConfig["listSeparator"]): string[] {
    const pattern = separator === "comma" ? /,/ : separator === "semicolon" ? /;/ : /\n/;
    return value
        .split(pattern)
        .map((item) => item.trim())
        .filter(Boolean);
}

function evaluateList(
    submitted: string,
    expected: string,
    config: CardAnswerConfig,
    ordered: boolean,
): AnswerPartResult[] {
    const actualItems = splitList(submitted, config.listSeparator);
    const expectedItems = splitList(expected, config.listSeparator);
    if (ordered) {
        return expectedItems.map((item, index) =>
            evaluateTextPart(actualItems[index] ?? "", item, [], [], config, {
                id: `item-${index + 1}`,
                label: `${index + 1}`,
                optional: false,
            }),
        );
    }
    const unused = [...actualItems];
    return expectedItems.map((item, index) => {
        let bestIndex = -1;
        let bestScore = -1;
        for (let candidate = 0; candidate < unused.length; candidate++) {
            const score = levenshteinSimilarity(
                applySynonyms(unused[candidate], config),
                applySynonyms(item, config),
            );
            if (score > bestScore) {
                bestScore = score;
                bestIndex = candidate;
            }
        }
        const submittedItem = bestIndex >= 0 ? unused.splice(bestIndex, 1)[0] : "";
        return evaluateTextPart(submittedItem, item, [], [], config, {
            id: `item-${index + 1}`,
            label: `${index + 1}`,
            optional: false,
        });
    });
}

function finish(parts: AnswerPartResult[], allowPartial: boolean): AnswerEvaluationResult {
    const required = parts.filter((part) => !part.optional);
    const relevant = required.length > 0 ? required : parts;
    const totalWeight = relevant.reduce((sum, part) => sum + part.weight, 0);
    const score =
        relevant.length === 0 || totalWeight === 0
            ? 0
            : relevant.reduce((sum, part) => sum + part.score * part.weight, 0) / totalWeight;
    const correct = relevant.length > 0 && relevant.every((part) => part.correct);
    const status: AnswerEvaluationStatus = correct
        ? "correct"
        : allowPartial && score > 0
          ? "partial"
          : "incorrect";
    return {
        status,
        score,
        parts,
        missingKeywords: [...new Set(parts.flatMap((part) => part.missingKeywords))],
        missingOptionalKeywords: [
            ...new Set(parts.flatMap((part) => part.missingOptionalKeywords)),
        ],
        expected: parts.map((part) => part.expected).filter(Boolean),
    };
}

export function evaluateAnswer(context: AnswerEvaluationContext): AnswerEvaluationResult {
    const mode = canonicalAnswerMode(context.mode);
    const config = normalizeAnswerConfig(context.config);
    if (mode === "reveal")
        return {
            status: "unanswered",
            score: 0,
            parts: [],
            missingKeywords: [],
            missingOptionalKeywords: [],
            expected: [],
        };

    const single = typeof context.values === "string" ? context.values : "";
    if (mode === "number")
        return finish([evaluateNumber(single, context.expected, config)], config.allowPartial);
    if (mode === "formula") {
        const accepted = cleanList([context.expected, ...config.acceptedAnswers]);
        const correct = accepted.some((candidate) => formulasAreEquivalent(single, candidate));
        return finish(
            [
                {
                    id: "answer",
                    label: "Answer",
                    submitted: single,
                    expected: accepted[0] ?? "",
                    score: correct ? 1 : 0,
                    correct,
                    optional: false,
                    weight: 1,
                    missingKeywords: [],
                    missingOptionalKeywords: [],
                    diff: createAnswerDiff(
                        normalizeFormula(single),
                        normalizeFormula(accepted[0] ?? ""),
                    ),
                },
            ],
            config.allowPartial,
        );
    }
    if (mode === "ordered-list" || mode === "unordered-list") {
        return finish(
            evaluateList(single, context.expected, config, mode === "ordered-list"),
            config.allowPartial,
        );
    }
    if (mode === "multiple-choice") {
        const selected = new Set(Array.isArray(context.values) ? context.values : [single]);
        const correctIds = new Set(
            config.choices.filter((choice) => choice.correct).map((choice) => choice.id),
        );
        const correct =
            selected.size === correctIds.size && [...selected].every((id) => correctIds.has(id));
        const hits = [...selected].filter((id) => correctIds.has(id)).length;
        const misses = [...selected].filter((id) => !correctIds.has(id)).length;
        const score = Math.max(0, hits / Math.max(1, correctIds.size + misses));
        return finish(
            [
                {
                    id: "choice",
                    label: "Choice",
                    submitted: config.choices
                        .filter((choice) => selected.has(choice.id))
                        .map((choice) => choice.label)
                        .join(", "),
                    expected: config.choices
                        .filter((choice) => choice.correct)
                        .map((choice) => choice.label)
                        .join(", "),
                    score: correct ? 1 : score,
                    correct,
                    optional: false,
                    weight: 1,
                    missingKeywords: [],
                    missingOptionalKeywords: [],
                    diff: [],
                },
            ],
            config.allowPartial,
        );
    }
    if (mode === "multiple-text" || mode === "image-labels") {
        const values =
            typeof context.values === "object" && !Array.isArray(context.values)
                ? context.values
                : {};
        const definitions =
            config.parts.length > 0
                ? config.parts
                : mode === "image-labels"
                  ? [
                        {
                            id: "label",
                            label: "Label",
                            answerFieldId: null,
                            acceptedAnswers: context.expected ? [context.expected] : [],
                            requiredKeywords: [],
                            optional: false,
                            weight: 1,
                        },
                    ]
                  : [];
        const parts = definitions.map((part) => {
            const expected =
                (part.answerFieldId ? context.fieldValues?.[part.answerFieldId] : undefined) ??
                part.acceptedAnswers[0] ??
                "";
            return evaluateTextPart(
                values[part.id] ?? "",
                expected,
                part.acceptedAnswers.slice(expected ? 0 : 1),
                part.requiredKeywords,
                config,
                part,
            );
        });
        return finish(parts, config.allowPartial);
    }
    return finish(
        [
            evaluateTextPart(
                single,
                context.expected,
                config.acceptedAnswers,
                config.requiredKeywords,
                config,
                { id: "answer", label: "Answer", optional: false },
            ),
        ],
        config.allowPartial,
    );
}
