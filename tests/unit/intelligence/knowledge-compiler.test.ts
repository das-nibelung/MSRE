import { prepareKnowledgeCompilation } from "src/intelligence/knowledge-compiler";

describe("knowledge compiler", () => {
    test("keeps grounded atomic cards and validates a backward dependency graph", () => {
        const source =
            "The sinoatrial node initiates the normal heartbeat. The atrioventricular node delays conduction before the ventricles contract.";
        const result = prepareKnowledgeCompilation(
            {
                summary: "Cardiac conduction",
                cards: [
                    {
                        front: "Which structure initiates the normal heartbeat?",
                        back: "The sinoatrial node.",
                        type: "basic",
                        concept: "Pacemaker",
                        sourceQuote: "The sinoatrial node initiates the normal heartbeat.",
                        confidence: 0.98,
                    },
                    {
                        front: "Why is atrioventricular conduction delayed?",
                        back: "So atrial activation can precede ventricular contraction.",
                        type: "basic",
                        concept: "AV delay",
                        sourceQuote:
                            "The atrioventricular node delays conduction before the ventricles contract.",
                        prerequisiteCardIndexes: [0, 1, 99],
                        prerequisitePaths: ["Medicine/Conduction.md", "Outside.md"],
                        confidence: 0.84,
                    },
                ],
            },
            source,
            ["Medicine/Conduction.md"],
        );

        expect(result.cards).toHaveLength(2);
        expect(result.cards[0]).toMatchObject({ selected: true, grounded: true });
        expect(result.cards[1].prerequisiteCardIndexes).toEqual([0]);
        expect(result.cards[1].prerequisitePaths).toEqual(["Medicine/Conduction.md"]);
        expect(result.dependencyCount).toBe(2);
        expect(result.warnings).toEqual(
            expect.arrayContaining([
                "Card 2 contained an invalid dependency",
                "Card 2 referenced a note outside local context",
            ]),
        );
    });

    test("does not preselect an ungrounded or empty proposal", () => {
        const result = prepareKnowledgeCompilation(
            {
                cards: [
                    {
                        front: "",
                        back: "Invented answer",
                        type: "basic",
                        sourceQuote: "This sentence is not in the source.",
                    },
                ],
            },
            "A short verified source.",
            [],
        );

        expect(result.cards[0]).toMatchObject({ selected: false, grounded: false });
        expect(result.warnings).toEqual(
            expect.arrayContaining([
                "Card 1 has no exact source quote",
                "Card 1 has a blocking quality issue",
            ]),
        );
    });

    test("supports cloze proposals and safe empty-source coverage", () => {
        const result = prepareKnowledgeCompilation(
            {
                cards: [
                    {
                        front: "Water is {{c1::H2O}}.",
                        back: "H2O",
                        type: "cloze",
                        sourceQuote: "",
                    },
                ],
            },
            "",
            [],
        );

        expect(result.summary).toBe("1 atomic knowledge units");
        expect(result.sourceCoverage).toBe(0);
        expect(result.cards[0].prerequisiteCardIndexes).toEqual([]);
        expect(result.cards[0].prerequisitePaths).toEqual([]);
    });
});
