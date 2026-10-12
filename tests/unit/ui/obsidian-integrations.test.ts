import { Card } from "src/data/data-structures/card/card";
import { KnowledgeArea } from "src/data/plugin-data";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";
import { buildKnowledgeCanvas } from "src/ui/obsidian-integrations/knowledge-canvas";
import { cardSourceTarget } from "src/ui/obsidian-integrations/obsidian-links";
import { aggregateStudyBaseEntries } from "src/ui/obsidian-integrations/study-bases-model";

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
                record({ state: "due" }),
                record({ id: "new", state: "new" }),
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
            [record({ state: "due" })],
            ["Medicine/Cardiology", "Languages/English"],
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
        expect(canvas.edges.every((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode))).toBe(
            true,
        );
    });

    it("normalizes exact block links for Obsidian previews", () => {
        expect(cardSourceTarget("Medicine/Heart.md", "card-1")).toBe("Medicine/Heart.md#^card-1");
        expect(cardSourceTarget("Medicine/Heart.md", "^card-1")).toBe("Medicine/Heart.md#^card-1");
        expect(cardSourceTarget("Medicine/Heart.md")).toBe("Medicine/Heart.md");
    });
});
