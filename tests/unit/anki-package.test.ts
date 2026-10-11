import { describe, expect, test } from "@jest/globals";
import { TextDecoder, TextEncoder } from "node:util";

import {
    AnkiPackage,
    parseAnkiPackage,
    parseDelimited,
    writeAnkiPackage,
    writeDelimited,
} from "src/data/anki/anki-package";

Object.assign(globalThis, { TextDecoder, TextEncoder });

function packageFixture(): AnkiPackage {
    return {
        format: "apkg",
        collectionCreatedAt: Date.UTC(2024, 0, 1),
        models: [
            {
                id: 100,
                name: "Medicine",
                kind: "standard",
                imageOcclusion: false,
                css: ".card { color: white; }",
                fields: [
                    { name: "Question", ordinal: 0 },
                    { name: "Answer", ordinal: 1 },
                ],
                templates: [
                    {
                        name: "Forward",
                        ordinal: 0,
                        questionFormat: "{{Question}}",
                        answerFormat: "{{FrontSide}}<hr>{{Answer}}",
                        deckId: null,
                    },
                ],
                raw: {},
            },
        ],
        decks: [
            {
                id: 200,
                name: "Medicine::Cardiology",
                description: "High yield",
                configId: 1,
                raw: {},
            },
        ],
        deckConfigs: {},
        config: { nextPos: 2 },
        notes: [
            {
                id: 300,
                guid: "stable-guid",
                modelId: 100,
                modifiedAt: Date.UTC(2024, 0, 2),
                tags: ["exam", "heart"],
                fields: ["What is EF?", "Ejection fraction"],
                flags: 0,
                data: "",
                cards: [
                    {
                        id: 400,
                        noteId: 300,
                        deckId: 200,
                        ordinal: 0,
                        type: 2,
                        queue: 2,
                        due: 30,
                        interval: 10,
                        factor: 2500,
                        reps: 4,
                        lapses: 1,
                        left: 0,
                        originalDue: 0,
                        originalDeckId: 0,
                        flags: 2,
                        data: "",
                        reviews: [
                            {
                                id: 1_704_153_600_000,
                                cardId: 400,
                                ease: 3,
                                interval: 10,
                                previousInterval: 4,
                                factor: 2500,
                                durationMs: 4100,
                                type: 1,
                            },
                        ],
                    },
                ],
            },
        ],
        media: { "heart.png": new Uint8Array([137, 80, 78, 71]) },
        warnings: [],
    };
}

describe("Anki package compatibility", () => {
    test("writes and reads a collection without losing core entities", async () => {
        const archive = await writeAnkiPackage(packageFixture());
        const parsed = await parseAnkiPackage(archive);

        expect(parsed.models[0]).toMatchObject({
            name: "Medicine",
            css: ".card { color: white; }",
        });
        expect(parsed.decks[0]).toMatchObject({ name: "Medicine::Cardiology" });
        expect(parsed.notes[0]).toMatchObject({
            guid: "stable-guid",
            tags: ["exam", "heart"],
            fields: ["What is EF?", "Ejection fraction"],
        });
        expect(parsed.notes[0].cards[0]).toMatchObject({ reps: 4, lapses: 1, flags: 2 });
        expect(parsed.notes[0].cards[0].reviews[0]).toMatchObject({ ease: 3, durationMs: 4100 });
        expect([...parsed.media["heart.png"]]).toEqual([137, 80, 78, 71]);
    });

    test("round-trips quoted CSV and TSV cells", () => {
        const rows = [
            ["Question", "Answer"],
            ["Why, exactly?", 'Because "quotes" work\nacross lines'],
        ];
        expect(parseDelimited(writeDelimited(rows, ","), ",")).toEqual(rows);
        expect(parseDelimited(writeDelimited(rows, "\t"), "\t")).toEqual(rows);
    });
});
