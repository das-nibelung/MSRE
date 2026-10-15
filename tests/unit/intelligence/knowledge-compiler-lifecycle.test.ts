import {
    CompilerArtifactSnapshot,
    CompilerProposalSnapshot,
    compilerRenameSimilarity,
    planKnowledgeCompilerDiff,
} from "src/intelligence/knowledge-compiler-lifecycle";
import { knowledgeCompilerKey } from "src/intelligence/knowledge-provenance";

const sourcePath = "Medicine/Heart.md";

function proposal(
    sourceIndex: number,
    concept: string,
    front: string,
    back: string,
    sourceQuote: string,
): CompilerProposalSnapshot {
    return {
        sourceIndex,
        concept,
        front,
        back,
        sourceQuote,
        type: "basic",
        deckPath: "Medicine",
    };
}

function artifact(
    concept: string,
    front: string,
    back: string,
    sourceQuote: string,
    path = `Cards/${concept}.md`,
): CompilerArtifactSnapshot {
    const key = knowledgeCompilerKey(sourcePath, concept);
    return {
        path,
        key,
        conceptId: key,
        concept,
        front,
        back,
        sourceQuote,
        type: "basic",
        deckPath: "Medicine",
        sectionId: "all",
        managed: true,
    };
}

describe("knowledge compiler lifecycle", () => {
    test("shows exact create, update, unchanged, and orphan operations", () => {
        const stable = artifact(
            "Pacemaker",
            "What starts the heartbeat?",
            "SA node",
            "SA node starts the heartbeat.",
        );
        const changed = artifact(
            "AV delay",
            "What delays conduction?",
            "AV node",
            "AV node delays conduction.",
        );
        const orphan = artifact(
            "Purkinje",
            "What conducts rapidly?",
            "Purkinje fibres",
            "Purkinje fibres conduct rapidly.",
        );
        const plan = planKnowledgeCompilerDiff(
            sourcePath,
            [
                proposal(0, "Pacemaker", stable.front, stable.back, stable.sourceQuote),
                proposal(1, "AV delay", changed.front, "The AV node", changed.sourceQuote),
                proposal(
                    2,
                    "Bundle branches",
                    "What divides below the AV bundle?",
                    "Bundle branches",
                    "The AV bundle divides into branches.",
                ),
            ],
            [stable, changed, orphan],
        );

        expect(plan.counts).toEqual({ create: 1, update: 1, rename: 0, unchanged: 1, orphan: 1 });
        expect(plan.items.find((item) => item.kind === "update")?.changes).toEqual([
            { field: "answer", before: "AV node", after: "The AV node" },
        ]);
        expect(plan.items.find((item) => item.kind === "orphan")?.orphanAction).toBe("archive");
    });

    test("recognises a renamed concept by its exact source evidence", () => {
        const previous = artifact(
            "Natural pacemaker",
            "Which structure is the natural pacemaker?",
            "The sinoatrial node",
            "The sinoatrial node initiates each normal heartbeat.",
        );
        const next = proposal(
            0,
            "Sinoatrial node",
            "Which structure initiates a normal heartbeat?",
            "The sinoatrial node",
            previous.sourceQuote,
        );
        const plan = planKnowledgeCompilerDiff(sourcePath, [next], [previous]);

        expect(compilerRenameSimilarity(next, previous)).toBe(1);
        expect(plan.counts.rename).toBe(1);
        expect(plan.counts.create).toBe(0);
        expect(plan.counts.orphan).toBe(0);
        expect(plan.items[0].artifactPath).toBe(previous.path);
    });

    test("does not guess when rename candidates are ambiguous", () => {
        const quote = "Cardiac muscle contains specialised conduction cells.";
        const first = artifact(
            "Conduction A",
            "What cells conduct?",
            "Specialised cells",
            quote,
            "Cards/a.md",
        );
        const second = artifact(
            "Conduction B",
            "What cells conduct?",
            "Specialised cells",
            quote,
            "Cards/b.md",
        );
        const plan = planKnowledgeCompilerDiff(
            sourcePath,
            [proposal(0, "Conduction", "What cells conduct?", "Specialised cells", quote)],
            [first, second],
        );

        expect(plan.counts.create).toBe(1);
        expect(plan.counts.orphan).toBe(2);
        expect(plan.counts.rename).toBe(0);
    });

    test("leaves manual artifacts outside the managed lifecycle", () => {
        const manual = {
            ...artifact("Pacemaker", "Q", "A", "A verified source quote"),
            managed: false,
        };
        const plan = planKnowledgeCompilerDiff(
            sourcePath,
            [proposal(0, "Pacemaker", "Q", "A", "A verified source quote")],
            [manual],
        );

        expect(plan.counts.unchanged).toBe(1);
        expect(plan.counts.create).toBe(0);
        expect(plan.counts.orphan).toBe(0);
    });
});
