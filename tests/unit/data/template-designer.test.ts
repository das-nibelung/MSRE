import { NoteFieldDefinition } from "src/data/collection/collection-types";
import {
    compileTemplateBlocks,
    conditionForField,
    createTemplateVisualBlock,
    inferTemplateBlocks,
    TEMPLATE_LIBRARY,
    validateTemplateDesign,
} from "src/data/collection/template-designer";

const fields: NoteFieldDefinition[] = [
    {
        id: "front",
        name: "Front",
        ordinal: 0,
        kind: "rich-text",
        required: true,
    },
    {
        id: "back",
        name: "Back",
        ordinal: 1,
        kind: "rich-text",
        required: true,
    },
];

describe("template designer", () => {
    it("compiles ordered visual blocks and their display conditions", () => {
        const title = createTemplateVisualBlock("one", "text");
        title.text = "Remember";
        const answer = createTemplateVisualBlock("two", "field", "back");
        answer.condition = { operator: "not-empty", fieldId: "back", value: "" };
        const hint = createTemplateVisualBlock("three", "hint", "front");
        hint.label = "Show clue";

        expect(compileTemplateBlocks([title, answer, hint], fields)).toBe(
            "Remember\n\n{{#Back}}{{Back}}{{/Back}}\n\n{{hint:Front:Show%20clue}}",
        );
    });

    it("compiles every visual block family and comparison rule", () => {
        const image = createTemplateVisualBlock("image", "image", "front");
        image.condition = { operator: "empty", fieldId: "back", value: "" };
        const audio = createTemplateVisualBlock("audio", "audio", "back");
        audio.condition = { operator: "equals", fieldId: "front", value: "A value" };
        const speech = createTemplateVisualBlock("tts", "tts", "front");
        speech.condition = { operator: "not-equals", fieldId: "back", value: "skip" };
        const input = createTemplateVisualBlock("input", "answer-input", "back");
        const divider = createTemplateVisualBlock("divider", "divider");
        const missing = createTemplateVisualBlock("missing", "field", null);
        const legacyId = createTemplateVisualBlock("legacy", "field", "legacy-field-id");

        const compiled = compileTemplateBlocks(
            [image, audio, speech, input, divider, missing, legacyId],
            fields,
        );
        expect(compiled).toContain("{{^Back}}{{image:Front}}{{/Back}}");
        expect(compiled).toContain("{{#equals:Front:A%20value}}{{audio:Back}}");
        expect(compiled).toContain("{{#not-equals:Back:skip}}{{tts:Front}}");
        expect(compiled).toContain("<!-- sr-answer-input: Back -->");
        expect(compiled).toContain('class="sr-template-divider"');
        expect(compiled).toContain("{{legacy-field-id}}");
        expect(compiled).not.toContain("missing");
    });

    it("imports simple field and divider templates into visual blocks", () => {
        let id = 0;
        const blocks = inferTemplateBlocks("{{Front}}<hr>{{Back}}", fields, () => `b-${++id}`);

        expect(blocks.map((block) => block.kind)).toEqual(["field", "divider", "field"]);
        expect(blocks.map((block) => block.fieldId)).toEqual(["front", null, "back"]);
    });

    it("imports conditions, media, hints, TTS, answer input, and FrontSide", () => {
        let id = 0;
        const blocks = inferTemplateBlocks(
            "{{FrontSide}}{{#Back}}{{image:Front}}{{audio:Back}}{{tts:Front}}{{hint:Back:Show%20it}}{{/Back}}{{^Front}}Empty{{/Front}}{{#equals:Front:Yes}}{{Back}}{{/equals:Front:Yes}}<!-- sr-answer-input: Back -->{{unknown}}",
            fields,
            () => `complex-${++id}`,
        );

        expect(blocks.map((block) => block.kind)).toEqual([
            "text",
            "image",
            "audio",
            "tts",
            "hint",
            "text",
            "field",
            "answer-input",
            "text",
        ]);
        expect(blocks.find((block) => block.kind === "hint")?.label).toBe("Show it");
        expect(blocks.find((block) => block.kind === "image")?.condition.operator).toBe(
            "not-empty",
        );
        expect(blocks.find((block) => block.text === "Empty")?.condition.operator).toBe("empty");
        expect(blocks.find((block) => block.kind === "field")?.condition).toEqual({
            operator: "equals",
            fieldId: "front",
            value: "Yes",
        });
    });

    it("creates a fallback text block for an empty format", () => {
        const blocks = inferTemplateBlocks("", fields, () => "empty");
        expect(blocks).toHaveLength(1);
        expect(blocks[0].kind).toBe("text");
    });

    it("validates fields, balanced conditions, typed answers, and CSS", () => {
        const issues = validateTemplateDesign(
            {
                questionFormat: "{{Missing}} {{image:Unknown}} {{#Front}}open",
                answerFormat: "{{Back}}",
                browserFormat: "{{Front}}",
                answerMode: "type",
                answerFieldId: null,
                css: ".card { color: red;",
            },
            fields,
        );

        expect(issues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "unknown-field", field: "Missing" }),
                expect.objectContaining({ code: "unknown-field", field: "Unknown" }),
                expect.objectContaining({ code: "unbalanced-condition" }),
                expect.objectContaining({ code: "missing-answer-field" }),
                expect.objectContaining({ code: "invalid-css" }),
            ]),
        );

        const comparisonIssues = validateTemplateDesign(
            {
                questionFormat:
                    "{{#equals:Missing:yes}}Value{{/equals:Missing:no}}{{#Unknown}}x{{/Back}}",
                answerFormat: "{{Back}}",
                browserFormat: "",
                answerMode: "reveal",
                answerFieldId: null,
                css: "}broken{",
            },
            fields,
        );
        expect(comparisonIssues).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ code: "unknown-field", field: "Missing" }),
                expect.objectContaining({ code: "unknown-field", field: "Unknown" }),
                expect.objectContaining({ code: "unbalanced-condition" }),
                expect.objectContaining({ code: "invalid-css" }),
            ]),
        );
    });

    it("ships subject-specific starter note types", () => {
        expect(TEMPLATE_LIBRARY.map((blueprint) => blueprint.id)).toEqual([
            "medicine",
            "law",
            "mathematics",
            "language",
        ]);
        expect(TEMPLATE_LIBRARY.every((blueprint) => blueprint.templates.length > 0)).toBe(true);
        expect(conditionForField("front")).toEqual({
            operator: "not-empty",
            fieldId: "front",
            value: "",
        });
        expect(conditionForField(null)).toEqual({
            operator: "always",
            fieldId: null,
            value: "",
        });
    });
});
