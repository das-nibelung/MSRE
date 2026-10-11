import { normalizePath, TFile } from "obsidian";

import {
    AnkiCard,
    AnkiDeck,
    AnkiModel,
    AnkiNote,
    AnkiPackage,
    writeAnkiPackage,
} from "src/data/anki/anki-package";
import { IMAGE_OCCLUSION_NOTE_TYPE_ID } from "src/data/collection/builtin-note-types";
import {
    CardTemplateDefinition,
    CollectionNote,
    NoteFieldDefinition,
    NoteTypeDefinition,
} from "src/data/collection/collection-types";
import {
    ImageOcclusionAssetDraft,
    NativeCardStore,
    normalizeManagedDeckPath,
    StructuredNoteDraft,
} from "src/data/native-card-store";
import SRPlugin from "src/main";
import {
    loadOcclusionImage,
    normalizeOcclusionMask,
    OcclusionMask,
    renderOcclusionAssets,
} from "src/ui/native-creator/image-occlusion";

export type DuplicatePolicy = "skip" | "replace" | "copy";

export interface AnkiImportOptions {
    deckIds?: Set<number>;
    duplicatePolicy: DuplicatePolicy;
    onProgress?: (completed: number, total: number) => void;
}

export interface AnkiImportReport {
    created: number;
    updated: number;
    skipped: number;
    noteTypes: number;
    decks: number;
    media: number;
    scheduledCards: number;
    errors: Array<{ identity: string; message: string }>;
}

function stableSegment(value: string, fallback: string): string {
    return (
        value
            .normalize("NFKD")
            .toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "") || fallback
    );
}

function fieldId(modelId: number, field: string, ordinal: number): string {
    return `anki-${modelId}-field-${ordinal}-${stableSegment(field, "field")}`;
}

function modelId(model: AnkiModel): string {
    return `anki-model-${model.id}`;
}

function templateId(model: AnkiModel, ordinal: number): string {
    return `anki-${model.id}-template-${ordinal}`;
}

function deckPath(deck?: AnkiDeck): string {
    const value = deck?.name === "Default" ? "" : (deck?.name ?? "");
    return normalizeManagedDeckPath(value.replaceAll("::", "/"));
}

function rewriteTemplateTypeAnswers(format: string): string {
    return format.replace(/{{type:([^}]+)}}/gi, "{{$1}}");
}

function toNoteType(model: AnkiModel, rewrite: (value: string) => string): NoteTypeDefinition {
    const fields: NoteFieldDefinition[] = model.fields.map((field) => ({
        id: fieldId(model.id, field.name, field.ordinal),
        name: field.name,
        ordinal: field.ordinal,
        kind: /image|audio|video|media/i.test(field.name) ? "media" : "rich-text",
        required: false,
    }));
    const templates: CardTemplateDefinition[] = model.templates.map(
        (template): CardTemplateDefinition => {
            const typedField = template.questionFormat.match(/{{type:([^}]+)}}/i)?.[1]?.trim();
            const answerFieldId = typedField
                ? fields.find(
                      (field) => field.name.toLocaleLowerCase() === typedField.toLocaleLowerCase(),
                  )?.id
                : null;
            const sourceField =
                model.kind === "cloze"
                    ? model.fields.find((field) =>
                          new RegExp(
                              `{{cloze:${field.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}}}`,
                              "i",
                          ).test(template.questionFormat),
                      )
                    : null;
            return {
                id: templateId(model, template.ordinal),
                version: 1,
                name: template.name,
                ordinal: template.ordinal,
                questionFormat: rewrite(rewriteTemplateTypeAnswers(template.questionFormat)),
                answerFormat: rewrite(rewriteTemplateTypeAnswers(template.answerFormat)),
                deckOverride: null,
                enabled: true,
                generator: model.kind,
                answerMode: typedField ? "type" : "reveal",
                answerFieldId: answerFieldId ?? null,
                sourceFieldId: sourceField
                    ? fieldId(model.id, sourceField.name, sourceField.ordinal)
                    : null,
            };
        },
    );
    return {
        id: modelId(model),
        version: 1,
        name: model.name,
        kind: model.kind,
        fields,
        templates,
        css: rewrite(model.css),
        externalIds: { ankiModelId: String(model.id) },
        externalData: { ankiModel: model.raw },
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
}

function safeMediaName(fileName: string): string {
    return (
        fileName
            .normalize("NFKD")
            .replace(/[^\p{L}\p{N}._-]+/gu, "-")
            .replace(/^-+|-+$/g, "") || `media-${Date.now()}`
    );
}

function createMediaRewriter(paths: Map<string, string>): (value: string) => string {
    return (value) => {
        let result = value;
        for (const [original, path] of paths) {
            const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            result = result.replace(new RegExp(`\\[sound:${escaped}\\]`, "gi"), `![[${path}]]`);
            result = result.replace(
                new RegExp(`<img([^>]*?)src=["']?${escaped}["']?([^>]*)>`, "gi"),
                `![[${path}]]`,
            );
            result = result.replace(
                new RegExp(`(src\\s*=\\s*["'])${escaped}(["'])`, "gi"),
                `$1${path}$2`,
            );
            result = result.replace(
                new RegExp(`url\\((["']?)${escaped}\\1\\)`, "gi"),
                `url("${path}")`,
            );
        }
        return result;
    };
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    return JSON.stringify(error);
}

function ankiData(note: AnkiNote, model: AnkiModel | undefined, deck: AnkiDeck | undefined) {
    return {
        anki: {
            noteId: note.id,
            modelId: note.modelId,
            flags: note.flags,
            data: note.data,
            modifiedAt: note.modifiedAt,
            cards: note.cards,
            model,
            originalFields: note.fields,
            deckRaw: deck?.raw,
        },
    };
}

function unescapeOcclusionValue(value: string): string {
    return value.replace(/\\:/g, ":").replace(/\\\\/g, "\\");
}

function parseOcclusionProperties(value: string): Record<string, string> {
    const properties: Record<string, string> = {};
    const shapeEnd = value.indexOf(":");
    if (shapeEnd < 0) return properties;
    const source = value.slice(shapeEnd + 1);
    let name = "";
    let current = "";
    let readingName = true;
    let escaped = false;
    const flush = () => {
        if (name) properties[name] = unescapeOcclusionValue(current);
        name = "";
        current = "";
        readingName = true;
    };
    for (const char of source) {
        if (escaped) {
            current += `\\${char}`;
            escaped = false;
        } else if (char === "\\") {
            escaped = true;
        } else if (readingName && char === "=") {
            name = current;
            current = "";
            readingName = false;
        } else if (!readingName && char === ":") {
            flush();
        } else {
            current += char;
        }
    }
    flush();
    return properties;
}

function parseAnkiOcclusionMasks(value: string): OcclusionMask[] {
    const masks: OcclusionMask[] = [];
    const pattern = /{{c([\d,]+)::image-occlusion:([\s\S]*?)}}/gi;
    for (const match of value.matchAll(pattern)) {
        const shapeAndProperties = match[2];
        const shapeName = shapeAndProperties.split(":", 1)[0];
        const properties = parseOcclusionProperties(shapeAndProperties);
        const ordinals = match[1]
            .split(",")
            .map(Number)
            .filter((ordinal) => ordinal > 0);
        for (const ordinal of ordinals) {
            const points = (properties.points ?? "")
                .split(/\s+/)
                .map((pair) => pair.split(",").map(Number))
                .filter((point) => point.length === 2 && point.every(Number.isFinite))
                .map(([x, y]) => ({ x, y }));
            const finite = (value: string | undefined): number | undefined => {
                const parsed = Number(value);
                return Number.isFinite(parsed) ? parsed : undefined;
            };
            masks.push(
                normalizeOcclusionMask(
                    {
                        id: `anki-${ordinal}-${masks.length + 1}`,
                        groupId: `anki-${ordinal}`,
                        shape:
                            shapeName === "ellipse"
                                ? "ellipse"
                                : shapeName === "polygon"
                                  ? "polygon"
                                  : "rectangle",
                        x: finite(properties.left),
                        y: finite(properties.top),
                        width: finite(properties.width),
                        height: finite(properties.height),
                        points,
                        label: properties.text ?? "",
                    },
                    masks.length,
                ),
            );
        }
    }
    return masks;
}

function mediaType(fileName: string): string {
    const extension = fileName.split(".").pop()?.toLocaleLowerCase();
    if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
    if (extension === "gif") return "image/gif";
    if (extension === "webp") return "image/webp";
    if (extension === "svg") return "image/svg+xml";
    return "image/png";
}

function readAnkiData(note: CollectionNote): Record<string, unknown> | null {
    const value = note.externalData?.anki;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asCards(value: unknown): AnkiCard[] {
    return Array.isArray(value) ? (value as AnkiCard[]) : [];
}

function asAnkiModel(value: unknown): AnkiModel | null {
    if (!value || typeof value !== "object") return null;
    const model = value as Partial<AnkiModel>;
    return typeof model.id === "number" &&
        Array.isArray(model.fields) &&
        Array.isArray(model.templates)
        ? (model as AnkiModel)
        : null;
}

export class AnkiTransferService {
    private readonly store: NativeCardStore;

    constructor(private readonly plugin: SRPlugin) {
        this.store = new NativeCardStore(plugin);
    }

    countDuplicates(pkg: AnkiPackage): number {
        const guids = new Set(
            Object.values(this.plugin.dataManager.collectionStore.getCollectionSnapshot().notes)
                .map((note) => note.externalIds?.ankiGuid)
                .filter((value): value is string => Boolean(value)),
        );
        return pkg.notes.filter((note) => guids.has(note.guid)).length;
    }

    private async importMedia(pkg: AnkiPackage): Promise<Map<string, string>> {
        const mediaFolder = normalizePath(
            `${this.plugin.dataManager.data.settings.scheduleDataVaultLocation}/Media`,
        );
        const result = new Map<string, string>();
        for (const [fileName, bytes] of Object.entries(pkg.media)) {
            const existingPath = normalizePath(`${mediaFolder}/${safeMediaName(fileName)}`);
            const existing = this.plugin.app.vault.getAbstractFileByPath(existingPath);
            if (existing instanceof TFile) {
                result.set(fileName, existing.path);
                continue;
            }
            const path = await this.store.saveMediaAsset(fileName, Uint8Array.from(bytes).buffer);
            result.set(fileName, path);
        }
        return result;
    }

    private async createOcclusionDraft(
        note: AnkiNote,
        model: AnkiModel,
        deck: AnkiDeck | undefined,
        mediaPaths: Map<string, string>,
        externalGuid = note.guid,
    ) {
        const occlusionIndex = model.fields.findIndex((field) => /occlusion/i.test(field.name));
        const imageIndex = model.fields.findIndex((field) => /^image$/i.test(field.name));
        const headerIndex = model.fields.findIndex((field) => /^header$/i.test(field.name));
        const extraIndex = model.fields.findIndex((field) => /back.?extra/i.test(field.name));
        const commentsIndex = model.fields.findIndex((field) => /^comments?$/i.test(field.name));
        const rawOcclusions = note.fields[occlusionIndex >= 0 ? occlusionIndex : 0] ?? "";
        const rawImage = note.fields[imageIndex >= 0 ? imageIndex : 1] ?? "";
        const originalName = rawImage.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
        const sourcePath = originalName ? mediaPaths.get(originalName) : undefined;
        if (!sourcePath) throw new Error("anki-image-occlusion-source-missing");
        const masks = parseAnkiOcclusionMasks(rawOcclusions);
        if (masks.length === 0) throw new Error("anki-image-occlusion-masks-missing");
        const sourceFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
        if (!(sourceFile instanceof TFile)) throw new Error("anki-image-occlusion-source-missing");
        const sourceBytes = await this.plugin.app.vault.readBinary(sourceFile);
        const loaded = await loadOcclusionImage(
            new File([sourceBytes], sourceFile.name, { type: mediaType(sourceFile.name) }),
        );
        const rendered = await renderOcclusionAssets(loaded, masks, "hide-all");
        const assets: ImageOcclusionAssetDraft[] = [];
        for (const [index, asset] of rendered.entries()) {
            const questionPath = await this.store.saveMediaAsset(
                `${sourceFile.basename}-anki-${index + 1}-question.png`,
                asset.question,
            );
            const answerPath = await this.store.saveMediaAsset(
                `${sourceFile.basename}-anki-${index + 1}-answer.png`,
                asset.answer,
            );
            const group = masks.filter((mask) => asset.maskIds.includes(mask.id));
            const label = group
                .map((mask) => mask.label)
                .filter(Boolean)
                .join(" · ");
            assets.push({
                maskId: asset.maskId,
                maskIds: asset.maskIds,
                questionPath,
                answerPath,
                label,
                acceptedLabels: label ? [label] : [],
            });
        }
        return {
            deckPath: deckPath(deck),
            sourcePath,
            masksJson: JSON.stringify(masks),
            mode: "hide-all" as const,
            assets,
            header: headerIndex >= 0 ? note.fields[headerIndex] : "",
            extra: extraIndex >= 0 ? note.fields[extraIndex] : "",
            comments: commentsIndex >= 0 ? note.fields[commentsIndex] : "",
            tags: note.tags,
            externalIds: { ankiGuid: externalGuid, ankiNoteId: String(note.id) },
            externalData: ankiData(note, model, deck),
        };
    }

    async importPackage(pkg: AnkiPackage, options: AnkiImportOptions): Promise<AnkiImportReport> {
        const report: AnkiImportReport = {
            created: 0,
            updated: 0,
            skipped: 0,
            noteTypes: 0,
            decks: 0,
            media: 0,
            scheduledCards: 0,
            errors: [],
        };
        await this.plugin.dataManager.collectionStore.createBackup("before-anki-import");
        const mediaPaths = await this.importMedia(pkg);
        report.media = mediaPaths.size;
        const rewrite = createMediaRewriter(mediaPaths);
        const selectedDeckIds = options.deckIds ?? new Set(pkg.decks.map((deck) => deck.id));
        const selectedNotes = pkg.notes.filter(
            (note) =>
                note.cards.length === 0 ||
                note.cards.some((card) => selectedDeckIds.has(card.deckId)),
        );
        const usedModels = new Set(selectedNotes.map((note) => note.modelId));
        for (const model of pkg.models.filter((candidate) => usedModels.has(candidate.id))) {
            try {
                const definition = toNoteType(model, rewrite);
                await this.plugin.dataManager.collectionStore.saveNoteType(definition);
                report.noteTypes++;
            } catch (error) {
                report.errors.push({ identity: model.name, message: errorMessage(error) });
            }
        }
        for (const deck of pkg.decks.filter((candidate) => selectedDeckIds.has(candidate.id))) {
            const path = deckPath(deck);
            if (!path) continue;
            try {
                await this.store.createDeck(path);
                report.decks++;
                const config = pkg.deckConfigs[String(deck.configId)] ?? {};
                const rawWeights = config.fsrsWeights;
                const weights = Array.isArray(rawWeights)
                    ? rawWeights.map(Number).filter(Number.isFinite)
                    : typeof rawWeights === "string"
                      ? rawWeights.split(",").map(Number).filter(Number.isFinite)
                      : [];
                if (Object.keys(config).length > 0) {
                    const optionsId = `anki-options-${deck.configId}`;
                    await this.plugin.dataManager.collectionStore.saveDeckOptions({
                        id: optionsId,
                        name:
                            typeof config.name === "string" ? config.name : `Anki ${deck.configId}`,
                        newCardsPerDay: Number(
                            config.newCardsPerDay ??
                                (config.new as Record<string, unknown> | undefined)?.perDay ??
                                20,
                        ),
                        reviewsPerDay: Number(
                            config.reviewsPerDay ??
                                (config.rev as Record<string, unknown> | undefined)?.perDay ??
                                200,
                        ),
                        desiredRetention: Math.max(
                            0.7,
                            Math.min(0.99, Number(config.desiredRetention ?? 0.9)),
                        ),
                        newCardOrder: "sequential",
                        fsrsWeights: weights.length > 0 ? weights : null,
                        learningSteps: Array.isArray(config.learningSteps)
                            ? config.learningSteps.map(Number).filter((step) => step > 0)
                            : undefined,
                        relearningSteps: Array.isArray(config.relearningSteps)
                            ? config.relearningSteps.map(Number).filter((step) => step > 0)
                            : undefined,
                    });
                    await this.plugin.dataManager.collectionStore.updateDeck(path, { optionsId });
                }
            } catch (error) {
                report.errors.push({ identity: deck.name, message: errorMessage(error) });
            }
        }

        const snapshot = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const existingByGuid = new Map<string, CollectionNote>();
        for (const note of Object.values(snapshot.notes)) {
            if (!note.deletedAt && note.externalIds?.ankiGuid) {
                existingByGuid.set(note.externalIds.ankiGuid, note);
            }
        }
        const drafts: StructuredNoteDraft[] = [];
        for (const [index, note] of selectedNotes.entries()) {
            try {
                const model = pkg.models.find((candidate) => candidate.id === note.modelId);
                if (!model) throw new Error("anki-model-missing");
                const primaryCard =
                    note.cards.find((card) => selectedDeckIds.has(card.deckId)) ?? note.cards[0];
                const deck = pkg.decks.find((candidate) => candidate.id === primaryCard?.deckId);
                const existing = existingByGuid.get(note.guid);
                if (existing && options.duplicatePolicy === "skip") {
                    report.skipped++;
                    continue;
                }
                if (model.imageOcclusion) {
                    const externalGuid =
                        existing && options.duplicatePolicy === "copy"
                            ? `${note.guid}-copy-${Date.now().toString(36)}-${index}`
                            : note.guid;
                    const occlusionDraft = await this.createOcclusionDraft(
                        note,
                        model,
                        deck,
                        mediaPaths,
                        externalGuid,
                    );
                    if (
                        existing &&
                        options.duplicatePolicy === "replace" &&
                        existing.noteTypeId === IMAGE_OCCLUSION_NOTE_TYPE_ID
                    ) {
                        await this.store.updateImageOcclusionNote(existing, occlusionDraft);
                        report.updated++;
                    } else {
                        await this.store.createImageOcclusionNote(occlusionDraft);
                        report.created++;
                    }
                    continue;
                }
                const fields = Object.fromEntries(
                    model.fields.map((field) => [
                        fieldId(model.id, field.name, field.ordinal),
                        rewrite(note.fields[field.ordinal] ?? ""),
                    ]),
                );
                const draft: StructuredNoteDraft = {
                    deckPath: deckPath(deck),
                    noteTypeId: modelId(model),
                    fields,
                    tags: note.tags,
                    externalIds: { ankiGuid: note.guid, ankiNoteId: String(note.id) },
                    externalData: ankiData(note, model, deck),
                };
                if (existing && options.duplicatePolicy === "replace") {
                    await this.store.updateStructuredNote(existing, draft);
                    report.updated++;
                } else {
                    if (existing) {
                        draft.externalIds = {
                            ankiGuid: `${note.guid}-copy-${Date.now().toString(36)}-${index}`,
                            ankiNoteId: String(note.id),
                        };
                    }
                    drafts.push(draft);
                }
            } catch (error) {
                report.errors.push({ identity: note.guid, message: errorMessage(error) });
            }
            options.onProgress?.(index + 1, selectedNotes.length);
        }
        const files = await this.store.createStructuredNotes(drafts, options.onProgress);
        report.created += files.length;
        report.scheduledCards =
            await this.plugin.dataManager.collectionStore.applyImportedAnkiState(
                selectedNotes.map((note) => ({ guid: note.guid, cards: note.cards })),
                pkg.collectionCreatedAt,
            );
        await this.plugin.dataManager.sync();
        return report;
    }

    async exportPackage(deckPaths?: Set<string>): Promise<Uint8Array> {
        const collection = this.plugin.dataManager.collectionStore.getCollectionSnapshot();
        const reviewLog = this.plugin.dataManager.collectionStore.getReviewLogSnapshot();
        const sourceNotes = Object.values(collection.notes).filter((note) => !note.deletedAt);
        const sourceCards = Object.values(collection.cards).filter((card) => !card.deletedAt);
        const inScope = (note: CollectionNote) => {
            if (!deckPaths?.size) return true;
            return sourceCards.some(
                (card) => card.noteId === note.id && deckPaths.has(card.deckPath),
            );
        };
        const notes = sourceNotes.filter(inScope);
        const noteTypes = Object.values(collection.noteTypes).filter(
            (type) => !type.deletedAt && notes.some((note) => note.noteTypeId === type.id),
        );
        const now = Date.now();
        let nextId = now;
        const numericId = () => nextId++;
        const modelIdMap = new Map(
            noteTypes.map((type) => [
                type.id,
                Number(type.externalIds?.ankiModelId) || numericId(),
            ]),
        );
        const deckNames = new Set(
            sourceCards
                .filter((card) => notes.some((note) => note.id === card.noteId))
                .map((card) => card.deckPath),
        );
        if (deckNames.size === 0) deckNames.add("");
        const deckIdMap = new Map([...deckNames].map((path) => [path, numericId()]));
        const models: AnkiModel[] = noteTypes.map((type) => {
            const importedRaw = type.externalData?.ankiModel;
            return {
                id: modelIdMap.get(type.id),
                name: type.name,
                kind: type.kind === "cloze" ? "cloze" : "standard",
                css: type.css,
                fields: type.fields.map((field) => ({ name: field.name, ordinal: field.ordinal })),
                templates: type.templates.map((template) => ({
                    name: template.name,
                    ordinal: template.ordinal,
                    questionFormat: template.questionFormat,
                    answerFormat: template.answerFormat,
                    deckId: template.deckOverride
                        ? (deckIdMap.get(template.deckOverride) ?? null)
                        : null,
                })),
                raw:
                    importedRaw && typeof importedRaw === "object"
                        ? (importedRaw as Record<string, unknown>)
                        : {},
            };
        });
        for (const note of notes) {
            const imported = asAnkiModel(readAnkiData(note)?.model);
            if (imported && !models.some((model) => model.id === imported.id)) {
                models.push(imported);
            }
        }
        const collectionDeckByPath = new Map(
            Object.values(collection.decks)
                .filter((deck) => !deck.deletedAt)
                .map((deck) => [deck.name, deck]),
        );
        const usedOptionsIds = [
            ...new Set(
                [...deckNames].map(
                    (path) =>
                        collectionDeckByPath.get(path)?.optionsId ?? "builtin-default-options",
                ),
            ),
        ];
        const deckConfigIdMap = new Map(
            usedOptionsIds.map((optionsId, index) => [optionsId, index + 1]),
        );
        const deckConfigs = Object.fromEntries(
            usedOptionsIds.map((optionsId) => {
                const options = collection.deckOptions[optionsId];
                const id = deckConfigIdMap.get(optionsId);
                return [
                    String(id),
                    {
                        id,
                        name: options?.name ?? "Default",
                        mod: Math.floor((options?.updatedAt ?? now) / 1000),
                        usn: -1,
                        new: {
                            perDay: options?.newCardsPerDay ?? 20,
                            delays: options?.learningSteps ?? [1, 10],
                        },
                        rev: { perDay: options?.reviewsPerDay ?? 200 },
                        lapse: { delays: options?.relearningSteps ?? [10] },
                        fsrsWeights: options?.fsrsWeights ?? [],
                        desiredRetention: options?.desiredRetention ?? 0.9,
                    },
                ];
            }),
        );
        const decks: AnkiDeck[] = [...deckIdMap].map(([path, id]) => ({
            id,
            name: path ? path.replaceAll("/", "::") : "Default",
            description:
                collection.decks[
                    Object.keys(collection.decks).find(
                        (key) => collection.decks[key].name === path,
                    ) ?? ""
                ]?.description ?? "",
            configId:
                deckConfigIdMap.get(
                    collectionDeckByPath.get(path)?.optionsId ?? "builtin-default-options",
                ) ?? 1,
            raw: {},
        }));
        const media: Record<string, Uint8Array> = {};
        const mediaPrefix = normalizePath(
            `${this.plugin.dataManager.data.settings.scheduleDataVaultLocation}/Media/`,
        );
        for (const file of this.plugin.app.vault
            .getFiles()
            .filter((file) => file.path.startsWith(mediaPrefix))) {
            media[file.name] = new Uint8Array(await this.plugin.app.vault.readBinary(file));
        }
        const toAnkiMedia = (value: string) =>
            value.replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?]]/g, (_match, path: string) => {
                const parts = path.split("/");
                const name = parts[parts.length - 1] ?? path;
                if (/\.(mp3|m4a|wav|ogg|flac)$/i.test(name)) return `[sound:${name}]`;
                if (/\.(mp4|webm|mov)$/i.test(name))
                    return `<video controls src="${name}"></video>`;
                return `<img src="${name}">`;
            });
        const exportedNotes: AnkiNote[] = notes.map((note) => {
            const type = collection.noteTypes[note.noteTypeId];
            const raw = readAnkiData(note);
            const importedModel = asAnkiModel(raw?.model);
            const originalFields = Array.isArray(raw?.originalFields)
                ? raw.originalFields.filter((field): field is string => typeof field === "string")
                : null;
            const generatedCards = sourceCards
                .filter((card) => card.noteId === note.id)
                .sort((left, right) => left.ordinal - right.ordinal);
            const rawCards = asCards(raw?.cards);
            const cards: AnkiCard[] = generatedCards.map((card, index) => {
                const imported =
                    rawCards.find((item) => item.ordinal === card.ordinal) ?? rawCards[index];
                const schedule = card.schedule?.scheduleData as
                    { dueDate?: string; interval?: number; ease?: number } | undefined;
                const dueDate = schedule?.dueDate ? Date.parse(schedule.dueDate) : now;
                const createdAt = notes.reduce(
                    (earliest, candidate) => Math.min(earliest, candidate.createdAt),
                    now,
                );
                const due = Math.max(0, Math.round((dueDate - createdAt) / 86_400_000));
                const logged = Object.values(reviewLog.entries)
                    .filter((entry) => !entry.deletedAt && entry.cardId === card.id)
                    .sort((left, right) => left.reviewedAt - right.reviewedAt);
                return {
                    id: imported?.id ?? numericId(),
                    noteId: Number(note.externalIds?.ankiNoteId) || 0,
                    deckId: deckIdMap.get(card.deckPath) ?? [...deckIdMap.values()][0],
                    ordinal: card.ordinal,
                    type: card.queue === "new" ? 0 : 2,
                    queue:
                        card.state === "suspended"
                            ? -1
                            : card.state === "buried"
                              ? -2
                              : card.queue === "new"
                                ? 0
                                : 2,
                    due,
                    interval: schedule?.interval ?? 0,
                    factor: Math.round((schedule?.ease ?? 250) * 10),
                    reps: card.reps,
                    lapses: card.lapses,
                    left: imported?.left ?? 0,
                    originalDue: imported?.originalDue ?? 0,
                    originalDeckId: imported?.originalDeckId ?? 0,
                    flags: card.flag,
                    data: imported?.data ?? "",
                    reviews: logged.map((entry) => {
                        const original = imported?.reviews.find(
                            (review) => review.id === entry.reviewedAt,
                        );
                        return {
                            id: entry.reviewedAt || numericId(),
                            cardId: imported?.id ?? 0,
                            ease: entry.rating,
                            interval: original?.interval ?? schedule?.interval ?? 0,
                            previousInterval: original?.previousInterval ?? 0,
                            factor: original?.factor ?? Math.round((schedule?.ease ?? 250) * 10),
                            durationMs: entry.durationMs ?? original?.durationMs ?? 0,
                            type: original?.type ?? 1,
                        };
                    }),
                };
            });
            const noteId = Number(note.externalIds?.ankiNoteId) || numericId();
            for (const card of cards) {
                card.noteId = noteId;
                for (const review of card.reviews) review.cardId = card.id;
            }
            return {
                id: noteId,
                guid: note.externalIds?.ankiGuid ?? note.id,
                modelId: importedModel?.id ?? modelIdMap.get(note.noteTypeId),
                modifiedAt: note.updatedAt,
                tags: note.tags,
                fields:
                    importedModel?.imageOcclusion && originalFields
                        ? originalFields
                        : type.fields
                              .sort((left, right) => left.ordinal - right.ordinal)
                              .map((field) => toAnkiMedia(note.fields[field.id] ?? "")),
                flags: Number(raw?.flags) || 0,
                data: typeof raw?.data === "string" ? raw.data : "",
                cards,
            };
        });
        return await writeAnkiPackage({
            format: "apkg",
            collectionCreatedAt: notes.reduce(
                (earliest, candidate) => Math.min(earliest, candidate.createdAt),
                now,
            ),
            models,
            decks,
            deckConfigs,
            config: {
                nextPos: exportedNotes.length + 1,
                activeDecks: decks.map((deck) => deck.id),
            },
            notes: exportedNotes,
            media,
            warnings: [],
        });
    }
}
