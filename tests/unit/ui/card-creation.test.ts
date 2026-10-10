/* eslint-disable @typescript-eslint/unbound-method */
import { Editor } from "obsidian";

import { DEFAULT_SETTINGS, SRSettings } from "src/data/settings";
import { createCardInEditor } from "src/ui/card-creation";

function editor(selection: string, value = "#flashcards\n"): Editor {
    return {
        getSelection: jest.fn(() => selection),
        getValue: jest.fn(() => value),
        replaceSelection: jest.fn(),
        replaceRange: jest.fn(),
        getCursor: jest.fn(() => ({ line: 1, ch: 30 })),
        setSelection: jest.fn(),
    } as unknown as Editor;
}

function settings(overrides: Partial<SRSettings> = {}): SRSettings {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("card creation in the Obsidian editor", () => {
    it("creates basic and two-way cards with configured separators", () => {
        const basic = editor("Question");
        const reversed = editor("Question");

        expect(createCardInEditor(basic, settings(), "basic", "Note")).toBe(true);
        expect(basic.replaceSelection).toHaveBeenCalledWith("Question::Answer");

        expect(createCardInEditor(reversed, settings(), "reversed", "Note")).toBe(true);
        expect(reversed.replaceSelection).toHaveBeenCalledWith("Question:::Answer");
    });

    it("creates clozes using the enabled Obsidian markup", () => {
        const highlight = editor("hidden fact");
        const curly = editor("hidden fact");

        createCardInEditor(highlight, settings(), "cloze", "Note");
        expect(highlight.replaceSelection).toHaveBeenCalledWith("==hidden fact==");

        createCardInEditor(
            curly,
            settings({
                convertHighlightsToClozes: false,
                convertCurlyBracketsToClozes: true,
            }),
            "cloze",
            "Note",
        );
        expect(curly.replaceSelection).toHaveBeenCalledWith("{{hidden fact}}");
    });

    it("adds the configured deck tag when the note is not yet a deck", () => {
        const untagged = editor("Question", "Plain note");

        createCardInEditor(
            untagged,
            settings({ flashcardTags: ["#flashcards/law"] }),
            "basic",
            "Note",
        );

        expect(untagged.replaceRange).toHaveBeenCalledWith("#flashcards/law\n\n", {
            line: 0,
            ch: 0,
        });
    });

    it("does not create an empty cloze", () => {
        const empty = editor("");

        expect(createCardInEditor(empty, settings(), "cloze", "Note")).toBe(false);
        expect(empty.replaceSelection).not.toHaveBeenCalled();
    });
});
