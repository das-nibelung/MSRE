import { ButtonComponent, ItemView, Menu, Notice, setIcon, WorkspaceLeaf } from "obsidian";

import { KNOWLEDGE_GRAPH_VIEW_TYPE } from "src/data/constants";
import { NativeCardStore } from "src/data/native-card-store";
import type SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import {
    buildKnowledgeGraph,
    graphMatches,
    KnowledgeGraphData,
    KnowledgeGraphEdge,
    KnowledgeGraphNode,
    shortestKnowledgePath,
    visibleKnowledgeGraph,
} from "src/ui/knowledge-graph/knowledge-graph-model";
import { openCanvasAreaPicker } from "src/ui/obsidian-integrations/knowledge-area-picker";
import { generateKnowledgeCanvas } from "src/ui/obsidian-integrations/knowledge-canvas";
import { collectKnowledgeDependencies } from "src/ui/obsidian-integrations/knowledge-dependencies";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";

const activeKnowledgeGraphViews = new Set<KnowledgeGraphView>();
const NODE_WIDTH = 244;
const NODE_HEIGHT = 94;

export function refreshKnowledgeGraphViews(): void {
    activeKnowledgeGraphViews.forEach((view) => view.refresh());
}

function resolvedLinks(plugin: SRPlugin): Record<string, string[]> {
    return Object.fromEntries(
        Object.entries(plugin.app.metadataCache.resolvedLinks).map(([path, links]) => [
            path,
            Object.keys(links),
        ]),
    );
}

export class KnowledgeGraphView extends ItemView {
    private graph: KnowledgeGraphData = { nodes: [], edges: [] };
    private query = "";
    private mode = "all";
    private focusId: string | null = null;
    private selectedId: string | null = null;
    private pathStartId: string | null = null;
    private pathIds = new Set<string>();
    private collapsedIds = new Set<string>();
    private zoom = 1;
    private panX = 24;
    private panY = 24;
    private showSources = true;
    private viewportEl: HTMLElement | null = null;
    private stageEl: HTMLElement | null = null;
    private persistTimer: number | null = null;
    private draggedDeck = "";

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
        const state = plugin.dataManager.data.knowledgeGraphView;
        this.collapsedIds = new Set(state.collapsedIds);
        this.zoom = state.zoom;
        this.panX = state.panX;
        this.panY = state.panY;
        this.showSources = state.showSources;
    }

    getViewType(): string {
        return KNOWLEDGE_GRAPH_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Knowledge Graph";
    }

    getIcon(): string {
        return "waypoints";
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass("sr-knowledge-graph-view");
        activeKnowledgeGraphViews.add(this);
        this.registerEvent(this.app.metadataCache.on("resolved", () => this.refresh()));
        this.render();
        return Promise.resolve();
    }

    async onClose(): Promise<void> {
        activeKnowledgeGraphViews.delete(this);
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
        await this.persistState();
    }

    refresh(): void {
        if (this.contentEl.isShown()) this.render();
    }

    focusNode(id: string): void {
        this.focusId = id;
        this.selectedId = id;
        this.render();
        window.setTimeout(() => this.centerNode(id), 0);
    }

    private createGraph(): KnowledgeGraphData {
        const state = this.plugin.dataManager.data.knowledgeGraphView;
        const records = createStudyRecords(this.plugin);
        const dependencies = collectKnowledgeDependencies(
            this.plugin.app,
            records.map((record) => record.notePath).filter(Boolean),
        );
        return buildKnowledgeGraph(
            this.plugin.dataManager.data.knowledgeAreas,
            records,
            this.plugin.dataManager.data.managedDecks,
            {
                noteLinks: resolvedLinks(this.plugin),
                dependencies,
                positions: state.positions,
            },
        );
    }

    private render(): void {
        this.contentEl.empty();
        this.graph = this.createGraph();
        this.renderHeader();
        const shell = this.contentEl.createDiv("sr-graph-shell");
        const viewport = shell.createDiv("sr-graph-viewport");
        this.viewportEl = viewport;
        const stage = viewport.createDiv("sr-graph-stage");
        this.stageEl = stage;
        this.applyTransform();
        this.attachPanZoom(viewport);

        const visible = visibleKnowledgeGraph(
            this.graph,
            this.collapsedIds,
            this.showSources,
            this.focusId,
        );
        this.renderEdges(stage, visible);
        const childCounts = new Map<string, number>();
        this.graph.nodes.forEach((node) => {
            if (node.parentId && (this.showSources || node.kind !== "note")) {
                childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
            }
        });
        visible.nodes.forEach((node, index) =>
            this.renderNode(stage, node, childCounts.get(node.id) ?? 0, index),
        );
        this.renderInspector(shell, visible);
        this.renderMinimap(viewport, visible);
    }

    private renderHeader(): void {
        const header = this.contentEl.createDiv("sr-graph-header");
        const title = header.createDiv("sr-graph-title");
        title.createEl("h2", { text: "Knowledge Graph" });
        title.createSpan({ text: this.breadcrumbText() });

        const controls = header.createDiv("sr-graph-controls");
        const search = controls.createEl("input", {
            cls: "sr-graph-search",
            attr: { type: "search", placeholder: "Find area, deck, or note…" },
        });
        search.value = this.query;
        search.addEventListener("input", () => {
            this.query = search.value;
            this.updateSearchClasses();
        });
        search.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            const match = this.graph.nodes.find((node) =>
                graphMatches(node, this.query, this.mode),
            );
            if (match) this.focusNode(match.id);
        });
        const mode = controls.createEl("select", { cls: "dropdown sr-graph-filter" });
        for (const [value, label] of [
            ["all", "All knowledge"],
            ["due", "Due"],
            ["weak", "Weak"],
            ["unassigned", "Unassigned decks"],
        ])
            mode.createEl("option", { value, text: label });
        mode.value = this.mode;
        mode.addEventListener("change", () => {
            this.mode = mode.value;
            this.updateSearchClasses();
        });
        new ButtonComponent(controls)
            .setIcon(this.showSources ? "files" : "file-x")
            .setTooltip(this.showSources ? "Hide source notes" : "Show source notes")
            .onClick(() => {
                this.showSources = !this.showSources;
                this.schedulePersist();
                this.render();
            });
        new ButtonComponent(controls)
            .setIcon("route")
            .setTooltip("Build a path from the selected node")
            .onClick(() => this.beginPath());
        new ButtonComponent(controls)
            .setIcon("scan")
            .setTooltip("Fit graph")
            .onClick(() => this.fitGraph());
        new ButtonComponent(controls)
            .setIcon("layout-dashboard")
            .setTooltip("Open editable Obsidian Canvas")
            .onClick(() => void generateKnowledgeCanvas(this.plugin));
        new ButtonComponent(controls)
            .setIcon("plus")
            .setTooltip("New knowledge area")
            .setCta()
            .onClick(() => void this.plugin.uiManager.openNativeKnowledgeAreaCreator());
    }

    private renderEdges(stage: HTMLElement, graph: KnowledgeGraphData): void {
        const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.classList.add("sr-graph-edges");
        svg.setAttribute("width", "2200");
        svg.setAttribute("height", String(Math.max(1400, graph.nodes.length * 115)));
        const definitions = activeDocument.createElementNS("http://www.w3.org/2000/svg", "defs");
        const marker = activeDocument.createElementNS("http://www.w3.org/2000/svg", "marker");
        marker.setAttribute("id", "sr-graph-prerequisite-arrow");
        marker.setAttribute("viewBox", "0 0 10 10");
        marker.setAttribute("refX", "9");
        marker.setAttribute("refY", "5");
        marker.setAttribute("markerWidth", "7");
        marker.setAttribute("markerHeight", "7");
        marker.setAttribute("orient", "auto-start-reverse");
        const arrow = activeDocument.createElementNS("http://www.w3.org/2000/svg", "path");
        arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
        arrow.classList.add("sr-graph-prerequisite-arrow");
        marker.appendChild(arrow);
        definitions.appendChild(marker);
        svg.appendChild(definitions);
        const byId = new Map(graph.nodes.map((node) => [node.id, node]));
        for (const edge of graph.edges) {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) continue;
            const path = activeDocument.createElementNS("http://www.w3.org/2000/svg", "path");
            const startX = from.x + NODE_WIDTH;
            const startY = from.y + NODE_HEIGHT / 2;
            const endX = to.x;
            const endY = to.y + NODE_HEIGHT / 2;
            const bend = Math.max(34, Math.abs(endX - startX) * 0.45);
            path.setAttribute(
                "d",
                `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
            );
            path.classList.add("sr-graph-edge", `is-${edge.kind}`);
            if (edge.kind === "prerequisite") {
                path.setAttribute("marker-end", "url(#sr-graph-prerequisite-arrow)");
                const title = activeDocument.createElementNS("http://www.w3.org/2000/svg", "title");
                title.textContent = edge.reason || `${from.label} is required before ${to.label}`;
                path.appendChild(title);
            }
            if (this.edgeOnPath(edge)) path.classList.add("is-path");
            svg.appendChild(path);
        }
        stage.appendChild(svg);
    }

    private edgeOnPath(edge: KnowledgeGraphEdge): boolean {
        if (!this.pathIds.size) return false;
        const path = [...this.pathIds];
        return path.some(
            (id, index) =>
                index > 0 &&
                ((path[index - 1] === edge.from && id === edge.to) ||
                    (path[index - 1] === edge.to && id === edge.from)),
        );
    }

    private renderNode(
        stage: HTMLElement,
        node: KnowledgeGraphNode,
        childCount: number,
        index: number,
    ): void {
        const element = stage.createDiv(`sr-graph-node is-${node.kind}`);
        element.dataset.nodeId = node.id;
        element.setCssProps({
            left: `${node.x}px`,
            top: `${node.y}px`,
            "--sr-node-index": String(index),
        });
        if (node.id === this.selectedId) element.addClass("is-selected");
        if (this.pathIds.has(node.id)) element.addClass("is-path");
        if (!graphMatches(node, this.query, this.mode)) element.addClass("is-filtered");
        element.draggable = node.kind === "deck";
        element.addEventListener("dragstart", (event) => {
            if (!node.deckPath) return;
            this.draggedDeck = node.deckPath;
            event.dataTransfer?.setData("text/x-msre-deck", node.deckPath);
            element.addClass("is-dragging");
        });
        element.addEventListener("dragend", () => {
            this.draggedDeck = "";
            element.removeClass("is-dragging");
        });
        if (node.kind === "area") {
            element.addEventListener("dragover", (event) => {
                if (this.draggedDeck) {
                    event.preventDefault();
                    element.addClass("is-drop-target");
                }
            });
            element.addEventListener("dragleave", () => element.removeClass("is-drop-target"));
            element.addEventListener("drop", (event) => {
                event.preventDefault();
                element.removeClass("is-drop-target");
                const deck = event.dataTransfer?.getData("text/x-msre-deck") || this.draggedDeck;
                if (deck && node.areaId) void this.assignDeck(deck, node.areaId);
            });
        }

        const top = element.createDiv("sr-graph-node-top");
        const kind = top.createSpan("sr-graph-node-kind");
        setIcon(
            kind,
            node.kind === "area"
                ? "library-big"
                : node.kind === "deck"
                  ? "folder"
                  : node.kind === "note"
                    ? "file-text"
                    : "orbit",
        );
        const copy = top.createDiv("sr-graph-node-copy");
        copy.createEl("strong", { text: node.label });
        copy.createSpan({ text: node.subtitle });
        const menuButton = top.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Node actions" },
        });
        setIcon(menuButton, "ellipsis");
        menuButton.addEventListener("click", (event) => {
            event.stopPropagation();
            this.openNodeMenu(event, node);
        });
        const metrics = element.createDiv("sr-graph-node-metrics");
        metrics.createSpan({ text: `${node.metrics.cards} cards` });
        if (node.metrics.due)
            metrics.createSpan({ cls: "is-due", text: `${node.metrics.due} due` });
        if (node.metrics.newCards)
            metrics.createSpan({ cls: "is-new", text: `${node.metrics.newCards} new` });
        if (childCount > 0) {
            const toggle = element.createEl("button", { cls: "sr-graph-collapse" });
            setIcon(toggle, this.collapsedIds.has(node.id) ? "chevron-right" : "chevron-down");
            toggle.createSpan({ text: String(childCount) });
            toggle.addEventListener("click", (event) => {
                event.stopPropagation();
                this.toggleCollapsed(node.id);
            });
        }
        this.attachNodeMove(element, node);
        element.addEventListener("click", () => this.selectNode(node.id));
        element.addEventListener("dblclick", () => void this.openNode(node));
    }

    private renderInspector(shell: HTMLElement, graph: KnowledgeGraphData): void {
        const node = graph.nodes.find((candidate) => candidate.id === this.selectedId);
        if (!node) return;
        const inspector = shell.createDiv("sr-graph-inspector");
        const close = inspector.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Close inspector" },
        });
        setIcon(close, "x");
        close.addEventListener("click", () => {
            this.selectedId = null;
            this.render();
        });
        inspector.createSpan({ cls: "sr-graph-inspector-kind", text: node.kind });
        inspector.createEl("h3", { text: node.label });
        inspector.createEl("p", { text: node.subtitle });
        const stats = inspector.createDiv("sr-graph-inspector-stats");
        for (const [label, value] of [
            ["Cards", node.metrics.cards],
            ["Due", node.metrics.due],
            ["Lapses", node.metrics.lapses],
            [
                "Retention",
                node.metrics.retention === null
                    ? "—"
                    : `${Math.round(node.metrics.retention * 100)}%`,
            ],
        ]) {
            const stat = stats.createDiv();
            stat.createEl("strong", { text: String(value) });
            stat.createSpan({ text: String(label) });
        }
        const actions = inspector.createDiv("sr-graph-inspector-actions");
        new ButtonComponent(actions)
            .setButtonText("Open")
            .setIcon("external-link")
            .onClick(() => void this.openNode(node));
        new ButtonComponent(actions)
            .setButtonText("Focus")
            .setIcon("focus")
            .onClick(() => this.focusNode(node.id));
        if (node.kind !== "root") {
            new ButtonComponent(actions)
                .setButtonText("Path")
                .setIcon("route")
                .onClick(() => this.beginPath());
        }
    }

    private renderMinimap(viewport: HTMLElement, graph: KnowledgeGraphData): void {
        const mini = viewport.createDiv("sr-graph-minimap");
        const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 1400 1400");
        for (const node of graph.nodes) {
            const dot = activeDocument.createElementNS("http://www.w3.org/2000/svg", "circle");
            dot.setAttribute("cx", String(node.x + NODE_WIDTH / 2));
            dot.setAttribute("cy", String(node.y + NODE_HEIGHT / 2));
            dot.setAttribute("r", node.kind === "root" ? "22" : "13");
            dot.classList.add(`is-${node.kind}`);
            svg.appendChild(dot);
        }
        mini.appendChild(svg);
        mini.addEventListener("click", () => this.fitGraph());
    }

    private attachPanZoom(viewport: HTMLElement): void {
        let panning = false;
        let originX = 0;
        let originY = 0;
        viewport.addEventListener("pointerdown", (event) => {
            if ((event.target as HTMLElement).closest(".sr-graph-node, .sr-graph-inspector"))
                return;
            panning = true;
            originX = event.clientX - this.panX;
            originY = event.clientY - this.panY;
            viewport.setPointerCapture(event.pointerId);
            viewport.addClass("is-panning");
        });
        viewport.addEventListener("pointermove", (event) => {
            if (!panning) return;
            this.panX = event.clientX - originX;
            this.panY = event.clientY - originY;
            this.applyTransform();
        });
        const finish = (): void => {
            if (!panning) return;
            panning = false;
            viewport.removeClass("is-panning");
            this.schedulePersist();
        };
        viewport.addEventListener("pointerup", finish);
        viewport.addEventListener("pointercancel", finish);
        viewport.addEventListener(
            "wheel",
            (event) => {
                event.preventDefault();
                const previous = this.zoom;
                this.zoom = Math.max(
                    0.35,
                    Math.min(2.5, this.zoom * (event.deltaY > 0 ? 0.9 : 1.1)),
                );
                const rect = viewport.getBoundingClientRect();
                const cursorX = event.clientX - rect.left;
                const cursorY = event.clientY - rect.top;
                this.panX = cursorX - ((cursorX - this.panX) / previous) * this.zoom;
                this.panY = cursorY - ((cursorY - this.panY) / previous) * this.zoom;
                this.applyTransform();
                this.schedulePersist();
            },
            { passive: false },
        );
    }

    private attachNodeMove(element: HTMLElement, node: KnowledgeGraphNode): void {
        let moving = false;
        let moved = false;
        let offsetX = 0;
        let offsetY = 0;
        element.addEventListener("pointerdown", (event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            moving = true;
            moved = false;
            offsetX = event.clientX / this.zoom - node.x;
            offsetY = event.clientY / this.zoom - node.y;
            element.setPointerCapture(event.pointerId);
        });
        element.addEventListener("pointermove", (event) => {
            if (!moving) return;
            const x = event.clientX / this.zoom - offsetX;
            const y = event.clientY / this.zoom - offsetY;
            if (Math.abs(x - node.x) + Math.abs(y - node.y) > 3) moved = true;
            node.x = Math.round(x);
            node.y = Math.round(y);
            element.setCssProps({ left: `${node.x}px`, top: `${node.y}px` });
        });
        const finish = (event: PointerEvent): void => {
            if (!moving) return;
            moving = false;
            if (moved) {
                event.stopPropagation();
                this.plugin.dataManager.data.knowledgeGraphView.positions[node.id] = {
                    x: node.x,
                    y: node.y,
                };
                this.schedulePersist();
                this.render();
            }
        };
        element.addEventListener("pointerup", finish);
        element.addEventListener("pointercancel", finish);
    }

    private selectNode(id: string): void {
        if (this.pathStartId && this.pathStartId !== id) {
            const path = shortestKnowledgePath(this.graph, this.pathStartId, id);
            this.pathIds = new Set(path);
            this.pathStartId = null;
            this.selectedId = id;
            if (!path.length) new Notice("No path between these nodes");
            this.render();
            return;
        }
        this.selectedId = id;
        this.render();
    }

    private beginPath(): void {
        if (!this.selectedId) {
            new Notice("Select the start node first");
            return;
        }
        this.pathStartId = this.selectedId;
        this.pathIds.clear();
        new Notice("Now select the destination node");
    }

    private toggleCollapsed(id: string): void {
        if (this.collapsedIds.has(id)) this.collapsedIds.delete(id);
        else this.collapsedIds.add(id);
        this.schedulePersist();
        this.render();
    }

    private openNodeMenu(event: MouseEvent, node: KnowledgeGraphNode): void {
        const menu = new Menu();
        menu.addItem((item) =>
            item
                .setTitle("Open")
                .setIcon("external-link")
                .onClick(() => void this.openNode(node)),
        );
        menu.addItem((item) =>
            item
                .setTitle("Focus branch")
                .setIcon("focus")
                .onClick(() => this.focusNode(node.id)),
        );
        if (node.kind === "area" && node.areaId) {
            menu.addItem((item) =>
                item
                    .setTitle("New deck here")
                    .setIcon("folder-plus")
                    .onClick(
                        () =>
                            void this.plugin.uiManager.openNativeDeckCreator(
                                undefined,
                                node.areaId,
                            ),
                    ),
            );
            menu.addItem((item) =>
                item
                    .setTitle("Edit area")
                    .setIcon("pencil")
                    .onClick(
                        () =>
                            void this.plugin.uiManager.openNativeKnowledgeAreaCreator(node.areaId),
                    ),
            );
        }
        if (node.kind === "deck" && node.deckPath) {
            menu.addItem((item) =>
                item
                    .setTitle("Assign knowledge area")
                    .setIcon("library-big")
                    .onClick(() => openCanvasAreaPicker(this.plugin, node.deckPath ?? "")),
            );
            menu.addItem((item) =>
                item
                    .setTitle("Study deck")
                    .setIcon("play")
                    .onClick(() => void this.reviewNode(node)),
            );
        }
        if (this.focusId)
            menu.addItem((item) =>
                item
                    .setTitle("Show full graph")
                    .setIcon("maximize-2")
                    .onClick(() => {
                        this.focusId = null;
                        this.render();
                    }),
            );
        menu.showAtMouseEvent(event);
    }

    private async openNode(node: KnowledgeGraphNode): Promise<void> {
        if (node.notePath) {
            await this.app.workspace.openLinkText(node.notePath, node.notePath, false);
            return;
        }
        if (node.deckPath) await this.plugin.uiManager.openCardBrowser(null, "", node.deckPath);
        else if (node.areaId) {
            const area = this.plugin.dataManager.data.knowledgeAreas.find(
                (candidate) => candidate.id === node.areaId,
            );
            await this.plugin.uiManager.openCardBrowser(null, area ? `area:${area.name}` : "");
        } else await this.plugin.uiManager.openCardBrowser();
    }

    private async reviewNode(node: KnowledgeGraphNode): Promise<void> {
        const records = createStudyRecords(this.plugin).filter((record) =>
            node.deckPath
                ? record.deckNames.includes(node.deckPath)
                : node.notePath
                  ? record.notePath === node.notePath
                  : true,
        );
        const ids = records
            .map((record) => record.card.stableId)
            .filter((id): id is string => Boolean(id));
        if (!ids.length) {
            new Notice("No cards in this branch");
            return;
        }
        await this.plugin.uiManager.openDeckContainer(FlashcardReviewMode.Review, undefined, ids);
    }

    private async assignDeck(deck: string, areaId: string): Promise<void> {
        await new NativeCardStore(this.plugin).assignDeckToKnowledgeArea(deck, areaId);
        new Notice("Deck moved to knowledge area");
        this.refresh();
    }

    private updateSearchClasses(): void {
        this.stageEl?.querySelectorAll<HTMLElement>(".sr-graph-node").forEach((element) => {
            const node = this.graph.nodes.find(
                (candidate) => candidate.id === element.dataset.nodeId,
            );
            element.toggleClass("is-filtered", !node || !graphMatches(node, this.query, this.mode));
        });
    }

    private breadcrumbText(): string {
        if (!this.focusId) return "All knowledge";
        const byId = new Map(this.graph.nodes.map((node) => [node.id, node]));
        const parts: string[] = [];
        let node = byId.get(this.focusId);
        while (node) {
            parts.unshift(node.label);
            node = node.parentId ? byId.get(node.parentId) : undefined;
        }
        return parts.join(" › ");
    }

    private centerNode(id: string): void {
        const node = this.graph.nodes.find((candidate) => candidate.id === id);
        const viewport = this.viewportEl;
        if (!node || !viewport) return;
        this.panX = viewport.clientWidth / 2 - (node.x + NODE_WIDTH / 2) * this.zoom;
        this.panY = viewport.clientHeight / 2 - (node.y + NODE_HEIGHT / 2) * this.zoom;
        this.applyTransform();
        this.schedulePersist();
    }

    private fitGraph(): void {
        const viewport = this.viewportEl;
        if (!viewport || !this.graph.nodes.length) return;
        const maxX = Math.max(...this.graph.nodes.map((node) => node.x + NODE_WIDTH));
        const maxY = Math.max(...this.graph.nodes.map((node) => node.y + NODE_HEIGHT));
        this.zoom = Math.max(
            0.35,
            Math.min(
                1.1,
                Math.min((viewport.clientWidth - 80) / maxX, (viewport.clientHeight - 80) / maxY),
            ),
        );
        this.panX = 32;
        this.panY = 32;
        this.applyTransform();
        this.schedulePersist();
    }

    private applyTransform(): void {
        this.stageEl?.setCssProps({
            transform: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`,
        });
    }

    private schedulePersist(): void {
        if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
        this.persistTimer = window.setTimeout((): void => {
            void this.persistState();
        }, 500);
    }

    private async persistState(): Promise<void> {
        this.persistTimer = null;
        const state = this.plugin.dataManager.data.knowledgeGraphView;
        state.collapsedIds = [...this.collapsedIds];
        state.showSources = this.showSources;
        state.zoom = this.zoom;
        state.panX = this.panX;
        state.panY = this.panY;
        await this.plugin.dataManager.savePluginData();
    }
}
