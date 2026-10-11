export type CardQualitySeverity = "error" | "warning" | "suggestion";

export type CardQualityIssueCode =
    | "empty-question"
    | "empty-answer"
    | "empty-required-field"
    | "missing-media"
    | "cloze-answer-not-found"
    | "cloze-answer-repeated"
    | "cloze-pattern-required"
    | "cloze-empty-deletion"
    | "question-too-long"
    | "answer-too-long"
    | "multiple-prompts"
    | "too-many-answer-items"
    | "answer-in-question"
    | "dense-sentence"
    | "possible-duplicate";

export interface CardQualityField {
    name: string;
    value: string;
    required?: boolean;
    hasMedia?: boolean;
}

export interface CardQualityInput {
    kind: "basic" | "cloze-selection" | "cloze-markup" | "custom";
    question: string;
    answer: string;
    questionHasMedia?: boolean;
    answerHasMedia?: boolean;
    requireAnswer?: boolean;
    fields?: CardQualityField[];
    duplicateCount?: number;
    mediaReferences?: string[];
    mediaExists?: (path: string) => boolean;
}

export interface CardQualityIssue {
    code: CardQualityIssueCode;
    severity: CardQualitySeverity;
    field: string;
    detail?: string;
    value?: number;
}

export interface CardQualityReport {
    score: number;
    status: "strong" | "fair" | "weak";
    issues: CardQualityIssue[];
    blocking: boolean;
}

const IMAGE_OR_MEDIA_WIKI_LINK = /!\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const MARKDOWN_MEDIA_LINK = /!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)/g;
const CLOZE = /\{\{c(\d+)::([^{}]*?)(?:::[^{}]*?)?\}\}/gi;

function plainText(value: string): string {
    return value
        .replace(CLOZE, "$2")
        .replace(/!\[\[[^\]]+\]\]/g, " ")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/[`*_>#~|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function words(value: string): string[] {
    return plainText(value).match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [];
}

function normalized(value: string): string {
    return plainText(value)
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

function localMediaReferences(value: string): string[] {
    const references: string[] = [];
    for (const match of value.matchAll(IMAGE_OR_MEDIA_WIKI_LINK)) {
        if (match[1]?.trim()) references.push(match[1].trim());
    }
    for (const match of value.matchAll(MARKDOWN_MEDIA_LINK)) {
        const path = (match[1] ?? match[2] ?? "").trim();
        if (path && !/^(?:https?:|data:|blob:)/i.test(path)) references.push(path);
    }
    return [...new Set(references)];
}

function listItemCount(value: string): number {
    return value.split(/\r?\n/).filter((line) => /^\s*(?:[-*+] |\d+[.)] )/.test(line)).length;
}

function longestSentenceWordCount(value: string): number {
    return Math.max(
        0,
        ...plainText(value)
            .split(/[.!?…。！？]+/)
            .map((sentence) => words(sentence).length),
    );
}

export function analyzeCardQuality(input: CardQualityInput): CardQualityReport {
    const issues: CardQualityIssue[] = [];
    const add = (
        code: CardQualityIssueCode,
        severity: CardQualitySeverity,
        field: CardQualityIssue["field"],
        detail?: string,
        value?: number,
    ): void => {
        if (
            !issues.some(
                (issue) => issue.code === code && issue.field === field && issue.detail === detail,
            )
        ) {
            issues.push({ code, severity, field, detail, value });
        }
    };

    const questionPresent = Boolean(input.question.trim()) || Boolean(input.questionHasMedia);
    const answerPresent = Boolean(input.answer.trim()) || Boolean(input.answerHasMedia);
    const customContentPresent = (input.fields ?? []).some(
        (field) => Boolean(field.value.trim()) || Boolean(field.hasMedia),
    );
    if (!questionPresent && (input.kind !== "custom" || !customContentPresent)) {
        add("empty-question", "error", "question");
    }
    if ((input.requireAnswer ?? input.kind !== "custom") && !answerPresent) {
        add("empty-answer", "error", "answer");
    }
    for (const field of input.fields ?? []) {
        if (field.required && !field.value.trim() && !field.hasMedia) {
            add("empty-required-field", "error", field.name, field.name);
        }
    }

    const allValues = [
        input.question,
        input.answer,
        ...(input.fields?.map((field) => field.value) ?? []),
    ];
    if (input.mediaExists) {
        for (const reference of new Set([
            ...allValues.flatMap(localMediaReferences),
            ...(input.mediaReferences ?? []),
        ])) {
            if (!input.mediaExists(reference)) {
                add("missing-media", "error", "card", reference);
            }
        }
    }

    if (input.kind === "cloze-selection" && input.question.trim() && input.answer.trim()) {
        const occurrences = input.question.split(input.answer.trim()).length - 1;
        if (occurrences === 0) add("cloze-answer-not-found", "error", "answer");
        else if (occurrences > 1) {
            add("cloze-answer-repeated", "warning", "answer", undefined, occurrences);
        }
    }
    if (input.kind === "cloze-markup") {
        const matches = [...input.question.matchAll(CLOZE)];
        if (matches.length === 0) add("cloze-pattern-required", "error", "question");
        if (matches.some((match) => !match[2]?.trim())) {
            add("cloze-empty-deletion", "error", "question");
        }
    }

    const questionWords = words(input.question).length;
    const answerWords = words(input.answer).length;
    if (questionWords > 45) {
        add("question-too-long", "warning", "question", undefined, questionWords);
    }
    if (answerWords > 140) add("answer-too-long", "warning", "answer", undefined, answerWords);

    const promptCount = (plainText(input.question).match(/[?？]/g) ?? []).length;
    if (promptCount > 1) add("multiple-prompts", "warning", "question", undefined, promptCount);
    const answerItems = listItemCount(input.answer);
    if (answerItems > 7) {
        add("too-many-answer-items", "warning", "answer", undefined, answerItems);
    }

    const normalizedQuestion = normalized(input.question);
    const normalizedAnswer = normalized(input.answer);
    if (
        input.kind !== "cloze-selection" &&
        normalizedAnswer.length >= 4 &&
        normalizedAnswer.length <= 80 &&
        normalizedQuestion.includes(normalizedAnswer)
    ) {
        add("answer-in-question", "warning", "question");
    }

    const longestSentence = Math.max(
        longestSentenceWordCount(input.question),
        longestSentenceWordCount(input.answer),
    );
    if (longestSentence > 45) {
        add("dense-sentence", "suggestion", "card", undefined, longestSentence);
    }
    if ((input.duplicateCount ?? 0) > 0) {
        add("possible-duplicate", "suggestion", "question", undefined, input.duplicateCount);
    }

    const penalty = issues.reduce((total, issue) => {
        if (issue.severity === "error") return total + 26;
        if (issue.severity === "warning") return total + 11;
        return total + 5;
    }, 0);
    const score = Math.max(0, 100 - penalty);
    const blocking = issues.some((issue) => issue.severity === "error");
    return {
        score,
        status: blocking || score < 55 ? "weak" : score < 85 ? "fair" : "strong",
        issues,
        blocking,
    };
}
