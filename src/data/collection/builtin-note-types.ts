import { createDefaultAnswerConfig } from "src/data/collection/answer-evaluator";
import {
    CardTemplateDefinition,
    NoteFieldDefinition,
    NoteTypeDefinition,
} from "src/data/collection/collection-types";

export const BASIC_NOTE_TYPE_ID = "builtin-basic";
export const REVERSED_NOTE_TYPE_ID = "builtin-basic-and-reversed";
export const CLOZE_NOTE_TYPE_ID = "builtin-cloze";
export const IMAGE_OCCLUSION_NOTE_TYPE_ID = "builtin-image-occlusion";

export const FRONT_FIELD_ID = "front";
export const BACK_FIELD_ID = "back";
export const TEXT_FIELD_ID = "text";
export const EXTRA_FIELD_ID = "extra";
export const OCCLUSION_SOURCE_FIELD_ID = "source";
export const OCCLUSION_MASKS_FIELD_ID = "masks";
export const OCCLUSION_ASSETS_FIELD_ID = "assets";
export const OCCLUSION_MODE_FIELD_ID = "mode";
export const OCCLUSION_HEADER_FIELD_ID = "header";
export const OCCLUSION_EXTRA_FIELD_ID = "occlusion-extra";
export const OCCLUSION_COMMENTS_FIELD_ID = "comments";
export const OCCLUSION_REFERENCE_FIELD_ID = "reference";

const createdAt = 0;

function field(id: string, name: string, ordinal: number): NoteFieldDefinition {
    return { id, name, ordinal, kind: "rich-text", required: ordinal === 0 };
}

function template(
    id: string,
    name: string,
    ordinal: number,
    questionFormat: string,
    answerFormat: string,
    generator: NoteTypeDefinition["kind"] = "standard",
    answerFieldId: string | null = null,
): CardTemplateDefinition {
    return {
        id,
        version: 1,
        name,
        ordinal,
        questionFormat,
        answerFormat,
        deckOverride: null,
        enabled: true,
        generator,
        answerMode: "reveal",
        answerConfig: createDefaultAnswerConfig(),
        answerFieldId,
        sourceFieldId: null,
        condition: { operator: "always", fieldId: null, value: "" },
        css: "",
        editorMode: "visual",
        questionBlocks: [],
        answerBlocks: [],
        browserBlocks: [],
        browserFormat: questionFormat,
        questionCss: "",
        answerCss: "",
        browserCss: "",
    };
}

export function getBuiltinNoteTypes(): NoteTypeDefinition[] {
    return [
        {
            id: BASIC_NOTE_TYPE_ID,
            version: 1,
            name: "Basic",
            kind: "standard",
            fields: [field(FRONT_FIELD_ID, "Front", 0), field(BACK_FIELD_ID, "Back", 1)],
            templates: [
                template(
                    "builtin-basic-card",
                    "Card 1",
                    0,
                    "{{Front}}",
                    "{{Front}}\n<hr>\n{{Back}}",
                    "standard",
                    BACK_FIELD_ID,
                ),
            ],
            css: "",
            createdAt,
            updatedAt: createdAt,
        },
        {
            id: REVERSED_NOTE_TYPE_ID,
            version: 1,
            name: "Basic (and reversed card)",
            kind: "standard",
            fields: [field(FRONT_FIELD_ID, "Front", 0), field(BACK_FIELD_ID, "Back", 1)],
            templates: [
                template(
                    "builtin-reversed-forward",
                    "Forward",
                    0,
                    "{{Front}}",
                    "{{Front}}\n<hr>\n{{Back}}",
                    "standard",
                    BACK_FIELD_ID,
                ),
                template(
                    "builtin-reversed-backward",
                    "Reverse",
                    1,
                    "{{Back}}",
                    "{{Back}}\n<hr>\n{{Front}}",
                    "standard",
                    FRONT_FIELD_ID,
                ),
            ],
            css: "",
            createdAt,
            updatedAt: createdAt,
        },
        {
            id: CLOZE_NOTE_TYPE_ID,
            version: 1,
            name: "Cloze",
            kind: "cloze",
            fields: [field(TEXT_FIELD_ID, "Text", 0), field(EXTRA_FIELD_ID, "Extra", 1)],
            templates: [
                template(
                    "builtin-cloze-card",
                    "Cloze",
                    0,
                    "{{cloze:Text}}",
                    "{{cloze:Text}}\n<hr>\n{{Extra}}",
                    "cloze",
                    TEXT_FIELD_ID,
                ),
            ],
            css: "",
            createdAt,
            updatedAt: createdAt,
        },
        {
            id: IMAGE_OCCLUSION_NOTE_TYPE_ID,
            version: 2,
            name: "Image Occlusion",
            kind: "image-occlusion",
            fields: [
                { ...field(OCCLUSION_SOURCE_FIELD_ID, "Source", 0), kind: "media" },
                field(OCCLUSION_MASKS_FIELD_ID, "Masks", 1),
                field(OCCLUSION_ASSETS_FIELD_ID, "Assets", 2),
                field(OCCLUSION_MODE_FIELD_ID, "Mode", 3),
                field(OCCLUSION_HEADER_FIELD_ID, "Header", 4),
                field(OCCLUSION_EXTRA_FIELD_ID, "Extra", 5),
                field(OCCLUSION_COMMENTS_FIELD_ID, "Comments", 6),
                field(OCCLUSION_REFERENCE_FIELD_ID, "Reference", 7),
            ],
            templates: [
                {
                    ...template(
                        "builtin-image-occlusion-card",
                        "Occlusion",
                        0,
                        "{{Source}}",
                        "{{Source}}",
                        "image-occlusion",
                    ),
                    answerMode: "image-labels",
                },
            ],
            css: "",
            createdAt,
            updatedAt: createdAt,
        },
    ];
}

export function noteTypeIdForNativeType(type: "basic" | "reversed" | "cloze"): string {
    if (type === "reversed") return REVERSED_NOTE_TYPE_ID;
    if (type === "cloze") return CLOZE_NOTE_TYPE_ID;
    return BASIC_NOTE_TYPE_ID;
}
