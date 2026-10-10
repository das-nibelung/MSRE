import { DataStore } from "src/data/data-store/base/data-store";
import { DataStoreAlgorithm } from "src/data/data-store/base/data-store-algorithm";
import { NoteDataStoreAlgorithmOsr } from "src/data/data-store/notes-data-store/note-data-store-algorithm-osr";
import { NotesDataStore } from "src/data/data-store/notes-data-store/notes-data-store";
import {
    extractStableQuestionIds,
    ScheduleLedger,
    ScheduleLedgerStorage,
} from "src/data/data-store/schedule-ledger";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { DEFAULT_SETTINGS } from "src/data/settings";
import { NoteParser } from "src/note/note-parser";
import { RepItemScheduleInfoOsr } from "src/scheduling/algorithms/osr/rep-item-schedule-info-osr";
import { setupStaticDateProvider20230906 } from "src/utils/dates";
import { TextDirection } from "src/utils/strings";

import { UnitTestSRFile } from "../../helpers/unit-test-file";
import { UnitTestFileModifier } from "../../helpers/unit-test-file-modifiers";

class MemoryScheduleLedgerStorage implements ScheduleLedgerStorage {
    content: string | null = null;

    read(): Promise<string | null> {
        return Promise.resolve(this.content);
    }

    write(content: string): Promise<void> {
        this.content = content;
        return Promise.resolve();
    }
}

beforeAll(() => setupStaticDateProvider20230906());

test("persists and restores sibling schedules by stable question ID", async () => {
    const storage = new MemoryScheduleLedgerStorage();
    const ledger = new ScheduleLedger(storage);
    const schedule = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-10", 4, 270);

    await ledger.setSchedules("^stable-question", [schedule, null]);
    const restored = new ScheduleLedger(storage);
    await restored.initialize();

    expect(restored.getSchedules("^stable-question")?.[0]).toMatchObject({
        interval: 4,
        latestEase: 270,
    });
    expect(restored.getSchedules("^stable-question")?.[1]).toBeNull();
    expect(storage.content).toContain("# MSRE schedule data");
});

test("restores a missing inline schedule while Markdown remains authoritative", async () => {
    const storage = new MemoryScheduleLedgerStorage();
    const ledger = new ScheduleLedger(storage);
    await ledger.setSchedules("^stable-question", [
        RepItemScheduleInfoOsr.fromDueDateStr("2023-09-10", 4, 270),
    ]);
    DataStore.instance = new NotesDataStore(DEFAULT_SETTINGS, new UnitTestFileModifier(), ledger);
    DataStoreAlgorithm.instance = new NoteDataStoreAlgorithmOsr(DEFAULT_SETTINGS);

    const note = await new NoteParser(DEFAULT_SETTINGS).parse(
        new UnitTestSRFile("#flashcards/test\nQuestion::Answer ^stable-question\n", "cards.md"),
        TextDirection.Ltr,
        TopicPath.emptyPath,
    );

    expect(note.questionList[0].cards[0].scheduleInfo).toMatchObject({
        interval: 4,
        latestEase: 270,
    });
});

test("backs up a reviewed card through the notes data store", async () => {
    const storage = new MemoryScheduleLedgerStorage();
    const ledger = new ScheduleLedger(storage);
    const dataStore = new NotesDataStore(DEFAULT_SETTINGS, new UnitTestFileModifier(), ledger);
    DataStore.instance = dataStore;
    DataStoreAlgorithm.instance = new NoteDataStoreAlgorithmOsr(DEFAULT_SETTINGS);
    const file = new UnitTestSRFile("#flashcards/test\nQuestion::Answer\n", "cards.md");
    const note = await new NoteParser(DEFAULT_SETTINGS).parse(
        file,
        TextDirection.Ltr,
        TopicPath.emptyPath,
    );
    const question = note.questionList[0];
    question.cards[0].scheduleInfo = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-10", 4, 270);

    await dataStore.writeSchedule(question);

    expect(ledger.getSchedules(question.questionText.obsidianBlockId)?.[0]).toMatchObject({
        interval: 4,
        latestEase: 270,
    });
    expect(storage.content).toContain(question.questionText.obsidianBlockId);
});

test("deletions and full clears prevent schedules from being restored", async () => {
    const storage = new MemoryScheduleLedgerStorage();
    const ledger = new ScheduleLedger(storage);
    const schedule = RepItemScheduleInfoOsr.fromDueDateStr("2023-09-10", 4, 270);
    await ledger.setSchedules("^one", [schedule]);
    await ledger.setSchedules("^two", [schedule]);

    await ledger.delete("^one");
    expect(ledger.getSchedules("^one")).toBeNull();
    expect(ledger.getSchedules("^two")).not.toBeNull();

    await ledger.clear();
    const restored = new ScheduleLedger(storage);
    await restored.initialize();
    expect(restored.getSchedules("^two")).toBeNull();
});

test("extracts only block IDs placed at the end of a Markdown line", () => {
    expect(
        extractStableQuestionIds(
            "Question::Answer ^card-one\nNot ^inline text\nAnother::Card ^sr-data-id-two",
        ),
    ).toEqual(["^card-one", "^sr-data-id-two"]);
});
