import { KnowledgeArea } from "src/data/plugin-data";
import { KnowledgeDependencyEdge } from "src/scheduling/review-session-planner";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";

export type KnowledgeGraphNodeKind = "root" | "area" | "deck" | "concept" | "note";

export interface KnowledgeGraphMetrics {
    cards: number;
    due: number;
    newCards: number;
    lapses: number;
    retention: number | null;
}

export interface KnowledgeGraphNode {
    id: string;
    kind: KnowledgeGraphNodeKind;
    label: string;
    subtitle: string;
    parentId: string | null;
    areaId?: string;
    deckPath?: string;
    notePath?: string;
    notePaths?: string[];
    concept?: string;
    metrics: KnowledgeGraphMetrics;
    x: number;
    y: number;
}

export interface KnowledgeGraphEdge {
    id: string;
    from: string;
    to: string;
    kind: "contains" | "link" | "prerequisite";
    reason?: string;
    prerequisitePath?: string;
    dependentPath?: string;
}

export interface KnowledgeGraphData {
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
}

export interface KnowledgeGraphBuildOptions {
    noteLinks?: Record<string, string[]>;
    dependencies?: KnowledgeDependencyEdge[];
    concepts?: Record<string, string>;
    conceptKeys?: Record<string, string>;
    positions?: Record<string, { x: number; y: number }>;
}

export const KNOWLEDGE_GRAPH_ROOT_ID = "root:knowledge";

function metrics(records: CardBrowserRecord[]): KnowledgeGraphMetrics {
    const retentions = records
        .map((record) => record.retention)
        .filter((value): value is number => value !== null && value !== undefined);
    return {
        cards: records.length,
        due: records.filter((record) => record.state === "due").length,
        newCards: records.filter((record) => record.state === "new").length,
        lapses: records.reduce((sum, record) => sum + (record.lapses ?? 0), 0),
        retention: retentions.length
            ? retentions.reduce((sum, value) => sum + value, 0) / retentions.length
            : null,
    };
}

function withPosition(
    node: Omit<KnowledgeGraphNode, "x" | "y">,
    fallback: { x: number; y: number },
    positions: Record<string, { x: number; y: number }>,
): KnowledgeGraphNode {
    return { ...node, ...(positions[node.id] ?? fallback) };
}

function graphKey(value: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0).toString(36);
}

export function buildKnowledgeGraph(
    areas: KnowledgeArea[],
    records: CardBrowserRecord[],
    managedDecks: string[],
    options: KnowledgeGraphBuildOptions = {},
): KnowledgeGraphData {
    const positions = options.positions ?? {};
    const activeAreas = areas.filter((area) => !area.archivedAt);
    const decks = [...new Set([...managedDecks, ...records.flatMap((record) => record.deckNames)])]
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
    const nodes: KnowledgeGraphNode[] = [
        withPosition(
            {
                id: KNOWLEDGE_GRAPH_ROOT_ID,
                kind: "root",
                label: "Knowledge",
                subtitle: `${activeAreas.length} areas · ${decks.length} decks`,
                parentId: null,
                metrics: metrics(records),
            },
            { x: 40, y: 80 },
            positions,
        ),
    ];
    const edges: KnowledgeGraphEdge[] = [];
    const areaNodeIds = new Map<string, string>();
    activeAreas.forEach((area, index) => {
        const id = `area:${area.id}`;
        areaNodeIds.set(area.id, id);
        const areaRecords = records.filter((record) =>
            record.deckNames.some((deck) => area.deckPaths.includes(deck)),
        );
        nodes.push(
            withPosition(
                {
                    id,
                    kind: "area",
                    label: `${area.icon ? `${area.icon} ` : ""}${area.name}`,
                    subtitle: `${area.deckPaths.length} decks`,
                    parentId: area.parentId ? `area:${area.parentId}` : KNOWLEDGE_GRAPH_ROOT_ID,
                    areaId: area.id,
                    metrics: metrics(areaRecords),
                },
                { x: 350, y: 40 + index * 150 },
                positions,
            ),
        );
    });
    for (const area of activeAreas) {
        const to = areaNodeIds.get(area.id);
        const from = area.parentId ? areaNodeIds.get(area.parentId) : KNOWLEDGE_GRAPH_ROOT_ID;
        if (from && to) edges.push({ id: `contains:${from}:${to}`, from, to, kind: "contains" });
    }

    const deckNodeIds = new Map<string, string>();
    decks.forEach((deck, index) => {
        const id = `deck:${deck}`;
        deckNodeIds.set(deck, id);
        const owner = activeAreas.find((area) => area.deckPaths.includes(deck));
        const deckRecords = records.filter((record) => record.deckNames.includes(deck));
        const parentId = owner ? `area:${owner.id}` : KNOWLEDGE_GRAPH_ROOT_ID;
        nodes.push(
            withPosition(
                {
                    id,
                    kind: "deck",
                    label: deck.split("/").pop() ?? deck,
                    subtitle: deck,
                    parentId,
                    deckPath: deck,
                    areaId: owner?.id,
                    metrics: metrics(deckRecords),
                },
                { x: 690, y: 40 + index * 128 },
                positions,
            ),
        );
        edges.push({ id: `contains:${parentId}:${id}`, from: parentId, to: id, kind: "contains" });
    });

    const noteNodeIds = new Map<string, string>();
    const conceptNodeIdsByNote = new Map<string, string>();
    const notePaths = [...new Set(records.map((record) => record.notePath).filter(Boolean))].sort(
        (left, right) => left.localeCompare(right),
    );
    const conceptGroups = new Map<string, { label: string; notePaths: string[] }>();
    for (const notePath of notePaths) {
        const label = options.concepts?.[notePath]?.trim();
        if (!label) continue;
        const key =
            options.conceptKeys?.[notePath] ||
            label.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");
        const group = conceptGroups.get(key) ?? { label, notePaths: [] };
        group.notePaths.push(notePath);
        conceptGroups.set(key, group);
    }
    [...conceptGroups.entries()].forEach(([key, group], index) => {
        const id = `concept:${graphKey(key)}`;
        const conceptRecords = records.filter((record) =>
            group.notePaths.includes(record.notePath),
        );
        const deck = conceptRecords[0]?.deckNames[0] ?? "";
        const parentId = deckNodeIds.get(deck) ?? KNOWLEDGE_GRAPH_ROOT_ID;
        nodes.push(
            withPosition(
                {
                    id,
                    kind: "concept",
                    label: group.label,
                    subtitle: `${group.notePaths.length} ${group.notePaths.length === 1 ? "source" : "sources"}`,
                    parentId,
                    deckPath: deck,
                    concept: group.label,
                    notePaths: [...group.notePaths],
                    metrics: metrics(conceptRecords),
                },
                { x: 1030, y: 28 + index * 112 },
                positions,
            ),
        );
        edges.push({ id: `contains:${parentId}:${id}`, from: parentId, to: id, kind: "contains" });
        group.notePaths.forEach((path) => conceptNodeIdsByNote.set(path, id));
    });
    notePaths.forEach((notePath, index) => {
        const id = `note:${notePath}`;
        noteNodeIds.set(notePath, id);
        const noteRecords = records.filter((record) => record.notePath === notePath);
        const deck = noteRecords[0]?.deckNames[0] ?? "";
        const parentId =
            conceptNodeIdsByNote.get(notePath) ?? deckNodeIds.get(deck) ?? KNOWLEDGE_GRAPH_ROOT_ID;
        nodes.push(
            withPosition(
                {
                    id,
                    kind: "note",
                    label: notePath.split("/").pop()?.replace(/\.md$/i, "") ?? notePath,
                    subtitle: notePath,
                    parentId,
                    notePath,
                    deckPath: deck,
                    metrics: metrics(noteRecords),
                },
                { x: 1370, y: 28 + index * 106 },
                positions,
            ),
        );
        edges.push({ id: `contains:${parentId}:${id}`, from: parentId, to: id, kind: "contains" });
    });

    for (const [sourcePath, destinations] of Object.entries(options.noteLinks ?? {})) {
        const from = noteNodeIds.get(sourcePath);
        if (!from) continue;
        for (const destination of destinations) {
            const to = noteNodeIds.get(destination);
            if (to && to !== from) edges.push({ id: `link:${from}:${to}`, from, to, kind: "link" });
        }
    }
    for (const dependency of options.dependencies ?? []) {
        const from =
            conceptNodeIdsByNote.get(dependency.prerequisitePath) ??
            noteNodeIds.get(dependency.prerequisitePath);
        const to =
            conceptNodeIdsByNote.get(dependency.dependentPath) ??
            noteNodeIds.get(dependency.dependentPath);
        if (!from || !to || from === to) continue;
        const id = `prerequisite:${from}:${to}`;
        if (edges.some((edge) => edge.id === id)) continue;
        edges.push({
            id,
            from,
            to,
            kind: "prerequisite",
            reason: dependency.reason,
            prerequisitePath: dependency.prerequisitePath,
            dependentPath: dependency.dependentPath,
        });
    }
    return { nodes, edges };
}

export function visibleKnowledgeGraph(
    graph: KnowledgeGraphData,
    collapsedIds: Iterable<string>,
    showSources: boolean,
    focusId: string | null = null,
): KnowledgeGraphData {
    const collapsed = new Set(collapsedIds);
    const children = new Map<string, string[]>();
    for (const node of graph.nodes) {
        if (!node.parentId) continue;
        children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
    }
    const hidden = new Set<string>();
    const hideDescendants = (id: string): void => {
        for (const child of children.get(id) ?? []) {
            hidden.add(child);
            hideDescendants(child);
        }
    };
    collapsed.forEach(hideDescendants);
    if (!showSources)
        graph.nodes.filter((node) => node.kind === "note").forEach((node) => hidden.add(node.id));

    if (focusId) {
        const keep = new Set<string>([focusId]);
        let parent = graph.nodes.find((node) => node.id === focusId)?.parentId;
        while (parent) {
            keep.add(parent);
            parent = graph.nodes.find((node) => node.id === parent)?.parentId;
        }
        const addChildren = (id: string): void => {
            for (const child of children.get(id) ?? []) {
                keep.add(child);
                addChildren(child);
            }
        };
        addChildren(focusId);
        graph.nodes.filter((node) => !keep.has(node.id)).forEach((node) => hidden.add(node.id));
    }
    const nodes = graph.nodes.filter((node) => !hidden.has(node.id));
    const ids = new Set(nodes.map((node) => node.id));
    return {
        nodes,
        edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    };
}

export function shortestKnowledgePath(
    graph: KnowledgeGraphData,
    start: string,
    end: string,
): string[] {
    if (start === end) return [start];
    const adjacency = new Map<string, string[]>();
    for (const edge of graph.edges) {
        adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
        adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from]);
    }
    const previous = new Map<string, string | null>([[start, null]]);
    const queue = [start];
    while (queue.length) {
        const current = queue.shift();
        if (!current) break;
        for (const next of adjacency.get(current) ?? []) {
            if (previous.has(next)) continue;
            previous.set(next, current);
            if (next === end) {
                const path = [end];
                let cursor: string | null = current;
                while (cursor) {
                    path.unshift(cursor);
                    cursor = previous.get(cursor) ?? null;
                }
                return path;
            }
            queue.push(next);
        }
    }
    return [];
}

export function graphMatches(node: KnowledgeGraphNode, query: string, mode: string): boolean {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized && !`${node.label} ${node.subtitle}`.toLocaleLowerCase().includes(normalized))
        return false;
    if (mode === "due" && node.metrics.due === 0) return false;
    if (mode === "weak" && node.metrics.lapses < 2 && (node.metrics.retention ?? 1) >= 0.85)
        return false;
    if (mode === "unassigned" && (node.kind !== "deck" || node.areaId)) return false;
    return true;
}
