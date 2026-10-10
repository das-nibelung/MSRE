import { App, normalizePath, TFile } from "obsidian";

import { Deck } from "src/data/data-structures/deck/deck";
import { SRSettings } from "src/data/settings";
import SRPlugin from "src/main";

export type NativeCardType = "basic" | "reversed" | "cloze";

export interface NativeCardDraft {
    deckPath: string;
    type: NativeCardType;
    front: string;
    back: string;
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

export function serializeNativeCard(draft: NativeCardDraft, settings: SRSettings): string {
    const rootTag = (settings.flashcardTags[0] ?? FALLBACK_ROOT_TAG).replace(/\/+$/g, "");
    const deckPath = normalizeManagedDeckPath(draft.deckPath);
    const tag = deckPath ? `${rootTag}/${deckPath}` : rootTag;
    return `${tag}\n\n${serializeNativeQuestion(draft, settings)}\n`;
}

/** Converts native form values into the parser format without exposing it in the UI. */
export function serializeNativeQuestion(draft: NativeCardDraft, settings: SRSettings): string {
    const front = draft.front.trim();
    const back = draft.back.trim();

    if (draft.type === "cloze") {
        const wrapper = getClozeWrapper(settings);
        if (wrapper === null) throw new Error("cloze-pattern-unavailable");
        const matchIndex = front.indexOf(back);
        if (matchIndex < 0) throw new Error("cloze-answer-not-found");
        const text = `${front.slice(0, matchIndex)}${wrapper[0]}${back}${wrapper[1]}${front.slice(
            matchIndex + back.length,
        )}`;
        return text;
    }

    const separator =
        draft.type === "reversed"
            ? settings.multilineReversedCardSeparator
            : settings.multilineCardSeparator;
    const endMarker = settings.multilineCardEndMarker ? `\n${settings.multilineCardEndMarker}` : "";
    return `${front}\n${separator}\n${back}${endMarker}`;
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
        return deckPath;
    }

    async createCard(draft: NativeCardDraft): Promise<TFile> {
        const normalizedDeck = normalizeManagedDeckPath(draft.deckPath);
        if (normalizedDeck) await this.createDeck(normalizedDeck);

        const settings = this.plugin.dataManager.data.settings;
        const contents = serializeNativeCard({ ...draft, deckPath: normalizedDeck }, settings);
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

        const file = await this.plugin.app.vault.create(path, contents);
        await this.waitForMetadata(this.plugin.app, file);
        await this.plugin.dataManager.sync();
        this.plugin.uiManager.tabViewManager.refreshCardBrowser();
        return file;
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
