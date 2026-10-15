import { Card } from "src/data/data-structures/card/card";
import { KnowledgeArea } from "src/data/plugin-data";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";
import {
    buildKnowledgeGraph,
    clusterKnowledgeGraph,
    diagnoseKnowledgeGraph,
    graphMatches,
    knowledgeGraphClusters,
    shortestKnowledgePath,
    virtualizeKnowledgeGraph,
    visibleKnowledgeGraph,
} from "src/ui/knowledge-graph/knowledge-graph-model";
import {
    buildKnowledgeCanvas,
    mergeKnowledgeCanvas,
} from "src/ui/obsidian-integrations/knowledge-canvas";
import { wouldCreateKnowledgeCycle } from "src/ui/obsidian-integrations/knowledge-dependencies";
import { cardSourceTarget } from "src/ui/obsidian-integrations/obsidian-links";
import {
    aggregateStudyBaseEntries,
    filterStudyBaseRecords,
    filterStudyBaseSummaries,
    parseStudyCsv,
} from "src/ui/obsidian-integrations/study-bases-model";

function record(overrides: Partial<CardBrowserRecord>): CardBrowserRecord {
    return {
        card: {} as Card,
        id: "card-1",
        front: "Question",
        back: "Answer",
        notePath: "Medicine/Heart.md",
        deckNames: ["Medicine/Cardiology"],
        state: "new",
        dueDate: null,
        interval: null,
        ease: null,
        lifecycleState: "active",
        flag: 0,
        tags: [],
        cardType: "basic",
        ...overrides,
    };
}

describe("Obsidian knowledge integrations", () => {
    it("aggregates Base notes into compact study summaries", () => {
        const summaries = aggregateStudyBaseEntries(
            [
                { path: "Medicine/Heart.md", basename: "Heart" },
                { path: "Medicine/Lung.md", basename: "Lung" },
            ],
            [
                record({ state: "due", retention: 0.7, difficulty: 8, lapses: 3, tags: ["heart"] }),
                record({ id: "new", state: "new", retention: 0.9, difficulty: 6 }),
                record({
                    id: "scheduled",
                    notePath: "Medicine/Lung.md",
                    deckNames: ["Medicine/Pulmonology"],
                    state: "scheduled",
                }),
            ],
        );

        expect(summaries[0]).toMatchObject({ total: 2, due: 1, newCards: 1, scheduled: 0 });
        expect(summaries[0].decks).toEqual(["Medicine/Cardiology"]);
        expect(summaries[0].retention).toBeCloseTo(0.8);
        expect(summaries[0].difficulty).toBe(7);
        expect(summaries[0].lapses).toBe(3);
        expect(summaries[0].tags).toEqual(["heart"]);
        expect(filterStudyBaseSummaries(summaries, "weak")).toEqual([summaries[0]]);
        expect(summaries[1]).toMatchObject({ total: 1, due: 0, newCards: 0, scheduled: 1 });
    });

    it("filters exact cards for every Base preset", () => {
        const due = record({ id: "due", state: "due", lifecycleState: "active" });
        const weak = record({ id: "weak", state: "scheduled", lapses: 2, retention: 0.7 });
        const suspended = record({ id: "suspended", state: "due", lifecycleState: "suspended" });
        const unassigned = record({ id: "unassigned", areaNames: [] });
        const records = [due, weak, suspended, unassigned];

        expect(filterStudyBaseRecords(records, "today")).toEqual([due, unassigned]);
        expect(filterStudyBaseRecords(records, "weak")).toEqual([weak]);
        expect(filterStudyBaseRecords(records, "no-area")).toContain(unassigned);
    });

    it("round-trips quoted Study CSV values", () => {
        expect(parseStudyCsv('"Card ID","Question","Tags"\n"card-1","A, B","one | two"\n')).toEqual(
            [{ "Card ID": "card-1", Question: "A, B", Tags: "one | two" }],
        );
    });

    it("builds, collapses, searches, and routes an interactive knowledge graph", () => {
        const areas: KnowledgeArea[] = [
            {
                id: "medicine",
                name: "Medicine",
                deckPaths: ["Medicine/Cardiology"],
                pinned: true,
            },
        ];
        const graph = buildKnowledgeGraph(
            areas,
            [
                record({ id: "heart", state: "due", lapses: 3, retention: 0.7 }),
                record({
                    id: "lung",
                    notePath: "Medicine/Lung.md",
                    state: "scheduled",
                }),
            ],
            ["Medicine/Cardiology"],
            {
                noteLinks: { "Medicine/Heart.md": ["Medicine/Lung.md"] },
                dependencies: [
                    {
                        prerequisitePath: "Medicine/Lung.md",
                        dependentPath: "Medicine/Heart.md",
                        source: "compiler",
                        reason: "Respiration supports cardiac function",
                    },
                ],
            },
        );
        const deck = graph.nodes.find((node) => node.id === "deck:Medicine/Cardiology");

        expect(deck).toBeDefined();
        if (!deck) throw new Error("Expected Cardiology deck node");
        expect(graphMatches(deck, "cardio", "weak")).toBe(true);
        expect(
            visibleKnowledgeGraph(graph, ["area:medicine"], true).nodes.some(
                (node) => node.kind === "deck",
            ),
        ).toBe(false);
        expect(
            visibleKnowledgeGraph(graph, [], false).nodes.every((node) => node.kind !== "note"),
        ).toBe(true);
        expect(
            shortestKnowledgePath(graph, "note:Medicine/Heart.md", "note:Medicine/Lung.md"),
        ).toEqual(["note:Medicine/Heart.md", "note:Medicine/Lung.md"]);
        expect(graph.edges).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    from: "note:Medicine/Lung.md",
                    to: "note:Medicine/Heart.md",
                    kind: "prerequisite",
                }),
            ]),
        );
    });

    it("uses concepts as real graph nodes and rejects circular prerequisites", () => {
        const graph = buildKnowledgeGraph(
            [],
            [record({ id: "heart" }), record({ id: "lung", notePath: "Medicine/Lung.md" })],
            ["Medicine/Cardiology"],
            {
                concepts: {
                    "Medicine/Heart.md": "Circulation",
                    "Medicine/Lung.md": "Respiration",
                },
                dependencies: [
                    {
                        prerequisitePath: "Medicine/Lung.md",
                        dependentPath: "Medicine/Heart.md",
                        source: "compiler",
                    },
                ],
            },
        );
        const concepts = graph.nodes.filter((node) => node.kind === "concept");
        const edge = graph.edges.find((candidate) => candidate.kind === "prerequisite");

        expect(concepts.map((node) => node.label).sort()).toEqual(["Circulation", "Respiration"]);
        expect(edge?.from).toMatch(/^concept:/);
        expect(edge?.to).toMatch(/^concept:/);
        expect(
            wouldCreateKnowledgeCycle(
                [
                    {
                        prerequisitePath: "A.md",
                        dependentPath: "B.md",
                    },
                    {
                        prerequisitePath: "B.md",
                        dependentPath: "C.md",
                    },
                ],
                "C.md",
                "A.md",
            ),
        ).toBe(true);
        expect(wouldCreateKnowledgeCycle([], "A.md", "B.md")).toBe(false);
    });

    it("builds a large file-native concept graph without collapsing distinct identities", () => {
        const count = 2_000;
        const records = Array.from({ length: count }, (_, index) =>
            record({
                id: `card-${index}`,
                notePath: `Knowledge/Concept-${index}.md`,
                deckNames: ["Knowledge"],
            }),
        );
        const concepts = Object.fromEntries(
            records.map((item, index) => [item.notePath, `Concept ${index}`]),
        );
        const conceptKeys = Object.fromEntries(
            records.map((item, index) => [item.notePath, `concept-${index}`]),
        );

        const graph = buildKnowledgeGraph([], records, ["Knowledge"], {
            concepts,
            conceptKeys,
        });

        expect(graph.nodes.filter((node) => node.kind === "concept")).toHaveLength(count);
        expect(graph.nodes.filter((node) => node.kind === "note")).toHaveLength(count);
        expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    });

    it("models typed relations and individual variants from one source note", () => {
        const graph = buildKnowledgeGraph(
            [],
            [
                record({ id: "forward", front: "Term", notePath: "Knowledge/Term.md" }),
                record({ id: "reverse", front: "Definition", notePath: "Knowledge/Term.md" }),
                record({ id: "example", notePath: "Knowledge/Example.md" }),
            ],
            ["Medicine/Cardiology"],
            {
                concepts: {
                    "Knowledge/Term.md": "Term",
                    "Knowledge/Example.md": "Example",
                },
                conceptKeys: {
                    "Knowledge/Term.md": "term",
                    "Knowledge/Example.md": "example",
                },
                relations: [
                    {
                        fromPath: "Knowledge/Example.md",
                        toPath: "Knowledge/Term.md",
                        type: "example",
                        source: "manual",
                    },
                ],
                showCardNodes: true,
            },
        );

        expect(graph.nodes.filter((node) => node.kind === "card")).toHaveLength(2);
        expect(graph.edges).toContainEqual(
            expect.objectContaining({ kind: "example", fromPath: "Knowledge/Example.md" }),
        );
    });

    it("diagnoses prerequisite cycles, contradictions and isolated concepts", () => {
        const graph = buildKnowledgeGraph(
            [],
            [
                record({ id: "a", notePath: "A.md" }),
                record({ id: "b", notePath: "B.md" }),
                record({ id: "c", notePath: "C.md" }),
            ],
            ["Medicine/Cardiology"],
            {
                concepts: { "A.md": "A", "B.md": "B", "C.md": "C" },
                conceptKeys: { "A.md": "a", "B.md": "b", "C.md": "c" },
                relations: [
                    { fromPath: "A.md", toPath: "B.md", type: "prerequisite", source: "manual" },
                    { fromPath: "B.md", toPath: "A.md", type: "prerequisite", source: "manual" },
                    { fromPath: "A.md", toPath: "B.md", type: "contradicts", source: "manual" },
                ],
            },
        );
        const issues = diagnoseKnowledgeGraph(graph);

        expect(issues.some((issue) => issue.kind === "cycle")).toBe(true);
        expect(issues.some((issue) => issue.kind === "contradiction")).toBe(true);
        expect(
            issues.some((issue) => issue.kind === "isolated" && issue.message.startsWith("C")),
        ).toBe(true);
        expect(knowledgeGraphClusters(graph)[0]).toHaveLength(2);
    });

    it("virtualizes large graph canvases while retaining ancestors and visible edges", () => {
        const records = Array.from({ length: 1_000 }, (_, index) =>
            record({ id: `card-${index}`, notePath: `Knowledge/${index}.md` }),
        );
        const graph = buildKnowledgeGraph([], records, ["Medicine/Cardiology"]);
        const windowed = virtualizeKnowledgeGraph(
            graph,
            { left: 1_300, top: 0, right: 1_700, bottom: 500 },
            40,
            80,
        );

        expect(windowed.nodes.length).toBeLessThan(graph.nodes.length);
        expect(windowed.nodes.some((node) => node.kind === "root")).toBe(true);
        expect(
            windowed.edges.every(
                (edge) =>
                    windowed.nodes.some((node) => node.id === edge.from) &&
                    windowed.nodes.some((node) => node.id === edge.to),
            ),
        ).toBe(true);
        const overview = clusterKnowledgeGraph(graph, 20);
        expect(overview.nodes.some((node) => node.kind === "cluster")).toBe(true);
        expect(overview.nodes.length).toBeLessThan(graph.nodes.length);
    });

    it("builds a valid linked JSON Canvas knowledge map", () => {
        const areas: KnowledgeArea[] = [
            {
                id: "medicine",
                name: "Medicine",
                icon: "heart-pulse",
                deckPaths: ["Medicine/Cardiology"],
                pinned: true,
            },
        ];
        const canvas = buildKnowledgeCanvas(
            areas,
            [
                record({ state: "due", lapses: 2, retention: 0.7 }),
                record({
                    id: "lung",
                    notePath: "Medicine/Lung.md",
                    state: "scheduled",
                }),
            ],
            ["Medicine/Cardiology", "Languages/English"],
            {
                noteLinks: { "Medicine/Heart.md": ["Medicine/Lung.md"] },
                sourceLimitPerDeck: 5,
                view: {
                    focusDeck: "Medicine/Cardiology",
                    focusSourcePath: "Medicine/Lung.md",
                },
            },
        );
        const ids = new Set(canvas.nodes.map((node) => node.id));

        expect(ids.size).toBe(canvas.nodes.length);
        expect(
            canvas.nodes.some((node) => node.type === "file" && node.file === "Medicine/Heart.md"),
        ).toBe(true);
        expect(
            canvas.nodes.some(
                (node) =>
                    node.type === "file" && node.file === "Medicine/Lung.md" && node.color === "1",
            ),
        ).toBe(true);
        expect(
            canvas.nodes.some(
                (node) => node.type === "text" && node.text.includes("deck=Medicine%2FCardiology"),
            ),
        ).toBe(true);
        expect(
            canvas.nodes.some(
                (node) =>
                    node.type === "text" && node.text.includes("Source: **Medicine/Lung.md**"),
            ),
        ).toBe(true);
        expect(
            canvas.nodes.some(
                (node) => node.type === "text" && node.text.includes("Recently studied"),
            ),
        ).toBe(true);
        expect(canvas.edges.some((edge) => edge.label === "link")).toBe(true);
        expect(canvas.edges.every((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode))).toBe(
            true,
        );
    });

    it("preserves manual Canvas positions and custom nodes", () => {
        const generated = buildKnowledgeCanvas([], [record({})], ["Medicine/Cardiology"]);
        const moved = {
            ...generated.nodes[0],
            x: 1234,
            y: 5678,
        };
        const custom = {
            id: "my-note",
            type: "text" as const,
            x: 20,
            y: 30,
            width: 200,
            height: 100,
            text: "Manual annotation",
        };
        const merged = mergeKnowledgeCanvas({ nodes: [moved, custom], edges: [] }, generated);

        expect(merged.nodes.find((node) => node.id === moved.id)).toMatchObject({
            x: 1234,
            y: 5678,
        });
        expect(merged.nodes).toContainEqual(custom);
    });

    it("builds focused Canvas layers and expands a selected deck", () => {
        const areas: KnowledgeArea[] = [
            {
                id: "medicine",
                name: "Medicine",
                deckPaths: ["Medicine/Cardiology"],
                pinned: true,
            },
            {
                id: "languages",
                name: "Languages",
                deckPaths: ["Languages/English"],
                pinned: false,
            },
        ];
        const records = Array.from({ length: 8 }, (_, index) =>
            record({ id: `heart-${index}`, notePath: `Medicine/Heart ${index}.md` }),
        ).concat(
            record({
                id: "english",
                notePath: "Languages/English.md",
                deckNames: ["Languages/English"],
            }),
        );
        const canvas = buildKnowledgeCanvas(
            areas,
            records,
            ["Medicine/Cardiology", "Languages/English"],
            {
                view: {
                    focusAreaId: "medicine",
                    expandedDecks: ["Medicine/Cardiology"],
                    sourceLimit: 2,
                    layers: {
                        filters: false,
                        areas: true,
                        decks: true,
                        sources: true,
                        links: false,
                    },
                },
            },
        );

        expect(
            canvas.nodes.some((node) => node.type === "text" && node.text.includes("Languages")),
        ).toBe(false);
        expect(canvas.nodes.filter((node) => node.type === "file")).toHaveLength(8);
        expect(canvas.nodes.some((node) => node.id.includes("filter"))).toBe(false);
        expect(
            canvas.nodes.some((node) => node.type === "text" && node.text.includes("Expand here")),
        ).toBe(false);
    });

    it("normalizes exact block links for Obsidian previews", () => {
        expect(cardSourceTarget("Medicine/Heart.md", "card-1")).toBe("Medicine/Heart.md#^card-1");
        expect(cardSourceTarget("Medicine/Heart.md", "^card-1")).toBe("Medicine/Heart.md#^card-1");
        expect(cardSourceTarget("Medicine/Heart.md")).toBe("Medicine/Heart.md");
    });
});
