import { MemoryCardIndexStorage } from "src/data/card-index/card-index-storage";
import {
    getCardIndexSettingsFingerprint,
    IncrementalCardIndex,
} from "src/data/card-index/incremental-card-index";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { DEFAULT_SETTINGS, SRSettings } from "src/data/settings";
import { Note } from "src/note/note";
import { NoteFileLoader } from "src/note/note-file-loader";
import { TextDirection } from "src/utils/strings";

import { UnitTestSRFile } from "../../helpers/unit-test-file";
import { unitTestSetupStandardDataStoreAlgorithm } from "../../helpers/unit-test-setup";

const revision = { mtime: 1234, size: 200 };

beforeAll(() => {
    unitTestSetupStandardDataStoreAlgorithm(DEFAULT_SETTINGS);
});

async function createNote(file: UnitTestSRFile): Promise<Note> {
    const loader = new NoteFileLoader(DEFAULT_SETTINGS);
    return await loader.load(file, TextDirection.Ltr, TopicPath.emptyPath);
}

describe("IncrementalCardIndex", () => {
    test("restores parsed cards without reading the Markdown file", async () => {
        const storage = new MemoryCardIndexStorage();
        const index = new IncrementalCardIndex(DEFAULT_SETTINGS, storage);
        const file = new UnitTestSRFile(
            `#flashcards/language
Question::Answer
Reverse:::Back ^stable-card
<!--SR:!2025-01-20,4,270-->
`,
            "Deck/card.md",
        );
        const parsed = await createNote(file);

        await index.put(file, revision, parsed);
        file.read = () => Promise.reject(new Error("cache hit must not read the Markdown file"));

        const restored = await index.get(file, revision);

        expect(restored).toBeDefined();
        expect(restored.file).toBe(file);
        expect(restored.questionList).toHaveLength(2);
        expect(restored.questionList[0].topicPathList.format("/")).toBe("#flashcards/language");
        expect(restored.questionList[0].cards[0].front).toBe("Question");
        expect(restored.questionList[0].cards[0].back).toBe("Answer");
        expect(restored.questionList[1].cards).toHaveLength(2);
        expect(restored.questionList[1].cards[0].formatSchedule()).toContain("2025-01-20");
        expect(restored.questionList[1].cards[0].storageInfo.questionId).toBe("^stable-card");
        expect(restored.questionList[1].cards[0].question).toBe(restored.questionList[1]);
        expect(restored.questionList[1].note).toBe(restored);
        expect(index.getStats()).toEqual({ hits: 1, misses: 0, writes: 1 });
    });

    test("misses when the file revision changes and removes invalidated entries", async () => {
        const storage = new MemoryCardIndexStorage();
        const index = new IncrementalCardIndex(DEFAULT_SETTINGS, storage);
        const file = new UnitTestSRFile("#flashcards\nQ::A", "Deck/card.md");
        await index.put(file, revision, await createNote(file));

        expect(await index.get(file, { ...revision, mtime: revision.mtime + 1 })).toBeUndefined();
        const changeToken = index.getChangeToken();
        const invalidation = index.invalidate(file.path);
        expect(index.hasPendingChanges()).toBe(true);
        expect(await index.get(file, revision)).toBeUndefined();
        await invalidation;
        index.markSynchronized(changeToken);
        expect(index.hasPendingChanges()).toBe(true);
        index.markSynchronized(index.getChangeToken());
        expect(index.hasPendingChanges()).toBe(false);
    });

    test("invalidates cached parsing when parser settings change", async () => {
        const storage = new MemoryCardIndexStorage();
        const originalIndex = new IncrementalCardIndex(DEFAULT_SETTINGS, storage);
        const file = new UnitTestSRFile("#flashcards\nQ::A", "Deck/card.md");
        await originalIndex.put(file, revision, await createNote(file));

        const changedSettings: SRSettings = {
            ...DEFAULT_SETTINGS,
            singleLineCardSeparator: "=>",
        };
        const changedIndex = new IncrementalCardIndex(changedSettings, storage);

        expect(getCardIndexSettingsFingerprint(changedSettings)).not.toBe(
            getCardIndexSettingsFingerprint(DEFAULT_SETTINGS),
        );
        expect(await changedIndex.get(file, revision)).toBeUndefined();
        expect(changedIndex.setContext(DEFAULT_SETTINGS, TextDirection.Ltr)).toBe(true);
        expect(changedIndex.setContext(DEFAULT_SETTINGS, TextDirection.Ltr)).toBe(false);
    });

    test("prunes entries for files that no longer exist", async () => {
        const storage = new MemoryCardIndexStorage();
        const index = new IncrementalCardIndex(DEFAULT_SETTINGS, storage);
        const existing = new UnitTestSRFile("#flashcards\nQ::A", "existing.md");
        const deleted = new UnitTestSRFile("#flashcards\nX::Y", "deleted.md");
        await index.put(existing, revision, await createNote(existing));
        await index.put(deleted, revision, await createNote(deleted));

        await index.prune(new Set([existing.path]));

        expect(await index.get(existing, revision)).toBeDefined();
        expect(await index.get(deleted, revision)).toBeUndefined();
    });
});
