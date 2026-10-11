import { CollectionData } from "src/data/collection/collection-types";
import { KnowledgeArea } from "src/data/plugin-data";
import {
    createSemanticDocuments,
    createSemanticIndexStorage,
    embedSemanticText,
    LocalSemanticIndex,
    MemorySemanticIndexStorage,
    SemanticDocument,
    SemanticIndexService,
} from "src/data/semantic/local-semantic-index";

function item(id: string, text: string, deckPath: string, tags: string[] = []): SemanticDocument {
    return {
        id,
        text,
        title: text,
        sourcePath: `${id}.md`,
        deckPaths: [deckPath],
        tags,
        areaIds: deckPath === "Medicine/Cardiology" ? ["medicine"] : [],
        updatedAt: 1,
    };
}

describe("local semantic index", () => {
    test("ranks related multilingual notes without a network model", () => {
        const index = new LocalSemanticIndex();
        index.sync([
            item(
                "heart",
                "Сердечный выброс равен ударному объёму, умноженному на частоту сердечных сокращений",
                "Medicine/Cardiology",
                ["physiology"],
            ),
            item(
                "kidney",
                "Скорость клубочковой фильтрации описывает функцию почек",
                "Medicine/Nephrology",
            ),
        ]);

        expect(index.search("сердечный выброс и частота", { limit: 1 })[0].item.id).toBe("heart");
    });

    test("only rebuilds changed documents and removes deleted ones", () => {
        const index = new LocalSemanticIndex();
        const first = item("one", "alpha beta gamma", "Deck");
        expect(index.sync([first])).toEqual({
            added: ["one"],
            updated: [],
            removed: [],
            unchanged: 0,
        });
        expect(index.sync([first]).unchanged).toBe(1);

        const changed = { ...first, text: "alpha beta delta", updatedAt: 2 };
        expect(index.sync([changed]).updated).toEqual(["one"]);
        expect(index.sync([]).removed).toEqual(["one"]);
    });

    test("finds near duplicates and derives organizer suggestions", () => {
        const index = new LocalSemanticIndex();
        index.sync([
            item(
                "one",
                "What is cardiac output? Cardiac output is stroke volume times heart rate.",
                "Medicine/Cardiology",
                ["physiology"],
            ),
            item(
                "two",
                "Cardiac output equals stroke volume multiplied by heart rate.",
                "Medicine/Cardiology",
                ["physiology"],
            ),
        ]);

        expect(index.findNearDuplicateGroups(0.5).flat()).toEqual(
            expect.arrayContaining(["one", "two"]),
        );
        const suggestions = index.suggest("cardiac output and stroke volume");
        expect(suggestions.decks[0]?.value).toBe("Medicine/Cardiology");
        expect(suggestions.tags[0]?.value).toBe("physiology");
        expect(suggestions.areas[0]?.value).toBe("medicine");
    });

    test("supports related items, concept clusters, snapshots and clearing", () => {
        const index = new LocalSemanticIndex();
        index.sync([
            item("one", "alpha beta gamma delta", "A"),
            item("two", "alpha beta gamma epsilon", "A"),
            item("three", "completely unrelated material", "B"),
        ]);

        expect(index.related("one", 1)[0]?.item.id).toBe("two");
        expect(index.related("missing")).toEqual([]);
        expect(index.clusterConcepts(0.3).flat()).toEqual(expect.arrayContaining(["one", "two"]));
        expect(index.getRecord("one")?.vector).not.toBe(index.getRecords()[0].vector);
        expect(index.search("   ")).toEqual([]);
        expect(embedSemanticText("   ").every((value) => value === 0)).toBe(true);

        const records = index.getRecords();
        index.clear();
        expect(index.size).toBe(0);
        index.load([
            ...records,
            { ...records[0], id: "old", schemaVersion: 0 },
            { ...records[0], id: "wrong-vector", vector: [1] },
        ]);
        expect(index.size).toBe(3);
    });

    test("creates note documents with inherited knowledge-area matches", () => {
        const collection: CollectionData = {
            schemaVersion: 12,
            revision: 1,
            updatedAt: 1,
            noteTypes: {},
            deckOptions: {},
            decks: {},
            notes: {
                note: {
                    id: "note",
                    noteTypeId: "basic",
                    fields: { front: "Cardiac output", back: "Stroke volume × heart rate" },
                    tags: ["physiology"],
                    source: { kind: "managed", path: "Cards/heart.md", questionId: "q1" },
                    createdAt: 1,
                    updatedAt: 2,
                },
                deleted: {
                    id: "deleted",
                    noteTypeId: "basic",
                    fields: { front: "Deleted" },
                    tags: [],
                    source: { kind: "managed", path: "Cards/deleted.md", questionId: null },
                    createdAt: 1,
                    updatedAt: 2,
                    deletedAt: 3,
                },
            },
            cards: {
                card: {
                    id: "card",
                    noteId: "note",
                    templateId: "forward",
                    variantId: "base",
                    stableKey: "note:forward:base",
                    ordinal: 0,
                    deckId: "cardiology",
                    deckPath: "Medicine/Cardiology/Physiology",
                    state: "active",
                    buriedUntil: null,
                    flag: 0,
                    queue: "new",
                    schedule: null,
                    reps: 0,
                    lapses: 0,
                    lastReviewAt: null,
                    legacyStableId: null,
                    createdAt: 1,
                    updatedAt: 2,
                },
            },
            editHistory: {},
            conflicts: {},
        };
        const areas: KnowledgeArea[] = [
            {
                id: "medicine",
                name: "Medicine",
                deckPaths: ["Medicine"],
                pinned: false,
            },
        ];

        expect(createSemanticDocuments(collection, areas)).toEqual([
            expect.objectContaining({
                id: "note",
                areaIds: ["medicine"],
                deckPaths: ["Medicine/Cardiology/Physiology"],
                title: "cardiac output",
            }),
        ]);
    });

    test("persists, incrementally refreshes and deletes the derived index", async () => {
        const storage = new MemorySemanticIndexStorage();
        const service = new SemanticIndexService(storage);
        const empty: CollectionData = {
            schemaVersion: 12,
            revision: 0,
            updatedAt: 0,
            noteTypes: {},
            deckOptions: {},
            decks: {},
            notes: {},
            cards: {},
            editHistory: {},
            conflicts: {},
        };
        await service.initialize(empty, []);
        expect(service.status).toEqual({ ready: true, documents: 0 });

        const populated = JSON.parse(JSON.stringify(empty)) as CollectionData;
        populated.notes.note = {
            id: "note",
            noteTypeId: "basic",
            fields: { front: "Mitochondria", back: "Produces ATP" },
            tags: ["biology"],
            source: { kind: "managed", path: "note.md", questionId: null },
            createdAt: 1,
            updatedAt: 1,
        };
        const result = await service.refresh(populated, []);
        expect(result.added).toEqual(["note"]);
        expect(service.search("ATP")[0]?.item.id).toBe("note");
        expect(service.findNearDuplicateGroups()).toEqual([]);
        expect(service.clusterConcepts()).toEqual([]);
        expect(service.suggest("ATP").tags[0]?.value).toBe("biology");
        expect((await storage.getAll()).length).toBe(1);

        await service.clear();
        expect(service.status).toEqual({ ready: false, documents: 0 });
        expect(await storage.getAll()).toEqual([]);
        service.close();
    });

    test("uses the in-memory storage factory when IndexedDB is unavailable", async () => {
        const storage = createSemanticIndexStorage("test-semantic-index");
        expect(await storage.getAll()).toEqual([]);
        await storage.clear();
        storage.close();
    });
});
