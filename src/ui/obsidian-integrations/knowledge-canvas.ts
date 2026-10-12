import { normalizePath, Notice, TAbstractFile, TFile } from "obsidian";

import { KnowledgeArea } from "src/data/plugin-data";
import type SRPlugin from "src/main";
import {
    CardBrowserRecord,
    filterCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";

interface CanvasNodeBase {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
}

interface CanvasTextNode extends CanvasNodeBase {
    type: "text";
    text: string;
}

interface CanvasFileNode extends CanvasNodeBase {
    type: "file";
    file: string;
}

type CanvasNode = CanvasTextNode | CanvasFileNode;

interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    fromSide?: "top" | "right" | "bottom" | "left";
    toSide?: "top" | "right" | "bottom" | "left";
    label?: string;
    color?: string;
}

export interface KnowledgeCanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

export interface KnowledgeCanvasBuildOptions {
    noteLinks?: Record<string, string[]>;
    sourceLimitPerDeck?: number;
}

interface GenerateKnowledgeCanvasOptions {
    open?: boolean;
    notify?: boolean;
}

const GENERATED_ID_PREFIX = "sr-";

function isGeneratedId(id: string): boolean {
    return (
        id.startsWith(GENERATED_ID_PREFIX) ||
        /^(?:root|filter|area|deck|file|more|edge|link)-[0-9a-f]{8}$/.test(id)
    );
}

function stableId(prefix: string, value: string): string {
    let hash = 2166136261;
    for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return `${GENERATED_ID_PREFIX}${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function studyLink(action: "open-browser" | "review", params: Record<string, string> = {}): string {
    const query = new URLSearchParams({ action, ...params });
    return `obsidian://msre?${query.toString()}`;
}

function areaDepth(area: KnowledgeArea, byId: Map<string, KnowledgeArea>): number {
    let depth = 0;
    let parent = area.parentId ? byId.get(area.parentId) : undefined;
    const seen = new Set<string>([area.id]);
    while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        depth++;
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    return depth;
}

function deckCards(deck: string, records: CardBrowserRecord[]): CardBrowserRecord[] {
    return records.filter((record) => record.deckNames.includes(deck));
}

function metricText(cards: CardBrowserRecord[]): string {
    const due = cards.filter((card) => card.state === "due").length;
    const newCards = cards.filter((card) => card.state === "new").length;
    const lapses = cards.reduce((sum, card) => sum + (card.lapses ?? 0), 0);
    return `${cards.length} cards · ${due} due · ${newCards} new · ${lapses} lapses`;
}

function smartFilters(records: CardBrowserRecord[]) {
    return [
        { name: "Today", query: "is:due OR is:new", color: "1" },
        { name: "Errors", query: "lapses:>0", color: "2" },
        {
            name: "Weak",
            query: "retention:<0.85 OR difficulty:>=7 OR lapses:>=2",
            color: "3",
        },
        { name: "Recently studied", query: "reviewed:7d", color: "5" },
        { name: "No knowledge area", query: "is:no-area", color: "4" },
    ].map((filter) => ({
        ...filter,
        cards: filterCardBrowserRecords(records, filter.query, "all"),
    }));
}

export function buildKnowledgeCanvas(
    areas: KnowledgeArea[],
    records: CardBrowserRecord[],
    managedDecks: string[],
    options: KnowledgeCanvasBuildOptions = {},
): KnowledgeCanvasData {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];
    const noteLinks = options.noteLinks ?? {};
    const sourceLimit = Math.max(0, options.sourceLimitPerDeck ?? 6);
    const activeAreas = areas.filter((area) => !area.archivedAt);
    const areaById = new Map(activeAreas.map((area) => [area.id, area]));
    const allDecks = [
        ...new Set([...managedDecks, ...records.flatMap((record) => record.deckNames)]),
    ].filter(Boolean);
    const rootId = stableId("root", "knowledge-map");
    nodes.push({
        id: rootId,
        type: "text",
        x: 0,
        y: 0,
        width: 320,
        height: 190,
        color: "6",
        text: `# Knowledge map\n\n${metricText(records)}\n${allDecks.length} decks · ${activeAreas.length} areas\n\n[Open card browser](${studyLink("open-browser")})`,
    });

    smartFilters(records).forEach((filter, index) => {
        const nodeId = stableId("filter", filter.name);
        nodes.push({
            id: nodeId,
            type: "text",
            x: 0,
            y: 230 + index * 150,
            width: 320,
            height: 120,
            color: filter.color,
            text: `## ${filter.name}\n\n${filter.cards.length} cards\n\n[Browse](${studyLink("open-browser", { query: filter.query })}) · [Review](${studyLink("review", { query: filter.query })})`,
        });
        edges.push({
            id: stableId("edge", `${rootId}:${nodeId}`),
            fromNode: rootId,
            toNode: nodeId,
            fromSide: "bottom",
            toSide: "top",
        });
    });

    const sortedAreas = [...activeAreas].sort((left, right) => {
        const depthDifference = areaDepth(left, areaById) - areaDepth(right, areaById);
        return depthDifference || left.name.localeCompare(right.name);
    });
    const areaNodeById = new Map<string, string>();
    sortedAreas.forEach((area, index) => {
        const depth = areaDepth(area, areaById);
        const decks = allDecks.filter((deck) => area.deckPaths.includes(deck));
        const cards = records.filter((record) =>
            record.deckNames.some((deck) => area.deckPaths.includes(deck)),
        );
        const nodeId = stableId("area", area.id);
        areaNodeById.set(area.id, nodeId);
        nodes.push({
            id: nodeId,
            type: "text",
            x: 410 + depth * 330,
            y: index * 240,
            width: 290,
            height: 150,
            color: area.kind === "project" ? "2" : "5",
            text: `## ${area.icon ? `${area.icon} ` : ""}${area.name}\n\n${decks.length} decks · ${metricText(cards)}\n\n[Browse](${studyLink("open-browser", { query: `area:${area.name}` })}) · [Review](${studyLink("review", { query: `area:${area.name}` })})`,
        });
        const parentNode = area.parentId ? areaNodeById.get(area.parentId) : rootId;
        edges.push({
            id: stableId("edge", `${parentNode ?? rootId}:${nodeId}`),
            fromNode: parentNode ?? rootId,
            toNode: nodeId,
            fromSide: "right",
            toSide: "left",
        });
    });

    const claimedDecks = new Set(sortedAreas.flatMap((area) => area.deckPaths));
    const otherDecks = allDecks.filter((deck) => !claimedDecks.has(deck));
    let otherAreaId: string | null = null;
    if (otherDecks.length) {
        otherAreaId = stableId("area", "other-decks");
        nodes.push({
            id: otherAreaId,
            type: "text",
            x: 410,
            y: sortedAreas.length * 240,
            width: 290,
            height: 130,
            text: `## Other decks\n\n${otherDecks.length} unassigned decks\n\n[Browse unassigned](${studyLink("open-browser", { query: "is:no-area" })})`,
        });
        edges.push({
            id: stableId("edge", `${rootId}:${otherAreaId}`),
            fromNode: rootId,
            toNode: otherAreaId,
            fromSide: "right",
            toSide: "left",
        });
    }

    let deckIndex = 0;
    let fileIndex = 0;
    const fileNodeByPath = new Map<string, string>();
    for (const deck of allDecks.sort((a, b) => a.localeCompare(b))) {
        const owner = sortedAreas.find((area) => area.deckPaths.includes(deck));
        const parentId = owner ? areaNodeById.get(owner.id) : otherAreaId;
        if (!parentId) continue;
        const cards = deckCards(deck, records);
        const deckNodeId = stableId("deck", deck);
        const x = 790 + (owner ? areaDepth(owner, areaById) * 330 : 0);
        const y = deckIndex++ * 190;
        nodes.push({
            id: deckNodeId,
            type: "text",
            x,
            y,
            width: 300,
            height: 150,
            color: "4",
            text: `### ${deck.split("/").pop() ?? deck}\n\n${metricText(cards)}\n\n[Browse](${studyLink("open-browser", { deck })}) · [Review](${studyLink("review", { deck })})`,
        });
        edges.push({
            id: stableId("edge", `${parentId}:${deckNodeId}`),
            fromNode: parentId,
            toNode: deckNodeId,
            fromSide: "right",
            toSide: "left",
            label: "deck",
        });

        const allNotePaths = [...new Set(cards.map((record) => record.notePath).filter(Boolean))];
        const notePaths = allNotePaths.slice(0, sourceLimit);
        for (const notePath of notePaths) {
            let fileNodeId = fileNodeByPath.get(notePath);
            if (!fileNodeId) {
                fileNodeId = stableId("file", notePath);
                fileNodeByPath.set(notePath, fileNodeId);
                nodes.push({
                    id: fileNodeId,
                    type: "file",
                    file: notePath,
                    x: x + 390,
                    y: fileIndex++ * 170,
                    width: 310,
                    height: 135,
                });
            }
            edges.push({
                id: stableId("edge", `${deckNodeId}:${fileNodeId}`),
                fromNode: deckNodeId,
                toNode: fileNodeId,
                fromSide: "right",
                toSide: "left",
            });
        }
        if (allNotePaths.length > notePaths.length) {
            const moreNodeId = stableId("more", deck);
            nodes.push({
                id: moreNodeId,
                type: "text",
                x: x + 390,
                y: fileIndex++ * 170,
                width: 310,
                height: 95,
                text: `**+${allNotePaths.length - notePaths.length} more notes**\n\n[Open this branch](${studyLink("open-browser", { deck })})`,
            });
            edges.push({
                id: stableId("edge", `${deckNodeId}:${moreNodeId}`),
                fromNode: deckNodeId,
                toNode: moreNodeId,
                fromSide: "right",
                toSide: "left",
            });
        }
    }

    for (const [sourcePath, destinations] of Object.entries(noteLinks)) {
        const sourceNode = fileNodeByPath.get(sourcePath);
        if (!sourceNode) continue;
        for (const destination of destinations) {
            const destinationNode = fileNodeByPath.get(destination);
            if (!destinationNode || destinationNode === sourceNode) continue;
            edges.push({
                id: stableId("link", `${sourcePath}:${destination}`),
                fromNode: sourceNode,
                toNode: destinationNode,
                label: "link",
                color: "6",
            });
        }
    }
    return { nodes, edges };
}

/** Keeps user nodes, user edges and manually adjusted geometry across regeneration. */
export function mergeKnowledgeCanvas(
    current: KnowledgeCanvasData | null,
    generated: KnowledgeCanvasData,
): KnowledgeCanvasData {
    if (!current) return generated;
    const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
    const generatedNodes = generated.nodes.map((node) => {
        const previous = currentNodes.get(node.id) ?? currentNodes.get(node.id.replace(/^sr-/, ""));
        if (!previous) return node;
        return {
            ...node,
            x: previous.x,
            y: previous.y,
            width: previous.width,
            height: previous.height,
        };
    });
    const customNodes = current.nodes.filter((node) => !isGeneratedId(node.id));
    const nodeIds = new Set([...generatedNodes, ...customNodes].map((node) => node.id));
    const customEdges = current.edges.filter(
        (edge) => !isGeneratedId(edge.id) && nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode),
    );
    return {
        nodes: [...generatedNodes, ...customNodes],
        edges: [...generated.edges, ...customEdges],
    };
}

async function ensureFolder(plugin: SRPlugin, path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!plugin.app.vault.getAbstractFileByPath(current)) {
            await plugin.app.vault.createFolder(current);
        }
    }
}

function canvasPath(plugin: SRPlugin): string {
    return normalizePath(
        `${plugin.dataManager.data.settings.scheduleDataVaultLocation}/Knowledge Map.canvas`,
    );
}

function resolvedNoteLinks(plugin: SRPlugin): Record<string, string[]> {
    return Object.fromEntries(
        Object.entries(plugin.app.metadataCache.resolvedLinks).map(([source, destinations]) => [
            source,
            Object.keys(destinations),
        ]),
    );
}

function parseCanvas(content: string): KnowledgeCanvasData | null {
    try {
        const value = JSON.parse(content) as Partial<KnowledgeCanvasData>;
        if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
        return value as KnowledgeCanvasData;
    } catch {
        return null;
    }
}

export async function generateKnowledgeCanvas(
    plugin: SRPlugin,
    options: GenerateKnowledgeCanvasOptions = {},
): Promise<TFile> {
    const folder = normalizePath(plugin.dataManager.data.settings.scheduleDataVaultLocation);
    await ensureFolder(plugin, folder);
    const path = canvasPath(plugin);
    const records = createStudyRecords(plugin);
    const generated = buildKnowledgeCanvas(
        plugin.dataManager.data.knowledgeAreas,
        records,
        plugin.dataManager.data.managedDecks,
        { noteLinks: resolvedNoteLinks(plugin) },
    );
    const existing = plugin.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
        const current = parseCanvas(await plugin.app.vault.read(existing));
        const content = `${JSON.stringify(mergeKnowledgeCanvas(current, generated), null, 2)}\n`;
        await plugin.app.vault.process(existing, () => content);
        file = existing;
    } else {
        file = await plugin.app.vault.create(path, `${JSON.stringify(generated, null, 2)}\n`);
    }
    if (options.open !== false) await plugin.app.workspace.getLeaf("tab").openFile(file);
    if (options.notify !== false) new Notice("Knowledge map updated");
    return file;
}

export class KnowledgeCanvasAutoUpdater {
    private timer: number | null = null;
    private running = false;

    constructor(private readonly plugin: SRPlugin) {}

    start(): void {
        const changed = (file: TAbstractFile): void => {
            if (file.path === canvasPath(this.plugin) || !(file instanceof TFile)) return;
            if (file.extension === "md" || file.extension === "base") this.schedule();
        };
        this.plugin.registerEvent(this.plugin.app.vault.on("create", changed));
        this.plugin.registerEvent(this.plugin.app.vault.on("modify", changed));
        this.plugin.registerEvent(this.plugin.app.vault.on("delete", changed));
        this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file) => changed(file)));
        this.plugin.register(() => this.stop());
    }

    schedule(): void {
        if (
            !(this.plugin.app.vault.getAbstractFileByPath(canvasPath(this.plugin)) instanceof TFile)
        )
            return;
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout((): void => {
            void this.refresh();
        }, 900);
    }

    stop(): void {
        if (this.timer !== null) window.clearTimeout(this.timer);
        this.timer = null;
    }

    private async refresh(): Promise<void> {
        this.timer = null;
        if (this.running || !this.plugin.isInitialized) return;
        this.running = true;
        try {
            await generateKnowledgeCanvas(this.plugin, { open: false, notify: false });
        } finally {
            this.running = false;
        }
    }
}
