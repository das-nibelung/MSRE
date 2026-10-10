import { App, Notice } from "obsidian";

import { DataStore } from "src/data/data-store/base/data-store";
import { Card } from "src/data/data-structures/card/card";
import { IQuestionPostponementList } from "src/data/data-structures/card/questions/question-postponement-list";
import { CardFrontBackUtil } from "src/data/data-structures/card/questions/question-type";
import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import { SRAlgorithm } from "src/scheduling/algorithms/base/sr-algorithm";
import { FlashcardEditModal } from "src/ui/obsidian-ui-components/modals/edit-modal";

export async function editCardFromBrowser(
    app: App,
    settings: SRSettings,
    card: Card,
): Promise<boolean> {
    const question = card.question;
    let modifiedText: string;
    try {
        modifiedText = await FlashcardEditModal.Prompt(
            app,
            settings,
            card,
            question.questionText.actualQuestion,
            question.questionText.textDirection,
        );
    } catch {
        return false;
    }

    const cardFrontBackList = CardFrontBackUtil.expand(
        question.questionType,
        modifiedText,
        settings,
    );
    if (cardFrontBackList.length !== question.cards.length) {
        new Notice(t("CARD_EDIT_CARD_COUNT_CHANGED"));
        return false;
    }

    question.questionText.actualQuestion = modifiedText;
    await question.writeQuestion(settings);
    question.cards.forEach((questionCard, index) => {
        questionCard.front = cardFrontBackList[index].front;
        questionCard.back = cardFrontBackList[index].back;
    });
    new Notice(t("CARD_UPDATED"));
    return true;
}

export async function resetCardProgress(card: Card): Promise<void> {
    await resetCardsProgress([card]);
}

export async function resetCardsProgress(cards: Card[]): Promise<number> {
    const scheduledCards = [...new Set(cards)].filter((card) => card.hasSchedule);
    const questions = new Set(scheduledCards.map((card) => card.question));
    for (const card of scheduledCards) {
        card.scheduleInfo = SRAlgorithm.getInstance().cardGetResetSchedule();
    }
    // Write once per question so reversed and cloze siblings keep one consistent schedule block.
    for (const question of questions) {
        await DataStore.getInstance().writeSchedule(question);
    }
    if (scheduledCards.length === 1) {
        new Notice(t("CARD_PROGRESS_RESET"));
    } else if (scheduledCards.length > 1) {
        new Notice(t("CARD_PROGRESS_RESET_COUNT", { count: scheduledCards.length }));
    }
    return scheduledCards.length;
}

export async function buryCardsUntilTomorrow(
    cards: Card[],
    postponementList: IQuestionPostponementList,
): Promise<number> {
    const questions = [...new Set(cards.map((card) => card.question))].filter(
        (question) => !postponementList.includes(question),
    );
    for (const question of questions) {
        postponementList.add(question);
    }
    if (questions.length > 0) {
        await postponementList.write();
        new Notice(
            questions.length === 1
                ? t("CARD_BURIED_UNTIL_TOMORROW")
                : t("CARDS_BURIED_UNTIL_TOMORROW", { count: questions.length }),
        );
    }
    return questions.length;
}
