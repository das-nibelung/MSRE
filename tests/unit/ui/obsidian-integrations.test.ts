import { Card } from "src/data/data-structures/card/card";
import { KnowledgeArea } from "src/data/plugin-data";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";
import {
    buildKnowledgeCanvas,
    mergeKnowledgeCanvas,
} from "src/ui/obsidian-integrations/knowledge-canvas";
import { cardSourceTarget } from "src/ui/obsidian-integrations/obsidian-links";
import {
    aggregateStudyBaseEntries,
    filterStudyBaseSummaries,
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
                record({ state: "due", retention: 0.7, difficulty: 8, lapses: 3 }),
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
        expect(filterStudyBaseSummaries(summaries, "weak")).toEqual([summaries[0]]);
        expect(summaries[1]).toMatchObject({ total: 1, due: 0, newCards: 0, scheduled: 1 });
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
            },
        );
        const ids = new Set(canvas.nodes.map((node) => node.id));

        expect(ids.size).toBe(canvas.nodes.length);
        expect(
            canvas.nodes.some((node) => node.type === "file" && node.file === "Medicine/Heart.md"),
        ).toBe(true);
        expect(
            canvas.nodes.some(
                (node) => node.type === "text" && node.text.includes("deck=Medicine%2FCardiology"),
            ),
        ).toBe(true);
        expect(
            canvas.nodes.some((node) => node.type === "text" && node.text.includes("Other decks")),
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
