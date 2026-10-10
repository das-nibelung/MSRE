import { IOsrVaultNoteLinkInfoFinder } from "src/scheduling/algorithms/osr/obsidian-vault-notelink-info-finder";
import { OsrNoteGraph } from "src/scheduling/algorithms/osr/osr-note-graph";

class MutableLinkFinder implements IOsrVaultNoteLinkInfoFinder {
    links: Record<string, Record<string, number>> = {};

    getResolvedTargetLinksForNotePath(path: string): Record<string, number> {
        return this.links[path] ?? {};
    }
}

test("replaces and removes links for an incrementally changed note", () => {
    const finder = new MutableLinkFinder();
    const noteGraph = new OsrNoteGraph(finder);
    finder.links["a.md"] = { "b.md": 2 };

    noteGraph.processLinks("a.md");
    noteGraph.processLinks("b.md");
    noteGraph.generatePageRanks();
    expect(noteGraph.incomingLinks["b.md"]).toEqual([{ sourcePath: "a.md", linkCount: 2 }]);

    finder.links["a.md"] = { "c.md": 1 };
    noteGraph.processLinks("a.md");
    noteGraph.generatePageRanks();
    expect(noteGraph.incomingLinks["b.md"]).toEqual([]);
    expect(noteGraph.incomingLinks["c.md"]).toEqual([{ sourcePath: "a.md", linkCount: 1 }]);

    noteGraph.removePath("a.md");
    noteGraph.generatePageRanks();
    expect(noteGraph.incomingLinks["c.md"]).toBeUndefined();
});
