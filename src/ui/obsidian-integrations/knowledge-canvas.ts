import { normalizePath, Notice, TFile } from "obsidian";

import { KnowledgeArea } from "src/data/plugin-data";
import type SRPlugin from "src/main";
import {
    type CardBrowserRecord,
    createCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";

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
}

export interface KnowledgeCanvasData {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}

function stableId(prefix: string, value: string): string {
    let hash = 2166136261;
    for (const character of value) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function browserLink(deck?: string): string {
    const suffix = deck ? `&deck=${encodeURIComponent(deck)}` : "";
    return `obsidian://msre?action=open-browser${suffix}`;
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

function deckCounts(deck: string, records: CardBrowserRecord[]): string {
    const cards = records.filter((record) => record.deckNames.includes(deck));
    const due = cards.filter((card) => card.state === "due").length;
    const newCards = cards.filter((card) => card.state === "new").length;
    return `${cards.length} cards · ${due} due · ${newCards} new`;
}

export function buildKnowledgeCanvas(
    areas: KnowledgeArea[],
    records: CardBrowserRecord[],
    managedDecks: string[],
): KnowledgeCanvasData {
    const nodes: CanvasNode[] = [];
    const edges: CanvasEdge[] = [];
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
        width: 300,
        height: 180,
        color: "6",
        text: `# Knowledge map\n\n${records.length} cards · ${allDecks.length} decks · ${activeAreas.length} areas\n\n[Open card browser](${browserLink()})`,
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
            x: 380 + depth * 320,
            y: index * 240,
            width: 280,
            height: 150,
            color: area.kind === "project" ? "2" : "5",
            text: `## ${area.icon ? `${area.icon} ` : ""}${area.name}\n\n${decks.length} decks · ${cards.length} cards · ${cards.filter((card) => card.state === "due").length} due`,
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
            x: 380,
            y: sortedAreas.length * 240,
            width: 280,
            height: 120,
            text: `## Other decks\n\n${otherDecks.length} unassigned decks`,
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
    for (const deck of allDecks.sort((a, b) => a.localeCompare(b))) {
        const owner = sortedAreas.find((area) => area.deckPaths.includes(deck));
        const parentId = owner ? areaNodeById.get(owner.id) : otherAreaId;
        if (!parentId) continue;
        const deckNodeId = stableId("deck", deck);
        const x = 760 + (owner ? areaDepth(owner, areaById) * 320 : 0);
        const y = deckIndex++ * 190;
        nodes.push({
            id: deckNodeId,
            type: "text",
            x,
            y,
            width: 290,
            height: 130,
            color: "4",
            text: `### ${deck.split("/").pop() ?? deck}\n\n${deckCounts(deck, records)}\n\n[Browse this deck](${browserLink(deck)})`,
        });
        edges.push({
            id: stableId("edge", `${parentId}:${deckNodeId}`),
            fromNode: parentId,
            toNode: deckNodeId,
            fromSide: "right",
            toSide: "left",
            label: "deck",
        });

        const notePaths = [
            ...new Set(
                records
                    .filter((record) => record.deckNames.includes(deck) && record.notePath)
                    .map((record) => record.notePath),
            ),
        ].slice(0, 3);
        for (const notePath of notePaths) {
            const fileNodeId = stableId("file", `${deck}:${notePath}`);
            nodes.push({
                id: fileNodeId,
                type: "file",
                file: notePath,
                x: x + 370,
                y: fileIndex++ * 170,
                width: 300,
                height: 130,
            });
            edges.push({
                id: stableId("edge", `${deckNodeId}:${fileNodeId}`),
                fromNode: deckNodeId,
                toNode: fileNodeId,
                fromSide: "right",
                toSide: "left",
            });
        }
    }
    return { nodes, edges };
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

export async function generateKnowledgeCanvas(plugin: SRPlugin): Promise<TFile> {
    const folder = normalizePath(plugin.dataManager.data.settings.scheduleDataVaultLocation);
    await ensureFolder(plugin, folder);
    const path = normalizePath(`${folder}/Knowledge Map.canvas`);
    const records = plugin.dataManager.isOsrCoreLoaded()
        ? createCardBrowserRecords(plugin.dataManager.osrCore.getAllCards())
        : [];
    const canvas = buildKnowledgeCanvas(
        plugin.dataManager.data.knowledgeAreas,
        records,
        plugin.dataManager.data.managedDecks,
    );
    const content = `${JSON.stringify(canvas, null, 2)}\n`;
    const existing = plugin.app.vault.getAbstractFileByPath(path);
    let file: TFile;
    if (existing instanceof TFile) {
        await plugin.app.vault.process(existing, () => content);
        file = existing;
    } else {
        file = await plugin.app.vault.create(path, content);
    }
    await plugin.app.workspace.getLeaf("tab").openFile(file);
    new Notice("Knowledge map updated");
    return file;
}
