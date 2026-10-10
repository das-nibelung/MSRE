import { App, normalizePath, TFile } from "obsidian";

import {
    IMAGE_OCCLUSION_NOTE_TYPE_ID,
    OCCLUSION_ASSETS_FIELD_ID,
    OCCLUSION_MASKS_FIELD_ID,
    OCCLUSION_MODE_FIELD_ID,
    OCCLUSION_SOURCE_FIELD_ID,
} from "src/data/collection/builtin-note-types";
import { CollectionNote, NoteTypeDefinition } from "src/data/collection/collection-types";
import { Card } from "src/data/data-structures/card/card";
import { CardType } from "src/data/data-structures/card/questions/question";
import { CardFrontBackUtil } from "src/data/data-structures/card/questions/question-type";
import { Deck } from "src/data/data-structures/deck/deck";
import { KnowledgeArea } from "src/data/plugin-data";
import { SRSettings } from "src/data/settings";
import SRPlugin from "src/main";
import { escapeHtml } from "src/utils/escape-html";

export type NativeCardType = "basic" | "reversed" | "cloze";

export interface NativeCardDraft {
    deckPath: string;
    type: NativeCardType;
    front: string;
    back: string;
    answerMode?: "reveal" | "type";
    tags?: string[];
}

export interface NativeCardSource {
    sourcePath: string;
    questionId?: string | null;
}

export interface StructuredNoteDraft {
    deckPath: string;
    noteTypeId: string;
    fields: Record<string, string>;
    tags?: string[];
}

export interface ImageOcclusionAssetDraft {
    maskId: string;
    questionPath: string;
    answerPath: string;
    label: string;
}

export interface ImageOcclusionNoteDraft {
    deckPath: string;
    sourcePath: string;
    masksJson: string;
    mode: "hide-one" | "hide-all";
    assets: ImageOcclusionAssetDraft[];
    tags?: string[];
}

export function serializeImageOcclusionBody(
    assets: ImageOcclusionAssetDraft[],
    baseQuestionId: string,
    separator: string,
): { body: string; legacyQuestionIds: Record<number, string> } {
    const legacyQuestionIds: Record<number, string> = {};
    const cards = assets.map((asset, index) => {
        const questionId = `${baseQuestionId}-${index + 1}`;
        legacyQuestionIds[index] = questionId;
        const label = asset.label.trim();
        const marker = label ? `\n<!-- sr-typed-answer: ${encodeURIComponent(label)} -->` : "";
        const answer = [`![[${asset.answerPath}]]`, label].filter(Boolean).join("\n\n");
        return `![[${asset.questionPath}]]\n${separator}\n${answer}${marker} ${questionId}`;
    });
    return { body: cards.join("\n\n"), legacyQuestionIds };
}

const FALLBACK_ROOT_TAG = "#flashcards";

export function normalizeManagedDeckPath(value: string): string {
    return value
        .split("/")
        .map((segment) =>
            segment
                .trim()
                .replace(/\s+/g, "-")
                .replace(/[#|^\\:]/g, "")
                .replaceAll("[", "")
                .replaceAll("]", "")
                .replace(/-{2,}/g, "-")
                .replace(/^-|-$/g, ""),
        )
        .filter(Boolean)
        .join("/");
}

function getClozeWrapper(settings: SRSettings): [string, string] | null {
    if (settings.clozePatterns.some((pattern) => pattern.startsWith("=="))) return ["==", "=="];
    if (settings.clozePatterns.some((pattern) => pattern.startsWith("**"))) return ["**", "**"];
    if (settings.clozePatterns.some((pattern) => pattern.startsWith("{{"))) return ["{{", "}}"];
    return null;
}

export function renderNoteTypeTemplate(
    template: string,
    noteType: NoteTypeDefinition,
    fields: Record<string, string>,
    frontSide = "",
): string {
    let result = template;
    for (const field of noteType.fields) {
        const value = fields[field.id] ?? "";
        for (const token of [field.name, field.id]) {
            const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            for (const operator of ["equals", "not-equals"] as const) {
                const conditionPattern = new RegExp(
                    `{{#${operator}:${escaped}:([^}]+)}}([\\s\\S]*?){{\\/${operator}:${escaped}:\\1}}`,
                    "g",
                );
                result = result.replace(
                    conditionPattern,
                    (_match: string, expected: string, content: string) => {
                        const equal = value.trim() === decodeURIComponent(expected).trim();
                        return operator === "equals"
                            ? equal
                                ? content
                                : ""
                            : equal
                              ? ""
                              : content;
                    },
                );
            }
            result = result.replace(
                new RegExp(`{{#${escaped}}}([\\s\\S]*?){{\\/${escaped}}}`, "g"),
                value.trim() ? "$1" : "",
            );
            result = result.replace(
                new RegExp(`{{\\^${escaped}}}([\\s\\S]*?){{\\/${escaped}}}`, "g"),
                value.trim() ? "" : "$1",
            );
            result = result.replace(
                new RegExp(
                    `{{(cloze|trim|lower|upper|text|image|audio|tts|hint):${escaped}(?::([^}]*))?}}`,
                    "gi",
                ),
                (_match, rawFilter: string, rawArgument: string | undefined) => {
                    const filter = rawFilter.toLocaleLowerCase();
                    if (filter === "trim" || filter === "cloze") return value.trim();
                    if (filter === "lower") return value.toLocaleLowerCase();
                    if (filter === "upper") return value.toLocaleUpperCase();
                    if (filter === "text") {
                        return value
                            .replace(/<[^>]+>/g, " ")
                            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
                            .replace(/[*_~`>#-]/g, " ")
                            .replace(/\s+/g, " ")
                            .trim();
                    }
                    if (filter === "image" || filter === "audio") {
                        const trimmed = value.trim();
                        if (!trimmed || /!?\[\[|!?\[[^\]]*\]\(/.test(trimmed)) return trimmed;
                        return `![[${trimmed}]]`;
                    }
                    if (filter === "tts") {
                        return value.trim()
                            ? `<button type="button" class="sr-template-tts" data-sr-tts="${encodeURIComponent(value.trim())}" aria-label="Read aloud">🔊</button>`
                            : "";
                    }
                    const label = rawArgument
                        ? escapeHtml(decodeURIComponent(rawArgument))
                        : "Hint";
                    return value.trim()
                        ? `<details class="sr-template-hint"><summary>${label}</summary>${value}</details>`
                        : "";
                },
            );
        }
        result = result.split(`{{${field.name}}}`).join(value);
        result = result.split(`{{${field.id}}}`).join(value);
    }
    result = result.split("{{FrontSide}}").join(frontSide);
    return result.trim();
}

export function convertAnkiClozesToLegacy(text: string): string {
    return text.replace(/{{c\d+::(.*?)(?:::(.*?))?}}/gi, "==$1==");
}

export function serializeStructuredNoteBody(
    noteType: NoteTypeDefinition,
    fields: Record<string, string>,
    settings: SRSettings,
    baseQuestionId: string,
): {
    body: string;
    legacyQuestionIds: Record<number, string>;
    legacyStableIds: Record<number, string>;
} {
    const legacyQuestionIds: Record<number, string> = {};
    const legacyStableIds: Record<number, string> = {};
    let generatedOrdinal = 0;
    const cards: string[] = [];
    const matchesCondition = (template: NoteTypeDefinition["templates"][number]): boolean => {
        const condition = template.condition;
        if (!condition || condition.operator === "always") return true;
        const value = condition.fieldId ? (fields[condition.fieldId] ?? "").trim() : "";
        const expected = condition.value.trim();
        if (condition.operator === "not-empty") return Boolean(value);
        if (condition.operator === "empty") return !value;
        if (condition.operator === "equals") return value === expected;
        return value !== expected;
    };
    const typedMarker = (
        template: NoteTypeDefinition["templates"][number],
        renderedAnswer: string,
    ): string => {
        if ((template.answerMode ?? "reveal") !== "type") return "";
        const expected = template.answerFieldId
            ? (fields[template.answerFieldId] ?? renderedAnswer)
            : renderedAnswer
                  .replace(/<[^>]+>/g, " ")
                  .replace(/\s+/g, " ")
                  .trim();
        return `\n<!-- sr-answer-mode: type -->\n<!-- sr-typed-answer: ${encodeURIComponent(expected)} -->`;
    };
    for (const template of noteType.templates
        .filter((template) => template.enabled)
        .sort((left, right) => left.ordinal - right.ordinal)) {
        if (!matchesCondition(template)) continue;
        const generator = template.generator ?? noteType.kind;
        const questionId = `${baseQuestionId}-${template.ordinal + 1}`;
        if (generator === "cloze") {
            const clozeText = template.sourceFieldId
                ? fields[template.sourceFieldId]
                : Object.values(fields).find((value) => /{{c\d+::/i.test(value));
            if (!clozeText || !/{{c\d+::/i.test(clozeText)) continue;
            const clozeNumbers = [...clozeText.matchAll(/{{c(\d+)::/gi)]
                .map((match) => Number(match[1]))
                .filter((value, index, all) => value > 0 && all.indexOf(value) === index)
                .sort((left, right) => left - right);
            const sourceField = template.sourceFieldId
                ? noteType.fields.find((field) => field.id === template.sourceFieldId)
                : noteType.fields.find((field) => fields[field.id] === clozeText);
            let supplementalFormat = template.answerFormat
                .replace(/{{cloze:[^}]+}}/gi, "")
                .replaceAll("{{FrontSide}}", "");
            if (sourceField) {
                supplementalFormat = supplementalFormat
                    .split(`{{${sourceField.id}}}`)
                    .join("")
                    .split(`{{${sourceField.name}}}`)
                    .join("");
            }
            const supplemental = renderNoteTypeTemplate(
                supplementalFormat.replace(/<hr\s*\/?\s*>/gi, ""),
                noteType,
                fields,
            );
            const renderedAnswer = renderNoteTypeTemplate(template.answerFormat, noteType, fields);
            cards.push(
                `${convertAnkiClozesToLegacy(clozeText)}${supplemental ? `<br>${supplemental}` : ""}${typedMarker(template, renderedAnswer)} ${questionId}`,
            );
            clozeNumbers.forEach((_number, cardIndex) => {
                legacyQuestionIds[generatedOrdinal] = questionId;
                legacyStableIds[generatedOrdinal] = `${questionId}:${cardIndex}`;
                generatedOrdinal++;
            });
            continue;
        }
        if (generator === "image-occlusion") {
            try {
                const assets = JSON.parse(
                    fields[OCCLUSION_ASSETS_FIELD_ID] ?? "[]",
                ) as ImageOcclusionAssetDraft[];
                for (const asset of assets) {
                    const assetQuestionId = `${questionId}-${generatedOrdinal + 1}`;
                    const answer = [`![[${asset.answerPath}]]`, asset.label.trim()]
                        .filter(Boolean)
                        .join("\n\n");
                    const marker = asset.label.trim() ? typedMarker(template, asset.label) : "";
                    cards.push(
                        `![[${asset.questionPath}]]\n${settings.multilineCardSeparator}\n${answer}${marker} ${assetQuestionId}`,
                    );
                    legacyQuestionIds[generatedOrdinal] = assetQuestionId;
                    legacyStableIds[generatedOrdinal] = `${assetQuestionId}:0`;
                    generatedOrdinal++;
                }
            } catch {
                // Invalid assets are omitted and surfaced by collection diagnostics.
            }
            continue;
        }
        {
            const question = renderNoteTypeTemplate(template.questionFormat, noteType, fields);
            const answer = renderNoteTypeTemplate(
                template.answerFormat,
                noteType,
                fields,
                question,
            );
            if (!question || !answer) continue;
            legacyQuestionIds[generatedOrdinal] = questionId;
            legacyStableIds[generatedOrdinal] = `${questionId}:0`;
            cards.push(
                `${question}\n${settings.multilineCardSeparator}\n${answer}${typedMarker(template, answer)} ${questionId}`,
            );
            generatedOrdinal++;
        }
    }
    if (cards.length === 0) throw new Error("empty-generated-card");
    return { body: cards.join("\n\n"), legacyQuestionIds, legacyStableIds };
}

export function serializeNativeCard(
    draft: NativeCardDraft,
    settings: SRSettings,
    stableQuestionId?: string,
): string {
    const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
    const deckPath = normalizeManagedDeckPath(draft.deckPath);
    const tag = deckPath ? `${rootTag}/${deckPath}` : rootTag;
    const blockId = stableQuestionId
        ? ` ${stableQuestionId.startsWith("^") ? stableQuestionId : `^${stableQuestionId}`}`
        : "";
    return `${tag}\n\n${serializeNativeQuestion(draft, settings)}${blockId}\n`;
}

/** Converts native form values into the parser format without exposing it in the UI. */
export function serializeNativeQuestion(draft: NativeCardDraft, settings: SRSettings): string {
    const front = draft.front.trim();
    const back = draft.back.trim();
    const answerModeMarker = draft.answerMode === "type" ? "\n<!-- sr-answer-mode: type -->" : "";

    if (draft.type === "cloze") {
        const wrapper = getClozeWrapper(settings);
        if (wrapper === null) throw new Error("cloze-pattern-unavailable");
        const matchIndex = front.indexOf(back);
        if (matchIndex < 0) throw new Error("cloze-answer-not-found");
        const text = `${front.slice(0, matchIndex)}${wrapper[0]}${back}${wrapper[1]}${front.slice(
            matchIndex + back.length,
        )}`;
        return `${text}${answerModeMarker}`;
    }

    const separator =
        draft.type === "reversed"
            ? settings.multilineReversedCardSeparator
            : settings.multilineCardSeparator;
    const endMarker = settings.multilineCardEndMarker ? `\n${settings.multilineCardEndMarker}` : "";
    return `${front}\n${separator}\n${back}${answerModeMarker}${endMarker}`;
}

function stripRootDeckPath(path: string[], rootPath: string[]): string {
    const startsAtRoot = rootPath.every((segment, index) => path[index] === segment);
    return (startsAtRoot ? path.slice(rootPath.length) : path).join("/");
}

export class NativeCardStore {
    constructor(private readonly plugin: SRPlugin) {}

    getDeckPaths(): string[] {
        const result = new Set(this.plugin.dataManager.data.managedDecks);
        const rootTag = this.plugin.dataManager.data.settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG;
        const rootPath = rootTag.replace(/^#/, "").split("/").filter(Boolean);

        if (this.plugin.dataManager.isOsrCoreLoaded()) {
            const visit = (deck: Deck, path: string[]): void => {
                const nextPath = deck.parent === null ? path : [...path, deck.deckName];
                if (deck.parent !== null) {
                    const visiblePath = stripRootDeckPath(nextPath, rootPath);
                    if (visiblePath) result.add(visiblePath);
                }
                for (const subdeck of deck.subdecks) visit(subdeck, nextPath);
            };
            visit(this.plugin.dataManager.osrCore.reviewableDeckTree, []);
        }

        return [...result].filter(Boolean).sort((a, b) => a.localeCompare(b));
    }

    async createDeck(name: string): Promise<string> {
        const deckPath = normalizeManagedDeckPath(name);
        if (!deckPath) throw new Error("invalid-deck-name");

        const decks = this.plugin.dataManager.data.managedDecks;
        if (!decks.includes(deckPath)) {
            decks.push(deckPath);
            decks.sort((a, b) => a.localeCompare(b));
            await this.plugin.dataManager.savePluginData();
            this.plugin.dataManager.applyManagedDecks();
            await this.plugin.dataManager.osrCore.finalizeLoad();
        }
        await this.plugin.dataManager.collectionStore.ensureDeckPath(deckPath);
        return deckPath;
    }

    getKnowledgeAreas(): KnowledgeArea[] {
        return this.plugin.dataManager.data.knowledgeAreas.map((area) => ({
            ...area,
            deckPaths: [...area.deckPaths],
        }));
    }

    async createKnowledgeArea(name: string): Promise<KnowledgeArea> {
        const normalizedName = name.trim().replace(/\s+/g, " ");
        if (!normalizedName) throw new Error("invalid-area-name");

        const duplicate = this.plugin.dataManager.data.knowledgeAreas.find(
            (area) => area.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase(),
        );
        if (duplicate) return duplicate;

        const area: KnowledgeArea = {
            id: `area-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            name: normalizedName,
            deckPaths: [],
            pinned: false,
        };
        this.plugin.dataManager.data.knowledgeAreas.push(area);
        await this.plugin.dataManager.savePluginData();
        return area;
    }

    async renameKnowledgeArea(id: string, name: string): Promise<KnowledgeArea> {
        const area = this.requireKnowledgeArea(id);
        const normalizedName = name.trim().replace(/\s+/g, " ");
        if (!normalizedName) throw new Error("invalid-area-name");
        area.name = normalizedName;
        await this.plugin.dataManager.savePluginData();
        return area;
    }

    async setKnowledgeAreaPinned(id: string, pinned: boolean): Promise<void> {
        this.requireKnowledgeArea(id).pinned = pinned;
        await this.plugin.dataManager.savePluginData();
    }

    async removeKnowledgeArea(id: string): Promise<void> {
        const areas = this.plugin.dataManager.data.knowledgeAreas;
        const index = areas.findIndex((area) => area.id === id);
        if (index < 0) return;
        areas.splice(index, 1);
        await this.plugin.dataManager.savePluginData();
    }

    async assignDeckToKnowledgeArea(deckPath: string, areaId: string): Promise<void> {
        const normalizedDeckPath = normalizeManagedDeckPath(deckPath);
        if (!normalizedDeckPath) return;
        const target = this.requireKnowledgeArea(areaId);
        for (const area of this.plugin.dataManager.data.knowledgeAreas) {
            area.deckPaths = area.deckPaths.filter((path) => path !== normalizedDeckPath);
        }
        if (!target.deckPaths.includes(normalizedDeckPath)) {
            target.deckPaths.push(normalizedDeckPath);
        }
        await this.plugin.dataManager.savePluginData();
    }

    async unassignDeckFromKnowledgeAreas(deckPath: string): Promise<void> {
        const normalizedDeckPath = normalizeManagedDeckPath(deckPath);
        for (const area of this.plugin.dataManager.data.knowledgeAreas) {
            area.deckPaths = area.deckPaths.filter((path) => path !== normalizedDeckPath);
        }
        await this.plugin.dataManager.savePluginData();
    }

    private requireKnowledgeArea(id: string): KnowledgeArea {
        const area = this.plugin.dataManager.data.knowledgeAreas.find((item) => item.id === id);
        if (!area) throw new Error("knowledge-area-not-found");
        return area;
    }

    async createCard(draft: NativeCardDraft): Promise<TFile> {
        const [file] = await this.createCards([draft]);
        return file;
    }

    async updateCard(card: Card, draft: NativeCardDraft): Promise<void> {
        const settings = this.plugin.dataManager.data.settings;
        const question = card.question;
        let modifiedText: string;
        if (question.questionType === CardType.SingleLineBasic) {
            modifiedText = `${draft.front.trim()}${settings.singleLineCardSeparator}${draft.back.trim()}`;
        } else if (question.questionType === CardType.SingleLineReversed) {
            modifiedText = `${draft.front.trim()}${settings.singleLineReversedCardSeparator}${draft.back.trim()}`;
        } else {
            modifiedText = serializeNativeQuestion(draft, settings);
        }
        if (
            draft.answerMode === "type" &&
            !/<!--\s*sr-answer-mode:\s*type\s*-->/i.test(modifiedText)
        ) {
            modifiedText += "\n<!-- sr-answer-mode: type -->";
        }
        const expanded = CardFrontBackUtil.expand(question.questionType, modifiedText, settings);
        if (expanded.length !== question.cards.length) throw new Error("card-count-changed");

        question.questionText.actualQuestion = modifiedText;
        const questionId = question.ensureStableId();
        await question.writeQuestion(settings);
        question.cards.forEach((candidate, index) => {
            candidate.front = expanded[index].front;
            candidate.back = expanded[index].back;
        });
        await this.plugin.dataManager.collectionStore.updateNativeNote({
            type: draft.type,
            front: draft.front.trim(),
            back: draft.back.trim(),
            answerMode: draft.answerMode,
            deckPath: normalizeManagedDeckPath(draft.deckPath),
            sourcePath: question.note.filePath,
            questionId,
            tags: draft.tags,
        });
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
    }

    async moveCards(sources: NativeCardSource[], deckPath: string): Promise<void> {
        const normalizedDeck = normalizeManagedDeckPath(deckPath);
        if (normalizedDeck) await this.createDeck(normalizedDeck);
        const settings = this.plugin.dataManager.data.settings;
        const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
        const nextTag = normalizedDeck ? `${rootTag}/${normalizedDeck}` : rootTag;
        const escapedRoot = rootTag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sourcePaths = [
            ...new Set(sources.map((source) => source.sourcePath).filter(Boolean)),
        ];
        for (const sourcePath of sourcePaths) {
            const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
            if (!(file instanceof TFile)) continue;
            const contents = await this.plugin.app.vault.read(file);
            const matcher = new RegExp(`${escapedRoot}(?:/[\\p{L}\\p{N}_.-]+)*`, "u");
            const updated = matcher.test(contents)
                ? contents.replace(matcher, nextTag)
                : `${nextTag}\n\n${contents}`;
            if (updated !== contents) await this.plugin.app.vault.modify(file, updated);
        }
        await this.plugin.dataManager.collectionStore.moveNotesBySource(sources, normalizedDeck);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
    }

    async setCardTags(sources: NativeCardSource[], tags: string[]): Promise<void> {
        await this.plugin.dataManager.collectionStore.setNotesTagsBySource(sources, tags);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
    }

    /** Creates a group of cards with one final index refresh (used by image occlusion). */
    async createCards(drafts: NativeCardDraft[]): Promise<TFile[]> {
        if (drafts.length === 0) return [];
        const deckPaths = new Set(
            drafts.map((draft) => normalizeManagedDeckPath(draft.deckPath)).filter(Boolean),
        );
        for (const deckPath of deckPaths) await this.createDeck(deckPath);

        const files: TFile[] = [];
        for (const draft of drafts) files.push(await this.createCardFile(draft));
        for (const file of files) await this.waitForMetadata(this.plugin.app, file);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        return files;
    }

    /** Saves an offline attachment in the vault and returns its embeddable vault path. */
    async saveMediaAsset(fileName: string, data: ArrayBuffer): Promise<string> {
        const settings = this.plugin.dataManager.data.settings;
        const mediaFolder = normalizePath(`${settings.scheduleDataVaultLocation}/Media`);
        await this.ensureFolder(mediaFolder);
        const safeName =
            fileName
                .normalize("NFKD")
                .replace(/[^\p{L}\p{N}._-]+/gu, "-")
                .replace(/^-+|-+$/g, "") || `media-${Date.now()}`;
        const dot = safeName.lastIndexOf(".");
        const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
        const extension = dot > 0 ? safeName.slice(dot) : "";
        let path = normalizePath(`${mediaFolder}/${stem}${extension}`);
        let suffix = 2;
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = normalizePath(`${mediaFolder}/${stem}-${suffix}${extension}`);
            suffix++;
        }
        await this.plugin.app.vault.createBinary(path, data);
        return path;
    }

    private async createCardFile(draft: NativeCardDraft): Promise<TFile> {
        const normalizedDeck = normalizeManagedDeckPath(draft.deckPath);

        const settings = this.plugin.dataManager.data.settings;
        const rootFolder = normalizePath(`${settings.scheduleDataVaultLocation}/Cards`);
        const deckFolder = normalizedDeck
            ? `${rootFolder}/${normalizedDeck}`
            : `${rootFolder}/Inbox`;
        await this.ensureFolder(deckFolder);

        const slug =
            draft.front
                .normalize("NFKD")
                .replace(/[^\p{L}\p{N}]+/gu, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 54) || "card";
        let path = normalizePath(`${deckFolder}/${slug}.md`);
        let suffix = 2;
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = normalizePath(`${deckFolder}/${slug}-${suffix}.md`);
            suffix++;
        }

        const noteId = this.plugin.dataManager.collectionStore.createId("note");
        const questionId = `^sr-data-id-${noteId}`;
        const contents = serializeNativeCard(
            { ...draft, deckPath: normalizedDeck },
            settings,
            questionId,
        );
        const file = await this.plugin.app.vault.create(path, contents);
        await this.plugin.dataManager.collectionStore.createNativeNote({
            id: noteId,
            type: draft.type,
            front: draft.front.trim(),
            back: draft.back.trim(),
            answerMode: draft.answerMode,
            deckPath: normalizedDeck,
            sourcePath: file.path,
            questionId,
            tags: draft.tags,
        });
        return file;
    }

    async createStructuredNote(draft: StructuredNoteDraft): Promise<TFile> {
        const collection = this.plugin.dataManager.collectionStore;
        const noteType = collection.getNoteType(draft.noteTypeId);
        if (!noteType) throw new Error("note-type-not-found");
        for (const field of noteType.fields) {
            if (field.required && !draft.fields[field.id]?.trim()) {
                throw new Error(`required-field-empty:${field.id}`);
            }
        }

        const normalizedDeck = normalizeManagedDeckPath(draft.deckPath);
        if (normalizedDeck) await this.createDeck(normalizedDeck);
        const settings = this.plugin.dataManager.data.settings;
        const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
        const tag = normalizedDeck ? `${rootTag}/${normalizedDeck}` : rootTag;
        const noteId = collection.createId("note");
        const baseQuestionId = `^sr-data-id-${noteId}`;
        const { body, legacyQuestionIds, legacyStableIds } = serializeStructuredNoteBody(
            noteType,
            draft.fields,
            settings,
            baseQuestionId,
        );

        const rootFolder = normalizePath(`${settings.scheduleDataVaultLocation}/Cards`);
        const deckFolder = normalizedDeck
            ? `${rootFolder}/${normalizedDeck}`
            : `${rootFolder}/Inbox`;
        await this.ensureFolder(deckFolder);
        const title = noteType.fields.map((field) => draft.fields[field.id]?.trim()).find(Boolean);
        const slug =
            (title ?? "note")
                .normalize("NFKD")
                .replace(/[^\p{L}\p{N}]+/gu, "-")
                .replace(/^-|-$/g, "")
                .slice(0, 54) || "note";
        let path = normalizePath(`${deckFolder}/${slug}.md`);
        let suffix = 2;
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = normalizePath(`${deckFolder}/${slug}-${suffix}.md`);
            suffix++;
        }

        const file = await this.plugin.app.vault.create(path, `${tag}\n\n${body}\n`);
        await collection.createNote({
            id: noteId,
            noteTypeId: noteType.id,
            fields: draft.fields,
            tags: draft.tags,
            deckPath: normalizedDeck,
            source: { kind: "managed", path: file.path, questionId: baseQuestionId },
            legacyQuestionIds,
            legacyStableIds,
        });
        await this.waitForMetadata(this.plugin.app, file);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        return file;
    }

    async createImageOcclusionNote(draft: ImageOcclusionNoteDraft): Promise<TFile> {
        const collection = this.plugin.dataManager.collectionStore;
        const normalizedDeck = normalizeManagedDeckPath(draft.deckPath);
        if (normalizedDeck) await this.createDeck(normalizedDeck);
        const noteId = collection.createId("note");
        const baseQuestionId = `^sr-data-id-${noteId}`;
        const { body, legacyQuestionIds } = serializeImageOcclusionBody(
            draft.assets,
            baseQuestionId,
            this.plugin.dataManager.data.settings.multilineCardSeparator,
        );
        const settings = this.plugin.dataManager.data.settings;
        const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
        const tag = normalizedDeck ? `${rootTag}/${normalizedDeck}` : rootTag;
        const rootFolder = normalizePath(`${settings.scheduleDataVaultLocation}/Cards`);
        const deckFolder = normalizedDeck
            ? `${rootFolder}/${normalizedDeck}`
            : `${rootFolder}/Inbox`;
        await this.ensureFolder(deckFolder);
        let path = normalizePath(`${deckFolder}/image-occlusion-${Date.now()}.md`);
        let suffix = 2;
        while (this.plugin.app.vault.getAbstractFileByPath(path)) {
            path = normalizePath(`${deckFolder}/image-occlusion-${Date.now()}-${suffix}.md`);
            suffix++;
        }
        const file = await this.plugin.app.vault.create(path, `${tag}\n\n${body}\n`);
        await collection.createNote({
            id: noteId,
            noteTypeId: IMAGE_OCCLUSION_NOTE_TYPE_ID,
            fields: {
                [OCCLUSION_SOURCE_FIELD_ID]: draft.sourcePath,
                [OCCLUSION_MASKS_FIELD_ID]: draft.masksJson,
                [OCCLUSION_ASSETS_FIELD_ID]: JSON.stringify(draft.assets),
                [OCCLUSION_MODE_FIELD_ID]: draft.mode,
            },
            tags: draft.tags,
            deckPath: normalizedDeck,
            source: { kind: "managed", path: file.path, questionId: baseQuestionId },
            legacyQuestionIds,
        });
        await this.waitForMetadata(this.plugin.app, file);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        return file;
    }

    async updateImageOcclusionNote(
        note: CollectionNote,
        draft: ImageOcclusionNoteDraft,
    ): Promise<TFile> {
        const file = this.plugin.app.vault.getAbstractFileByPath(note.source.path);
        if (!(file instanceof TFile)) throw new Error("note-source-not-found");
        const normalizedDeck = normalizeManagedDeckPath(draft.deckPath);
        if (normalizedDeck) await this.createDeck(normalizedDeck);
        const baseQuestionId = note.source.questionId ?? `^sr-data-id-${note.id}`;
        const { body, legacyQuestionIds } = serializeImageOcclusionBody(
            draft.assets,
            baseQuestionId,
            this.plugin.dataManager.data.settings.multilineCardSeparator,
        );
        const settings = this.plugin.dataManager.data.settings;
        const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
        const tag = normalizedDeck ? `${rootTag}/${normalizedDeck}` : rootTag;
        await this.plugin.app.vault.modify(file, `${tag}\n\n${body}\n`);
        await this.plugin.dataManager.collectionStore.updateNote(note.id, {
            fields: {
                [OCCLUSION_SOURCE_FIELD_ID]: draft.sourcePath,
                [OCCLUSION_MASKS_FIELD_ID]: draft.masksJson,
                [OCCLUSION_ASSETS_FIELD_ID]: JSON.stringify(draft.assets),
                [OCCLUSION_MODE_FIELD_ID]: draft.mode,
            },
            tags: draft.tags,
            deckPath: normalizedDeck,
            source: { ...note.source, questionId: baseQuestionId },
            legacyQuestionIds,
        });
        await this.waitForMetadata(this.plugin.app, file);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        return file;
    }

    async updateStructuredNote(note: CollectionNote, draft: StructuredNoteDraft): Promise<TFile> {
        const collection = this.plugin.dataManager.collectionStore;
        const noteType = collection.getNoteType(draft.noteTypeId);
        if (!noteType) throw new Error("note-type-not-found");
        const file = this.plugin.app.vault.getAbstractFileByPath(note.source.path);
        if (!(file instanceof TFile)) throw new Error("note-source-not-found");
        const normalizedDeck = normalizeManagedDeckPath(draft.deckPath);
        if (normalizedDeck) await this.createDeck(normalizedDeck);
        const settings = this.plugin.dataManager.data.settings;
        const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
        const tag = normalizedDeck ? `${rootTag}/${normalizedDeck}` : rootTag;
        const baseQuestionId = note.source.questionId ?? `^sr-data-id-${note.id}`;
        const { body, legacyQuestionIds, legacyStableIds } = serializeStructuredNoteBody(
            noteType,
            draft.fields,
            settings,
            baseQuestionId,
        );
        await this.plugin.app.vault.modify(file, `${tag}\n\n${body}\n`);
        if (note.noteTypeId !== noteType.id) {
            const previousType = collection.getNoteType(note.noteTypeId);
            const fieldMapping = Object.fromEntries(
                noteType.fields.map((field) => {
                    const sameName = previousType?.fields.find(
                        (candidate) =>
                            candidate.name.localeCompare(field.name, undefined, {
                                sensitivity: "base",
                            }) === 0,
                    );
                    return [
                        field.id,
                        note.fields[field.id] !== undefined ? field.id : (sameName?.id ?? field.id),
                    ];
                }),
            );
            await collection.convertNoteType(
                note.id,
                noteType.id,
                fieldMapping,
                normalizedDeck,
                draft.fields,
            );
        }
        await collection.updateNote(note.id, {
            fields: draft.fields,
            tags: draft.tags,
            deckPath: normalizedDeck,
            source: { ...note.source, questionId: baseQuestionId },
            legacyQuestionIds,
            legacyStableIds,
        });
        await this.waitForMetadata(this.plugin.app, file);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        return file;
    }

    /** Rebuilds managed card sources after a note type's templates or styling change. */
    async refreshStructuredNotesForType(noteTypeId: string): Promise<number> {
        const collection = this.plugin.dataManager.collectionStore;
        const noteType = collection.getNoteType(noteTypeId);
        if (!noteType || noteType.kind === "image-occlusion") return 0;
        const snapshot = collection.getCollectionSnapshot();
        const notes = Object.values(snapshot.notes).filter(
            (note) =>
                !note.deletedAt && note.noteTypeId === noteTypeId && note.source.kind === "managed",
        );
        const settings = this.plugin.dataManager.data.settings;
        const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
        let refreshed = 0;
        for (const note of notes) {
            const file = this.plugin.app.vault.getAbstractFileByPath(note.source.path);
            if (!(file instanceof TFile)) continue;
            const card = Object.values(snapshot.cards).find(
                (candidate) => !candidate.deletedAt && candidate.noteId === note.id,
            );
            const deckPath = normalizeManagedDeckPath(card?.deckPath ?? "");
            const tag = deckPath ? `${rootTag}/${deckPath}` : rootTag;
            const baseQuestionId = note.source.questionId ?? `^sr-data-id-${note.id}`;
            const { body, legacyQuestionIds, legacyStableIds } = serializeStructuredNoteBody(
                noteType,
                note.fields,
                settings,
                baseQuestionId,
            );
            await this.plugin.app.vault.modify(file, `${tag}\n\n${body}\n`);
            await collection.updateNote(note.id, {
                fields: note.fields,
                tags: note.tags,
                deckPath,
                source: { ...note.source, questionId: baseQuestionId },
                legacyQuestionIds,
                legacyStableIds,
            });
            refreshed++;
        }
        if (refreshed > 0) {
            await this.plugin.dataManager.sync();
            this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        }
        return refreshed;
    }

    private async ensureFolder(path: string): Promise<void> {
        const parts = normalizePath(path).split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
                await this.plugin.app.vault.createFolder(current);
            }
        }
    }

    private async waitForMetadata(app: App, file: TFile): Promise<void> {
        if (app.metadataCache.getFileCache(file)) return;
        await new Promise<void>((resolve) => {
            let done = false;
            const finish = (): void => {
                if (done) return;
                done = true;
                app.metadataCache.offref(ref);
                window.clearTimeout(timeout);
                resolve();
            };
            const ref = app.metadataCache.on("changed", (changedFile) => {
                if (changedFile.path === file.path) finish();
            });
            const timeout = window.setTimeout(finish, 1500);
        });
    }
}
