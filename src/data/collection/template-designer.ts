import {
    CardAnswerMode,
    CardTemplateGenerator,
    FieldKind,
    NoteFieldDefinition,
    TemplateBlockCondition,
    TemplateBlockKind,
    TemplateConditionOperator,
    TemplateVisualBlock,
} from "src/data/collection/collection-types";

export type TemplateSurfaceName = "question" | "answer" | "browser";

export interface TemplateValidationIssue {
    code:
        | "empty-format"
        | "unknown-field"
        | "unbalanced-condition"
        | "invalid-css"
        | "missing-answer-field";
    surface?: TemplateSurfaceName;
    field?: string;
}

export interface TemplateLibraryBlueprint {
    id: "medicine" | "law" | "mathematics" | "language";
    name: string;
    description: string;
    fields: Array<{ name: string; kind?: FieldKind; required?: boolean }>;
    templates: Array<{
        name: string;
        question: string;
        answer: string;
        browser?: string;
        generator?: CardTemplateGenerator;
        answerMode?: CardAnswerMode;
        answerField?: string;
        sourceField?: string;
        conditionField?: string;
    }>;
    css: string;
}

const alwaysCondition = (): TemplateBlockCondition => ({
    operator: "always",
    fieldId: null,
    value: "",
});

export function createTemplateVisualBlock(
    id: string,
    kind: TemplateBlockKind,
    fieldId: string | null = null,
): TemplateVisualBlock {
    return {
        id,
        kind,
        fieldId,
        text: kind === "text" ? "Text" : "",
        label: kind === "hint" ? "Hint" : "",
        condition: alwaysCondition(),
    };
}

function fieldToken(fieldId: string | null, fields: NoteFieldDefinition[]): string {
    if (!fieldId) return "";
    const field = fields.find((candidate) => candidate.id === fieldId);
    return field ? field.name : fieldId;
}

function wrapCondition(
    content: string,
    condition: TemplateBlockCondition,
    fields: NoteFieldDefinition[],
): string {
    if (condition.operator === "always" || !condition.fieldId) return content;
    const token = fieldToken(condition.fieldId, fields);
    if (!token) return content;
    if (condition.operator === "not-empty") return `{{#${token}}}${content}{{/${token}}}`;
    if (condition.operator === "empty") return `{{^${token}}}${content}{{/${token}}}`;
    const encoded = encodeURIComponent(condition.value);
    const expression = `${condition.operator}:${token}:${encoded}`;
    return `{{#${expression}}}${content}{{/${expression}}}`;
}

export function compileTemplateBlocks(
    blocks: TemplateVisualBlock[],
    fields: NoteFieldDefinition[],
): string {
    return blocks
        .map((block) => {
            const token = fieldToken(block.fieldId, fields);
            let content = "";
            if (block.kind === "field") content = token ? `{{${token}}}` : "";
            else if (block.kind === "text") content = block.text;
            else if (block.kind === "divider") content = '<hr class="sr-template-divider">';
            else if (block.kind === "image") content = token ? `{{image:${token}}}` : "";
            else if (block.kind === "audio") content = token ? `{{audio:${token}}}` : "";
            else if (block.kind === "tts") content = token ? `{{tts:${token}}}` : "";
            else if (block.kind === "hint") {
                content = token
                    ? `{{hint:${token}:${encodeURIComponent(block.label || "Hint")}}}`
                    : "";
            } else if (block.kind === "answer-input") {
                content = token ? `<!-- sr-answer-input: ${encodeURIComponent(token)} -->` : "";
            }
            return wrapCondition(content, block.condition, fields);
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

/** Best-effort import keeps advanced templates editable without destroying their source. */
export function inferTemplateBlocks(
    format: string,
    fields: NoteFieldDefinition[],
    idFactory: () => string,
): TemplateVisualBlock[] {
    const blocks: TemplateVisualBlock[] = [];
    const conditions: TemplateBlockCondition[] = [];
    const fieldByToken = (token: string) =>
        fields.find((candidate) => candidate.id === token || candidate.name === token);
    const addBlock = (kind: TemplateBlockKind, fieldId: string | null = null) => {
        const block = createTemplateVisualBlock(idFactory(), kind, fieldId);
        block.condition = {
            ...(conditions.length > 0 ? conditions[conditions.length - 1] : alwaysCondition()),
        };
        blocks.push(block);
        return block;
    };
    const addText = (value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        addBlock("text").text = trimmed;
    };
    const pattern = /<hr(?:\s[^>]*)?>|<!--\s*sr-answer-input:\s*([^]*?)-->|{{[^}]+}}/gi;
    let cursor = 0;
    for (const match of format.matchAll(pattern)) {
        const index = match.index ?? 0;
        addText(format.slice(cursor, index));
        cursor = index + match[0].length;
        const token = match[0].trim();
        if (/^<hr/i.test(token)) {
            addBlock("divider");
            continue;
        }
        if (/^<!--/i.test(token)) {
            const field = fieldByToken(decodeURIComponent(match[1]?.trim() ?? ""));
            addBlock("answer-input", field?.id ?? null);
            continue;
        }
        const inner = token.slice(2, -2).trim();
        if (inner.startsWith("/")) {
            conditions.pop();
            continue;
        }
        if (inner.startsWith("#") || inner.startsWith("^")) {
            const inverse = inner[0] === "^";
            const expression = inner.slice(1);
            const comparison = expression.match(/^(equals|not-equals):([^:]+):(.*)$/);
            if (comparison) {
                const field = fieldByToken(comparison[2]);
                conditions.push({
                    operator: comparison[1] as "equals" | "not-equals",
                    fieldId: field?.id ?? null,
                    value: decodeURIComponent(comparison[3]),
                });
            } else {
                const field = fieldByToken(expression);
                conditions.push({
                    operator: inverse ? "empty" : "not-empty",
                    fieldId: field?.id ?? null,
                    value: "",
                });
            }
            continue;
        }
        if (inner === "FrontSide") {
            addText(token);
            continue;
        }
        const filtered = inner.match(/^(image|audio|tts|hint):([^:]+)(?::(.*))?$/i);
        if (filtered) {
            const kind = filtered[1].toLocaleLowerCase() as "image" | "audio" | "tts" | "hint";
            const field = fieldByToken(filtered[2]);
            const block = addBlock(kind, field?.id ?? null);
            if (kind === "hint" && filtered[3]) block.label = decodeURIComponent(filtered[3]);
            continue;
        }
        const field = fieldByToken(inner);
        if (field) addBlock("field", field.id);
        else addText(token);
    }
    addText(format.slice(cursor));
    return blocks.length > 0 ? blocks : [createTemplateVisualBlock(idFactory(), "text")];
}

const tokenPattern = /{{(?:[#/^])?([^}:]+)(?::[^}]*)?}}/g;

function validateFormat(
    format: string,
    surface: TemplateSurfaceName,
    fields: NoteFieldDefinition[],
): TemplateValidationIssue[] {
    const issues: TemplateValidationIssue[] = [];
    if (!format.trim()) issues.push({ code: "empty-format", surface });
    const known = new Set(fields.flatMap((field) => [field.id, field.name]));
    known.add("FrontSide");
    for (const match of format.matchAll(tokenPattern)) {
        const raw = match[1];
        if (
            ["cloze", "image", "audio", "tts", "hint", "type", "equals", "not-equals"].includes(raw)
        ) {
            continue;
        }
        if (!known.has(raw)) issues.push({ code: "unknown-field", surface, field: raw });
    }
    for (const match of format.matchAll(
        /{{(?:cloze|trim|lower|upper|text|image|audio|tts|hint):([^}:]+)(?::[^}]*)?}}/gi,
    )) {
        if (!known.has(match[1])) {
            issues.push({ code: "unknown-field", surface, field: match[1] });
        }
    }
    for (const match of format.matchAll(/{{#(?:equals|not-equals):([^}:]+):[^}]+}}/gi)) {
        if (!known.has(match[1])) {
            issues.push({ code: "unknown-field", surface, field: match[1] });
        }
    }
    const stack: string[] = [];
    let unbalanced = false;
    for (const match of format.matchAll(/{{([#^/])([^}]+)}}/g)) {
        if (match[1] === "/") {
            if (stack.pop() !== match[2]) unbalanced = true;
        } else {
            stack.push(match[2]);
        }
    }
    if (unbalanced || stack.length > 0) {
        issues.push({ code: "unbalanced-condition", surface });
    }
    return issues;
}

function validateCss(css: string): boolean {
    let depth = 0;
    for (const character of css) {
        if (character === "{") depth++;
        if (character === "}") depth--;
        if (depth < 0) return false;
    }
    return depth === 0;
}

export function validateTemplateDesign(
    template: {
        questionFormat: string;
        answerFormat: string;
        browserFormat?: string;
        answerMode?: CardAnswerMode;
        answerFieldId?: string | null;
        css?: string;
        questionCss?: string;
        answerCss?: string;
        browserCss?: string;
    },
    fields: NoteFieldDefinition[],
): TemplateValidationIssue[] {
    const issues = [
        ...validateFormat(template.questionFormat, "question", fields),
        ...validateFormat(template.answerFormat, "answer", fields),
    ];
    if (template.browserFormat?.trim()) {
        issues.push(...validateFormat(template.browserFormat, "browser", fields));
    }
    if (template.answerMode === "type" && !template.answerFieldId) {
        issues.push({ code: "missing-answer-field", surface: "answer" });
    }
    if (
        ![template.css, template.questionCss, template.answerCss, template.browserCss].every(
            (css) => validateCss(css ?? ""),
        )
    ) {
        issues.push({ code: "invalid-css" });
    }
    return issues;
}

export const TEMPLATE_LIBRARY: TemplateLibraryBlueprint[] = [
    {
        id: "medicine",
        name: "Medicine",
        description: "Concept, clinical clue, mechanism, and supporting material.",
        fields: [
            { name: "Term", required: true },
            { name: "Definition", required: true },
            { name: "Clinical clue" },
            { name: "Mechanism" },
            { name: "Extra" },
        ],
        templates: [
            {
                name: "Concept",
                question: "{{Term}}",
                answer: "{{FrontSide}}\n<hr>\n{{Definition}}\n\n{{#Mechanism}}**Mechanism**\n\n{{Mechanism}}{{/Mechanism}}\n\n{{#Extra}}{{Extra}}{{/Extra}}",
                browser: "{{Term}} — {{Definition}}",
            },
            {
                name: "Clinical clue",
                question: "{{Clinical clue}}",
                answer: "{{Term}}\n\n{{Definition}}",
                browser: "{{Clinical clue}} → {{Term}}",
                answerMode: "type",
                answerField: "Term",
                conditionField: "Clinical clue",
            },
        ],
        css: "line-height: 1.55;",
    },
    {
        id: "law",
        name: "Law",
        description: "Rule, conditions, consequence, exception, and source.",
        fields: [
            { name: "Rule", required: true },
            { name: "Conditions", required: true },
            { name: "Consequence", required: true },
            { name: "Exception" },
            { name: "Source" },
        ],
        templates: [
            {
                name: "Rule → consequence",
                question: "{{Rule}}\n\n{{Conditions}}",
                answer: "{{FrontSide}}\n<hr>\n{{Consequence}}\n\n{{#Exception}}> **Exception:** {{Exception}}{{/Exception}}\n\n{{#Source}}{{Source}}{{/Source}}",
                browser: "{{Rule}} — {{Consequence}}",
            },
            {
                name: "Consequence → rule",
                question: "{{Consequence}}",
                answer: "{{Rule}}\n\n{{Conditions}}",
                browser: "{{Consequence}} → {{Rule}}",
            },
        ],
        css: "line-height: 1.6;",
    },
    {
        id: "mathematics",
        name: "Mathematics",
        description: "Statement, formula, proof idea, and worked example.",
        fields: [
            { name: "Concept", required: true },
            { name: "Statement", required: true },
            { name: "Formula", kind: "formula" },
            { name: "Proof idea" },
            { name: "Example" },
        ],
        templates: [
            {
                name: "Statement",
                question: "{{Concept}}",
                answer: "{{Statement}}\n\n{{#Formula}}{{Formula}}{{/Formula}}\n\n{{#Proof idea}}**Proof idea**\n\n{{Proof idea}}{{/Proof idea}}",
                browser: "{{Concept}} — {{Statement}}",
            },
            {
                name: "Formula",
                question: "Formula for **{{Concept}}**",
                answer: "{{Formula}}\n\n{{#Example}}{{Example}}{{/Example}}",
                browser: "{{Concept}} — {{Formula}}",
                conditionField: "Formula",
            },
        ],
        css: "text-align: center; line-height: 1.65;",
    },
    {
        id: "language",
        name: "Language",
        description: "Two-way vocabulary with example, hint, and optional audio.",
        fields: [
            { name: "Expression", required: true },
            { name: "Translation", required: true },
            { name: "Example" },
            { name: "Hint" },
            { name: "Audio", kind: "media" },
        ],
        templates: [
            {
                name: "Recognition",
                question: "{{Expression}}\n\n{{#Audio}}{{audio:Audio}}{{/Audio}}",
                answer: "{{FrontSide}}\n<hr>\n{{Translation}}\n\n{{#Example}}{{Example}}{{/Example}}",
                browser: "{{Expression}} → {{Translation}}",
            },
            {
                name: "Production",
                question: "{{Translation}}\n\n{{#Hint}}{{hint:Hint:Hint}}{{/Hint}}",
                answer: "{{Expression}}\n\n{{#Example}}{{Example}}{{/Example}}",
                browser: "{{Translation}} → {{Expression}}",
                answerMode: "type",
                answerField: "Expression",
            },
        ],
        css: "text-align: center; font-size: 1.08em; line-height: 1.55;",
    },
];

export function conditionForField(fieldId: string | null): {
    operator: TemplateConditionOperator;
    fieldId: string | null;
    value: string;
} {
    return fieldId
        ? { operator: "not-empty", fieldId, value: "" }
        : { operator: "always", fieldId: null, value: "" };
}
