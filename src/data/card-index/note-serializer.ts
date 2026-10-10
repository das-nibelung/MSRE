import {
    SerializedCard,
    SerializedNote,
    SerializedQuestion,
    SerializedQuestionText,
} from "src/data/card-index/card-index-types";
import { RepItemStorageInfo } from "src/data/data-store/base/rep-item-storage-info";
import { Card } from "src/data/data-structures/card/card";
import { Question, QuestionText } from "src/data/data-structures/card/questions/question";
import {
    TopicPath,
    TopicPathList,
    TopicPathWithWs,
} from "src/data/data-structures/deck/topic-path";
import { ISRNoteTFile } from "src/data/data-structures/file/note-file";
import { Note } from "src/note/note";
import { ParsedQuestionInfo } from "src/parser";
import { RepItemScheduleFactory } from "src/scheduling/algorithms/base/rep-item-info-factory";

function serializeQuestionText(questionText: QuestionText): SerializedQuestionText {
    const topicPathWithWhitespace = questionText.topicPathWithWs
        ? {
              path: [...questionText.topicPathWithWs.topicPath.path],
              preWhitespace: questionText.topicPathWithWs.preWhitespace,
              postWhitespace: questionText.topicPathWithWs.postWhitespace,
          }
        : null;

    return {
        original: questionText.original,
        topicPathWithWhitespace,
        actualQuestion: questionText.actualQuestion,
        textDirection: questionText.textDirection,
        obsidianBlockId: questionText.obsidianBlockId,
    };
}

function serializeCard(card: Card): SerializedCard {
    return {
        front: card.front,
        back: card.back,
        cardIdx: card.cardIdx,
        repetitionPhase: card.repetitionPhase,
        schedule: card.scheduleInfo ? card.scheduleInfo.serializeSchedule() : null,
        storageInfo: card.storageInfo
            ? {
                  notePath: card.storageInfo.notePath,
                  questionHash: card.storageInfo.questionHash,
                  questionId: card.storageInfo.questionId,
              }
            : null,
    };
}

function serializeQuestion(question: Question): SerializedQuestion {
    return {
        parsedQuestionInfo: {
            cardType: question.parsedQuestionInfo.cardType,
            text: question.parsedQuestionInfo.text,
            firstLineNum: question.parsedQuestionInfo.firstLineNum,
            lastLineNum: question.parsedQuestionInfo.lastLineNum,
        },
        topicPaths: question.topicPathList.list.map((topicPath) => [...topicPath.path]),
        topicPathLineNum: question.topicPathList.lineNum,
        questionText: serializeQuestionText(question.questionText),
        questionContext: [...question.questionContext],
        cards: question.cards.map(serializeCard),
    };
}

export function serializeNote(note: Note): SerializedNote {
    return { questions: note.questionList.map(serializeQuestion) };
}

function deserializeQuestionText(value: SerializedQuestionText): QuestionText {
    const topicPathWithWhitespace = value.topicPathWithWhitespace
        ? new TopicPathWithWs(
              new TopicPath([...value.topicPathWithWhitespace.path]),
              value.topicPathWithWhitespace.preWhitespace,
              value.topicPathWithWhitespace.postWhitespace,
          )
        : null;

    return new QuestionText(
        value.original,
        topicPathWithWhitespace,
        value.actualQuestion,
        value.textDirection,
        value.obsidianBlockId,
    );
}

function deserializeCard(value: SerializedCard): Card {
    const card = new Card({
        front: value.front,
        back: value.back,
        cardIdx: value.cardIdx,
        repetitionPhase: value.repetitionPhase,
        scheduleInfo: value.schedule
            ? RepItemScheduleFactory.create(value.schedule.algorithm, value.schedule)
            : null,
        storageInfo: value.storageInfo
            ? new RepItemStorageInfo(
                  value.storageInfo.notePath ?? undefined,
                  value.storageInfo.questionHash ?? undefined,
                  value.storageInfo.questionId ?? undefined,
              )
            : null,
    });
    return card;
}

function deserializeQuestion(value: SerializedQuestion): Question {
    const parsedQuestionInfo = new ParsedQuestionInfo(
        value.parsedQuestionInfo.cardType,
        value.parsedQuestionInfo.text,
        value.parsedQuestionInfo.firstLineNum,
        value.parsedQuestionInfo.lastLineNum,
    );
    const topicPathList = new TopicPathList(
        value.topicPaths.map((path) => new TopicPath([...path])),
        value.topicPathLineNum,
    );
    const question = new Question({
        parsedQuestionInfo,
        topicPathList,
        questionText: deserializeQuestionText(value.questionText),
        questionContext: [...value.questionContext],
        hasChanged: false,
    });
    question.setCardList(value.cards.map(deserializeCard));
    return question;
}

export function deserializeNote(value: SerializedNote, noteFile: ISRNoteTFile): Note {
    return new Note(noteFile, value.questions.map(deserializeQuestion));
}
