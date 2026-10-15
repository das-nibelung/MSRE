import {
    App,
    ButtonComponent,
    FuzzySuggestModal,
    ItemView,
    Menu,
    Modal,
    Notice,
    setIcon,
    WorkspaceLeaf,
} from "obsidian";

import { KNOWLEDGE_GRAPH_VIEW_TYPE } from "src/data/constants";
import { NativeCardStore } from "src/data/native-card-store";
import type SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import { compactCardText } from "src/ui/card-browser/card-browser-model";
import {
    buildKnowledgeGraph,
    clusterKnowledgeGraph,
    diagnoseKnowledgeGraph,
    graphMatches,
    knowledgeGraphClusters,
    KnowledgeGraphData,
    KnowledgeGraphEdge,
    KnowledgeGraphIssue,
    KnowledgeGraphNode,
    shortestKnowledgePath,
    virtualizeKnowledgeGraph,
    visibleKnowledgeGraph,
} from "src/ui/knowledge-graph/knowledge-graph-model";
import { openCanvasAreaPicker } from "src/ui/obsidian-integrations/knowledge-area-picker";
import { generateKnowledgeCanvas } from "src/ui/obsidian-integrations/knowledge-canvas";
import {
    addKnowledgeRelation,
    collectKnowledgeRelations,
    KNOWLEDGE_RELATION_TYPES,
    KnowledgeRelationType,
    removeKnowledgeRelation,
    wouldCreateKnowledgeCycle,
} from "src/ui/obsidian-integrations/knowledge-dependencies";
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

class DependencyPickerModal extends FuzzySuggestModal<KnowledgeGraphNode> {
    constructor(
        app: App,
        private readonly candidates: KnowledgeGraphNode[],
        private readonly onChoose: (node: KnowledgeGraphNode) => void,
    ) {
        super(app);
        this.setPlaceholder("Choose a prerequisite concept or source…");
    }

    getItems(): KnowledgeGraphNode[] {
        return this.candidates;
    }

    getItemText(item: KnowledgeGraphNode): string {
        return `${item.label} — ${item.subtitle}`;
    }

    onChooseItem(item: KnowledgeGraphNode): void {
        this.onChoose(item);
    }
}

const RELATION_LABELS: Record<KnowledgeRelationType, string> = {
    prerequisite: "Prerequisite",
    part: "Part of",
    example: "Example of",
    supports: "Supports",
    contradicts: "Contradicts",
};

class TextPromptModal extends Modal {
    constructor(
        app: App,
        private readonly title: string,
        private readonly initialValue: string,
        private readonly submit: (value: string) => void,
    ) {
        super(app);
    }

    onOpen(): void {
        this.contentEl.addClass("sr-graph-prompt");
        this.contentEl.createEl("h3", { text: this.title });
        const input = this.contentEl.createEl("input", { type: "text" });
        input.value = this.initialValue;
        const actions = this.contentEl.createDiv("sr-graph-prompt-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText("Apply")
            .setCta()
            .onClick(() => {
                const value = input.value.trim();
                if (!value) return;
                this.close();
                this.submit(value);
            });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter")
                actions.querySelector<HTMLButtonElement>(".mod-cta")?.click();
        });
        window.setTimeout(() => input.focus(), 0);
    }
}

export class KnowledgeGraphView extends ItemView {
    private graph: KnowledgeGraphData = { nodes: [], edges: [] };
    private query = "";
    private mode = "all";
    private focusId: string | null = null;
    private selectedId: string | null = null;
    private selectedIds = new Set<string>();
    private selectionMode = false;
    private pathStartId: string | null = null;
    private pathIds = new Set<string>();
    private collapsedIds = new Set<string>();
    private zoom = 1;
    private panX = 24;
    private panY = 24;
    private showSources = true;
    private showCards = true;
    private showDiagnostics = true;
    private relationType: KnowledgeRelationType = "prerequisite";
    private linkingFromId: string | null = null;
    private draggedRelationNode = "";
    private issueFocus = new Set<string>();
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
        this.showCards = state.showCards;
        this.showDiagnostics = state.showDiagnostics;
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
        const relations = collectKnowledgeRelations(
            this.plugin.app,
            records.map((record) => record.notePath).filter(Boolean),
        );
        const concepts = Object.fromEntries(
            records.map((record) => {
                const frontmatter = (
                    record.notePath
                        ? this.plugin.app.metadataCache.getCache(record.notePath)?.frontmatter
                        : undefined
                ) as Record<string, unknown> | undefined;
                const explicit = frontmatter?.["sr-concept"];
                const concept =
                    typeof explicit === "string" && explicit.trim()
                        ? explicit.trim()
                        : compactCardText(record.front).slice(0, 96) || "Untitled concept";
                return [record.notePath, concept];
            }),
        );
        const conceptKeys = Object.fromEntries(
            records.map((record) => {
                const frontmatter = (
                    record.notePath
                        ? this.plugin.app.metadataCache.getCache(record.notePath)?.frontmatter
                        : undefined
                ) as Record<string, unknown> | undefined;
                const explicitId = frontmatter?.["sr-concept-id"];
                const compilerKey = frontmatter?.["sr-compiler-key"];
                const key =
                    typeof explicitId === "string" && explicitId.trim()
                        ? explicitId.trim()
                        : typeof compilerKey === "string" && compilerKey.trim()
                          ? compilerKey.trim()
                          : "";
                return [record.notePath, key || `note:${record.notePath}`];
            }),
        );
        return buildKnowledgeGraph(
            this.plugin.dataManager.data.knowledgeAreas,
            records,
            this.plugin.dataManager.data.managedDecks,
            {
                noteLinks: resolvedLinks(this.plugin),
                relations,
                concepts,
                conceptKeys,
                positions: state.positions,
                showCardNodes: this.showCards,
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
        const graphWidth = this.graph.nodes.reduce(
            (maximum, node) => Math.max(maximum, node.x + NODE_WIDTH + 200),
            2_200,
        );
        const graphHeight = this.graph.nodes.reduce(
            (maximum, node) => Math.max(maximum, node.y + NODE_HEIGHT + 200),
            1_400,
        );
        stage.setCssProps({
            width: `${graphWidth}px`,
            height: `${graphHeight}px`,
        });
        this.applyTransform();
        this.attachPanZoom(viewport);

        let visible = visibleKnowledgeGraph(
            this.graph,
            this.collapsedIds,
            this.showSources,
            this.focusId,
        );
        if (visible.nodes.length > 1_200 && this.zoom < 0.65)
            visible = clusterKnowledgeGraph(visible);
        visible = virtualizeKnowledgeGraph(visible, this.visibleBounds());
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
        this.renderInspector(shell, this.graph);
        this.renderSelectionBar(shell);
        if (this.showDiagnostics) this.renderDiagnostics(shell);
        this.renderMinimap(
            viewport,
            this.graph.nodes.length > 1_200 ? clusterKnowledgeGraph(this.graph) : this.graph,
        );
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
            .setIcon(this.showCards ? "gallery-horizontal" : "gallery-horizontal-end")
            .setTooltip(this.showCards ? "Hide card variants" : "Show card variants")
            .onClick(() => {
                this.showCards = !this.showCards;
                this.schedulePersist();
                this.render();
            });
        new ButtonComponent(controls)
            .setIcon(this.selectionMode ? "list-checks" : "mouse-pointer-2")
            .setTooltip(this.selectionMode ? "Finish multiple selection" : "Select several nodes")
            .onClick(() => {
                this.selectionMode = !this.selectionMode;
                if (!this.selectionMode && this.selectedIds.size < 2) this.selectedIds.clear();
                this.render();
            });
        const relation = controls.createEl("select", {
            cls: "dropdown sr-graph-relation-select",
            attr: { "aria-label": "Relation type for new connections" },
        });
        KNOWLEDGE_RELATION_TYPES.forEach((type) =>
            relation.createEl("option", { value: type, text: RELATION_LABELS[type] }),
        );
        relation.value = this.relationType;
        relation.addEventListener("change", () => {
            this.relationType = relation.value as KnowledgeRelationType;
        });
        new ButtonComponent(controls)
            .setIcon(this.showDiagnostics ? "shield-alert" : "shield-check")
            .setTooltip(this.showDiagnostics ? "Hide graph diagnostics" : "Show graph diagnostics")
            .onClick(() => {
                this.showDiagnostics = !this.showDiagnostics;
                this.issueFocus.clear();
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
        svg.setAttribute(
            "width",
            String(
                graph.nodes.reduce(
                    (maximum, node) => Math.max(maximum, node.x + NODE_WIDTH + 200),
                    2_200,
                ),
            ),
        );
        svg.setAttribute(
            "height",
            String(
                graph.nodes.reduce(
                    (maximum, node) => Math.max(maximum, node.y + NODE_HEIGHT + 200),
                    1_400,
                ),
            ),
        );
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
            if (edge.kind !== "contains" && edge.kind !== "link") {
                const title = activeDocument.createElementNS("http://www.w3.org/2000/svg", "title");
                title.textContent =
                    edge.reason || `${from.label} — ${RELATION_LABELS[edge.kind]} → ${to.label}`;
                path.appendChild(title);
            }
            if (this.issueFocus.has(edge.id)) path.classList.add("is-issue");
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
        if (this.selectedIds.has(node.id)) element.addClass("is-multi-selected");
        if (this.pathIds.has(node.id)) element.addClass("is-path");
        if (this.issueFocus.has(node.id)) element.addClass("is-issue");
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
        if (["concept", "note", "card"].includes(node.kind)) {
            element.addEventListener("dragover", (event) => {
                if (!this.draggedRelationNode || this.draggedRelationNode === node.id) return;
                event.preventDefault();
                element.addClass("is-relation-target");
            });
            element.addEventListener("dragleave", () => element.removeClass("is-relation-target"));
            element.addEventListener("drop", (event) => {
                if (!this.draggedRelationNode) return;
                event.preventDefault();
                event.stopPropagation();
                element.removeClass("is-relation-target");
                const sourceId = this.draggedRelationNode;
                this.draggedRelationNode = "";
                void this.connectNodes(sourceId, node.id);
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
                  : node.kind === "concept"
                    ? "brain-circuit"
                    : node.kind === "note"
                      ? "file-text"
                      : node.kind === "card"
                        ? "gallery-horizontal"
                        : node.kind === "cluster"
                          ? "boxes"
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
        if (["concept", "note", "card"].includes(node.kind)) {
            const port = element.createEl("button", {
                cls: "sr-graph-relation-port",
                attr: {
                    "aria-label": `Create ${RELATION_LABELS[this.relationType].toLocaleLowerCase()} relation`,
                    draggable: "true",
                },
            });
            setIcon(port, "git-branch-plus");
            port.addEventListener("dragstart", (event) => {
                event.stopPropagation();
                this.draggedRelationNode = node.id;
                event.dataTransfer?.setData("text/x-msre-graph-node", node.id);
            });
            port.addEventListener("dragend", () => {
                this.draggedRelationNode = "";
            });
            port.addEventListener("click", (event) => {
                event.stopPropagation();
                if (this.linkingFromId && this.linkingFromId !== node.id) {
                    const source = this.linkingFromId;
                    this.linkingFromId = null;
                    void this.connectNodes(source, node.id);
                } else {
                    this.linkingFromId = node.id;
                    new Notice(
                        `Select the target for ${RELATION_LABELS[this.relationType].toLocaleLowerCase()}`,
                    );
                    this.render();
                }
            });
            if (this.linkingFromId === node.id) element.addClass("is-linking-source");
        }
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
        element.addEventListener("click", (event) => this.selectNode(node.id, event));
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
            if (!this.selectionMode) this.selectedIds.clear();
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
        if (node.kind === "concept" || node.kind === "note" || node.kind === "card") {
            new ButtonComponent(actions)
                .setButtonText("Obsidian")
                .setIcon("network")
                .onClick(() => void this.syncNodeToObsidian(node));
            this.renderDependencyEditor(inspector, node);
        }
    }

    private renderDependencyEditor(inspector: HTMLElement, node: KnowledgeGraphNode): void {
        const section = inspector.createDiv("sr-graph-dependency-editor");
        const heading = section.createDiv("sr-graph-dependency-heading");
        heading.createEl("strong", { text: "Knowledge relations" });
        const add = heading.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": `Add ${RELATION_LABELS[this.relationType].toLocaleLowerCase()}` },
        });
        setIcon(add, "plus");
        const dependentPath = node.notePath ?? node.notePaths?.[0] ?? "";
        add.disabled = !dependentPath;
        add.addEventListener("click", () => this.openDependencyPicker(node, dependentPath));

        const inbound = this.graph.edges.filter(
            (edge) => edge.kind !== "contains" && edge.kind !== "link" && edge.to === node.id,
        );
        const outbound = this.graph.edges.filter(
            (edge) => edge.kind !== "contains" && edge.kind !== "link" && edge.from === node.id,
        );
        const list = section.createDiv("sr-graph-dependency-list");
        if (!inbound.length && !outbound.length) {
            list.createSpan({ text: "No explicit graph edges yet", cls: "is-empty" });
        }
        for (const edge of inbound) {
            const source = this.graph.nodes.find((candidate) => candidate.id === edge.from);
            const row = list.createDiv("sr-graph-dependency-row");
            row.createSpan({ text: RELATION_LABELS[edge.kind as KnowledgeRelationType] });
            row.createEl("strong", {
                text: source?.label ?? edge.fromPath ?? edge.prerequisitePath ?? "Source",
            });
            const remove = row.createEl("button", {
                cls: "clickable-icon",
                attr: { "aria-label": "Remove prerequisite" },
            });
            setIcon(remove, "x");
            remove.addEventListener("click", () => void this.removeRelation(edge));
        }
        for (const edge of outbound) {
            const target = this.graph.nodes.find((candidate) => candidate.id === edge.to);
            const row = list.createDiv("sr-graph-dependency-row is-outbound");
            row.createSpan({ text: RELATION_LABELS[edge.kind as KnowledgeRelationType] });
            row.createEl("strong", {
                text: target?.label ?? edge.toPath ?? edge.dependentPath ?? "Target",
            });
            const remove = row.createEl("button", {
                cls: "clickable-icon",
                attr: { "aria-label": "Remove relation" },
            });
            setIcon(remove, "x");
            remove.addEventListener("click", () => void this.removeRelation(edge));
        }
    }

    private openDependencyPicker(node: KnowledgeGraphNode, dependentPath: string): void {
        if (!dependentPath) return;
        const ownPaths = new Set([node.notePath, ...(node.notePaths ?? [])].filter(Boolean));
        const conceptCandidates = this.graph.nodes.filter(
            (candidate) =>
                candidate.kind === "concept" &&
                candidate.id !== node.id &&
                [candidate.notePath, ...(candidate.notePaths ?? [])].some(
                    (path) => path && !ownPaths.has(path),
                ),
        );
        const candidates = conceptCandidates.length
            ? conceptCandidates
            : this.graph.nodes.filter(
                  (candidate) =>
                      candidate.kind === "note" &&
                      candidate.id !== node.id &&
                      Boolean(candidate.notePath && !ownPaths.has(candidate.notePath)),
              );
        new DependencyPickerModal(this.app, candidates, (candidate) => {
            const prerequisitePath = candidate.notePath ?? candidate.notePaths?.[0] ?? "";
            if (prerequisitePath) {
                void this.addTypedRelation(
                    prerequisitePath,
                    dependentPath,
                    this.relationType,
                    candidate.label,
                    node.label,
                );
            }
        }).open();
    }

    private async addTypedRelation(
        fromPath: string,
        toPath: string,
        type: KnowledgeRelationType,
        fromLabel: string,
        toLabel: string,
    ): Promise<void> {
        const relations = collectKnowledgeRelations(
            this.plugin.app,
            createStudyRecords(this.plugin)
                .map((record) => record.notePath)
                .filter(Boolean),
        );
        const prerequisites = relations
            .filter((edge) => edge.type === "prerequisite")
            .map((edge) => ({ prerequisitePath: edge.fromPath, dependentPath: edge.toPath }));
        if (type === "prerequisite" && wouldCreateKnowledgeCycle(prerequisites, fromPath, toPath)) {
            new Notice("This edge would create a circular prerequisite");
            return;
        }
        const added = await addKnowledgeRelation(
            this.plugin.app,
            fromPath,
            toPath,
            type,
            `${fromLabel} — ${RELATION_LABELS[type].toLocaleLowerCase()} → ${toLabel}`,
        );
        if (!added) {
            new Notice("Could not add this relation");
            return;
        }
        await this.plugin.dataManager.sync();
        new Notice(`${RELATION_LABELS[type]} relation saved to Markdown`);
        this.refresh();
    }

    private async removeRelation(edge: KnowledgeGraphEdge): Promise<void> {
        if (edge.kind === "contains" || edge.kind === "link") return;
        const fromPath = edge.fromPath ?? edge.prerequisitePath;
        const toPath = edge.toPath ?? edge.dependentPath;
        if (!fromPath || !toPath) return;
        await removeKnowledgeRelation(this.plugin.app, fromPath, toPath, edge.kind);
        await this.plugin.dataManager.sync();
        new Notice("Knowledge relation removed");
        this.refresh();
    }

    private async connectNodes(fromId: string, toId: string): Promise<void> {
        const from = this.graph.nodes.find((node) => node.id === fromId);
        const to = this.graph.nodes.find((node) => node.id === toId);
        const fromPath = this.nodePrimaryPath(from);
        const toPath = this.nodePrimaryPath(to);
        if (!from || !to || !fromPath || !toPath || fromPath === toPath) {
            new Notice("Choose two different concepts or source notes");
            return;
        }
        await this.addTypedRelation(fromPath, toPath, this.relationType, from.label, to.label);
    }

    private nodePrimaryPath(node: KnowledgeGraphNode | undefined): string {
        return node?.notePath ?? node?.notePaths?.[0] ?? "";
    }

    private visibleBounds(): { left: number; top: number; right: number; bottom: number } {
        const viewport = this.viewportEl;
        if (!viewport) return { left: -1_000, top: -1_000, right: 4_000, bottom: 8_000 };
        return {
            left: -this.panX / this.zoom,
            top: -this.panY / this.zoom,
            right: (viewport.clientWidth - this.panX) / this.zoom,
            bottom: (viewport.clientHeight - this.panY) / this.zoom,
        };
    }

    private renderDiagnostics(shell: HTMLElement): void {
        const issues = diagnoseKnowledgeGraph(this.graph);
        const panel = shell.createDiv("sr-graph-diagnostics");
        const header = panel.createDiv("sr-graph-diagnostics-header");
        header.createEl("strong", { text: "Graph health" });
        header.createSpan({
            text: issues.length ? `${issues.length} signals` : "No structural issues",
            cls: issues.length ? "is-warning" : "is-clean",
        });
        const counts = panel.createDiv("sr-graph-diagnostic-counts");
        for (const [kind, icon] of [
            ["cycle", "refresh-cw"],
            ["contradiction", "split"],
            ["isolated", "unlink"],
        ] as const) {
            const matching = issues.filter((issue) => issue.kind === kind);
            const button = counts.createEl("button", {
                cls: `sr-graph-diagnostic is-${kind}`,
                attr: { "aria-label": `Show ${kind} issues` },
            });
            setIcon(button, icon);
            button.createSpan({ text: String(matching.length) });
            button.addEventListener("click", () => this.focusIssues(matching));
        }
        const clusters = knowledgeGraphClusters(this.graph);
        const clusterSummary = panel.createEl("button", { cls: "sr-graph-cluster-summary" });
        clusterSummary.createSpan({ text: `${clusters.length} clusters` });
        clusterSummary.createSpan({
            text: clusters.length ? `largest ${clusters[0]?.length ?? 0}` : "no concepts",
        });
        clusterSummary.addEventListener("click", () => {
            const largest = clusters[0];
            if (!largest?.length) return;
            this.focusId = largest[0].id;
            this.issueFocus = new Set(largest.map((node) => node.id));
            this.render();
            window.setTimeout(() => this.centerNode(largest[0].id), 0);
        });
    }

    private focusIssues(issues: KnowledgeGraphIssue[]): void {
        this.issueFocus = new Set(issues.flatMap((issue) => [...issue.nodeIds, ...issue.edgeIds]));
        const firstNode = issues[0]?.nodeIds[0];
        if (firstNode) {
            this.selectedId = firstNode;
            this.selectedIds = new Set([firstNode]);
            this.render();
            window.setTimeout(() => this.centerNode(firstNode), 0);
        } else {
            new Notice("No issues of this type");
        }
    }

    private renderSelectionBar(shell: HTMLElement): void {
        if (!this.selectedIds.size || (!this.selectionMode && this.selectedIds.size < 2)) return;
        const selected = this.graph.nodes.filter((node) => this.selectedIds.has(node.id));
        const bar = shell.createDiv("sr-graph-selection-bar");
        bar.createEl("strong", { text: `${selected.length} selected` });
        const concepts = selected.filter((node) => node.kind === "concept");
        const decks = selected.filter((node) => node.kind === "deck" && node.deckPath);
        const areas = selected.filter((node) => node.kind === "area" && node.areaId);
        if (concepts.length >= 2)
            new ButtonComponent(bar)
                .setButtonText("Merge")
                .setIcon("combine")
                .onClick(() => this.mergeSelectedConcepts(concepts));
        if (concepts.length === 1 && (concepts[0].notePaths?.length ?? 0) > 1)
            new ButtonComponent(bar)
                .setButtonText("Split")
                .setIcon("ungroup")
                .onClick(() => void this.splitConcept(concepts[0]));
        if (decks.length && areas.length === 1)
            new ButtonComponent(bar)
                .setButtonText("Move decks")
                .setIcon("folder-input")
                .onClick(() => void this.moveSelectedDecks(decks, areas[0].areaId ?? ""));
        new ButtonComponent(bar)
            .setButtonText("Review")
            .setIcon("play")
            .onClick(() => void this.reviewNodes(selected));
        new ButtonComponent(bar)
            .setIcon("x")
            .setTooltip("Clear selection")
            .onClick(() => {
                this.selectedIds.clear();
                this.selectedId = null;
                this.render();
            });
    }

    private mergeSelectedConcepts(nodes: KnowledgeGraphNode[]): void {
        const defaultName = nodes[0]?.label ?? "Merged concept";
        new TextPromptModal(this.app, "Merge concepts as", defaultName, (label) => {
            void this.applyConceptMerge(nodes, label);
        }).open();
    }

    private async applyConceptMerge(nodes: KnowledgeGraphNode[], label: string): Promise<void> {
        const paths = [...new Set(nodes.flatMap((node) => node.notePaths ?? []))];
        const conceptId = `merged-${Date.now().toString(36)}`;
        for (const path of paths) {
            const file = this.app.vault.getFileByPath(path);
            if (!file) continue;
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                const data = frontmatter as Record<string, unknown>;
                data["sr-concept"] = label;
                data["sr-concept-id"] = conceptId;
            });
        }
        await this.plugin.dataManager.sync();
        this.selectedIds.clear();
        this.selectedId = null;
        new Notice(`${nodes.length} concepts merged without changing their source files`);
        this.refresh();
    }

    private async splitConcept(node: KnowledgeGraphNode): Promise<void> {
        const paths = node.notePaths ?? [];
        for (const [index, path] of paths.entries()) {
            const file = this.app.vault.getFileByPath(path);
            if (!file) continue;
            await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
                const data = frontmatter as Record<string, unknown>;
                data["sr-concept-id"] = `split-${Date.now().toString(36)}-${index}`;
            });
        }
        await this.plugin.dataManager.sync();
        this.selectedIds.clear();
        new Notice(`${paths.length} sources split into independent concepts`);
        this.refresh();
    }

    private async moveSelectedDecks(nodes: KnowledgeGraphNode[], areaId: string): Promise<void> {
        for (const node of nodes)
            if (node.deckPath) await this.assignDeck(node.deckPath, areaId, false);
        new Notice(`${nodes.length} decks moved`);
        this.selectedIds.clear();
        this.refresh();
    }

    private async reviewNodes(nodes: KnowledgeGraphNode[]): Promise<void> {
        const ids = new Set<string>();
        for (const node of nodes) {
            createStudyRecords(this.plugin)
                .filter((record) => this.recordBelongsToNode(record, node))
                .forEach((record) => {
                    if (record.card.stableId) ids.add(record.card.stableId);
                });
        }
        if (!ids.size) return void new Notice("No cards in this selection");
        await this.plugin.uiManager.openDeckContainer(FlashcardReviewMode.Review, undefined, [
            ...ids,
        ]);
    }

    private async syncNodeToObsidian(node: KnowledgeGraphNode): Promise<void> {
        const view = this.plugin.dataManager.data.knowledgeCanvasView;
        view.focusDeck = node.deckPath ?? null;
        view.focusAreaId = node.areaId ?? null;
        view.focusSourcePath = this.nodePrimaryPath(node) || null;
        await this.plugin.dataManager.savePluginData();
        await generateKnowledgeCanvas(this.plugin, { notify: false });
        const path = this.nodePrimaryPath(node);
        if (path) {
            const leaf = this.app.workspace.getLeaf("tab");
            await leaf.setViewState({ type: "localgraph", active: true, state: { file: path } });
        }
        new Notice("Selection synchronized with Obsidian Graph and Canvas");
    }

    private renderMinimap(viewport: HTMLElement, graph: KnowledgeGraphData): void {
        const mini = viewport.createDiv("sr-graph-minimap");
        const svg = activeDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
        const width = graph.nodes.reduce(
            (maximum, node) => Math.max(maximum, node.x + NODE_WIDTH),
            1_400,
        );
        const height = graph.nodes.reduce(
            (maximum, node) => Math.max(maximum, node.y + NODE_HEIGHT),
            1_400,
        );
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
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
            if (this.graph.nodes.length > 900) this.render();
        };
        viewport.addEventListener("pointerup", finish);
        viewport.addEventListener("pointercancel", finish);
        viewport.addEventListener(
            "wheel",
            (event) => {
                event.preventDefault();
                const previous = this.zoom;
                this.zoom = Math.max(
                    0.15,
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

    private selectNode(id: string, event?: MouseEvent): void {
        if (this.linkingFromId && this.linkingFromId !== id) {
            const source = this.linkingFromId;
            this.linkingFromId = null;
            void this.connectNodes(source, id);
            return;
        }
        if (this.pathStartId && this.pathStartId !== id) {
            const path = shortestKnowledgePath(this.graph, this.pathStartId, id);
            this.pathIds = new Set(path);
            this.pathStartId = null;
            this.selectedId = id;
            if (!path.length) new Notice("No path between these nodes");
            this.render();
            return;
        }
        if (this.selectionMode || event?.shiftKey || event?.metaKey || event?.ctrlKey) {
            if (this.selectedIds.has(id)) this.selectedIds.delete(id);
            else this.selectedIds.add(id);
            const remaining = [...this.selectedIds];
            this.selectedId = this.selectedIds.has(id)
                ? id
                : (remaining[remaining.length - 1] ?? null);
            this.render();
            return;
        }
        this.selectedIds = new Set([id]);
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
        if (node.kind === "concept" && node.notePaths?.[0]) {
            await this.app.workspace.openLinkText(node.notePaths[0], node.notePaths[0], false);
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
            this.recordBelongsToNode(record, node),
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

    private recordBelongsToNode(
        record: ReturnType<typeof createStudyRecords>[number],
        node: KnowledgeGraphNode,
    ): boolean {
        if (node.cardId)
            return [record.card.stableId, record.collectionCardId, record.id].includes(node.cardId);
        if (node.notePath) return record.notePath === node.notePath;
        if (node.notePaths?.length) return node.notePaths.includes(record.notePath);
        if (node.deckPath) return record.deckNames.includes(node.deckPath);
        if (node.areaId) {
            const area = this.plugin.dataManager.data.knowledgeAreas.find(
                (candidate) => candidate.id === node.areaId,
            );
            return Boolean(area && record.deckNames.some((deck) => area.deckPaths.includes(deck)));
        }
        return true;
    }

    private async assignDeck(deck: string, areaId: string, notify = true): Promise<void> {
        await new NativeCardStore(this.plugin).assignDeckToKnowledgeArea(deck, areaId);
        if (notify) {
            new Notice("Deck moved to knowledge area");
            this.refresh();
        }
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
        if (this.graph.nodes.length > 900) window.setTimeout(() => this.render(), 0);
    }

    private fitGraph(): void {
        const viewport = this.viewportEl;
        if (!viewport || !this.graph.nodes.length) return;
        const fitSource =
            this.graph.nodes.length > 1_200 ? clusterKnowledgeGraph(this.graph) : this.graph;
        const maxX = fitSource.nodes.reduce(
            (maximum, node) => Math.max(maximum, node.x + NODE_WIDTH),
            NODE_WIDTH,
        );
        const maxY = fitSource.nodes.reduce(
            (maximum, node) => Math.max(maximum, node.y + NODE_HEIGHT),
            NODE_HEIGHT,
        );
        this.zoom = Math.max(
            0.15,
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
        state.showCards = this.showCards;
        state.showDiagnostics = this.showDiagnostics;
        state.zoom = this.zoom;
        state.panX = this.panX;
        state.panY = this.panY;
        await this.plugin.dataManager.savePluginData();
    }
}
