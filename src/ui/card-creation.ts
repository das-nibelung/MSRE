import { Editor, Notice } from "obsidian";

import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";

export type CardCreationMode = "basic" | "reversed" | "cloze";

function ensureFlashcardTag(editor: Editor, settings: SRSettings): void {
    const noteText = editor.getValue();
    if (settings.flashcardTags.some((tag) => noteText.includes(tag))) return;

    editor.replaceRange(`${settings.flashcardTags[0] ?? "#flashcards"}\n\n`, {
        line: 0,
        ch: 0,
    });
}

function getClozeWrapper(settings: SRSettings): [string, string] | null {
    if (settings.convertHighlightsToClozes) return ["==", "=="];
    if (settings.convertBoldTextToClozes) return ["**", "**"];
    if (settings.convertCurlyBracketsToClozes) return ["{{", "}}"];
    if (settings.clozePatterns.some((pattern) => pattern.startsWith("=="))) return ["==", "=="];
    if (settings.clozePatterns.some((pattern) => pattern.startsWith("**"))) return ["**", "**"];
    if (settings.clozePatterns.some((pattern) => pattern.startsWith("{{"))) return ["{{", "}}"];
    return null;
}

/** Inserts a valid card at the selection and leaves the editable part selected. */
export function createCardInEditor(
    editor: Editor,
    settings: SRSettings,
    mode: CardCreationMode,
    noteName: string,
): boolean {
    const selectedText = editor.getSelection().trim();
    if (mode === "cloze" && !selectedText) {
        new Notice(t("CLOZE_REQUIRES_SELECTION"));
        return false;
    }

    if (mode === "cloze") {
        const wrapper = getClozeWrapper(settings);
        if (wrapper === null) {
            new Notice(t("CLOZE_PATTERN_UNAVAILABLE"));
            return false;
        }
        ensureFlashcardTag(editor, settings);
        const [prefix, suffix] = wrapper;
        editor.replaceSelection(`${prefix}${selectedText}${suffix}`);
        new Notice(t("CARD_CREATED_IN_NOTE", { note: noteName }));
        return true;
    }

    ensureFlashcardTag(editor, settings);

    const question = selectedText || t("CARD_TEMPLATE_QUESTION");
    const answer = t("CARD_TEMPLATE_ANSWER");
    const separator =
        mode === "reversed"
            ? settings.singleLineReversedCardSeparator
            : settings.singleLineCardSeparator;
    editor.replaceSelection(`${question}${separator}${answer}`);

    const end = editor.getCursor();
    editor.setSelection({ line: end.line, ch: end.ch - answer.length }, end);
    new Notice(t("CARD_CREATED_IN_NOTE", { note: noteName }));
    return true;
}
