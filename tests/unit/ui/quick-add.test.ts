import { deriveQuickAddSeeds, extractBatchClozeSeeds } from "src/ui/native-creator/quick-add";

describe("Quick Add", () => {
    test("turns a term list into cards", () => {
        expect(
            deriveQuickAddSeeds("- Habeas corpus :: judicial review\n- Mens rea — guilty mind"),
        ).toEqual([
            { front: "Habeas corpus", back: "judicial review", type: "basic" },
            { front: "Mens rea", back: "guilty mind", type: "basic" },
        ]);
    });

    test("turns a markdown table into cards and skips its header", () => {
        expect(deriveQuickAddSeeds("| Term | Answer |\n| --- | --- |\n| ATP | energy |")).toEqual([
            { front: "ATP", back: "energy", type: "basic" },
        ]);
    });

    test("turns heading sections into cards", () => {
        expect(
            deriveQuickAddSeeds("## Consideration\nSomething of value.\n\n## Tort\nA civil wrong."),
        ).toEqual([
            { front: "Consideration", back: "Something of value.", type: "basic" },
            { front: "Tort", back: "A civil wrong.", type: "basic" },
        ]);
    });

    test("creates one cloze card per marked fragment", () => {
        expect(
            extractBatchClozeSeeds(
                "The ==mitral valve== separates the **left atrium** and ventricle.",
            ),
        ).toEqual([
            {
                front: "The mitral valve separates the left atrium and ventricle.",
                back: "mitral valve",
                type: "cloze",
                sourceLabel: "cloze",
            },
            {
                front: "The mitral valve separates the left atrium and ventricle.",
                back: "left atrium",
                type: "cloze",
                sourceLabel: "cloze",
            },
        ]);
    });
});
