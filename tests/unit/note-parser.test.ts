import { DataStore } from "src/data/data-store/base/data-store";
import { TopicPath } from "src/data/data-structures/deck/topic-path";
import { DEFAULT_SETTINGS } from "src/data/settings";
import { Note } from "src/note/note";
import { NoteParser } from "src/note/note-parser";
import { RepItemScheduleInfoOsr } from "src/scheduling/algorithms/osr/rep-item-schedule-info-osr";
import { setupStaticDateProvider20230906 } from "src/utils/dates";
import { TextDirection } from "src/utils/strings";

import { UnitTestSRFile } from "./helpers/unit-test-file";
import { unitTestSetupStandardDataStoreAlgorithm } from "./helpers/unit-test-setup";

const parser: NoteParser = new NoteParser(DEFAULT_SETTINGS);

beforeAll(() => {
    setupStaticDateProvider20230906();
    unitTestSetupStandardDataStoreAlgorithm(DEFAULT_SETTINGS);
});

describe("Multiple questions in the text", () => {
    test("SingleLineBasic: No schedule info", async () => {
        const noteText: string = `#flashcards/test
Q1::A1
Q2::A2
Q3::A3
`;
        const file: UnitTestSRFile = new UnitTestSRFile(noteText);
        const folderTopicPath = TopicPath.emptyPath;
        const note: Note = await parser.parse(file, TextDirection.Ltr, folderTopicPath);
        const questionList = note.questionList;
        expect(questionList.length).toEqual(3);
    });
});

describe("Stable card identifiers", () => {
    test("adds an Obsidian block ID on first review and preserves it after editing", async () => {
        const file = new UnitTestSRFile("#flashcards/test\nQuestion::Answer\n", "cards.md");
        const note = await parser.parse(file, TextDirection.Ltr, TopicPath.emptyPath);
        const question = note.questionList[0];
        question.cards[0].scheduleInfo = RepItemScheduleInfoOsr.fromDueDateStr(
            "2023-09-10",
            4,
            270,
        );

        await DataStore.getInstance().writeSchedule(question);

        const stableId = question.questionText.obsidianBlockId;
        expect(stableId).toMatch(/^\^sr-data-id-[a-zA-Z0-9-]+$/);
        expect(question.cards[0].storageInfo.questionId).toBe(stableId);
        expect(question.cards[0].stableId).toBe(`${stableId}:0`);
        expect(file.content).toContain(stableId);

        question.questionText.actualQuestion = "Edited question::Edited answer";
        await question.writeQuestion(DEFAULT_SETTINGS);
        const reparsed = await parser.parse(file, TextDirection.Ltr, TopicPath.emptyPath);

        expect(reparsed.questionList[0].questionText.obsidianBlockId).toBe(stableId);
        expect(reparsed.questionList[0].cards[0].storageInfo.questionId).toBe(stableId);
        expect(reparsed.questionList[0].cards[0].stableId).toBe(`${stableId}:0`);
        expect(reparsed.questionList[0].cards[0].scheduleInfo).not.toBeNull();
    });

    test("keeps an existing user block ID", async () => {
        const file = new UnitTestSRFile(
            "#flashcards/test\nQuestion::Answer ^my-card\n",
            "cards.md",
        );
        const note = await parser.parse(file, TextDirection.Ltr, TopicPath.emptyPath);
        const question = note.questionList[0];
        question.cards[0].scheduleInfo = RepItemScheduleInfoOsr.fromDueDateStr(
            "2023-09-10",
            4,
            270,
        );

        await DataStore.getInstance().writeSchedule(question);

        expect(question.questionText.obsidianBlockId).toBe("^my-card");
        expect(question.cards[0].storageInfo.questionId).toBe("^my-card");
        expect(file.content.match(/\^my-card/g)).toHaveLength(1);
    });
});
