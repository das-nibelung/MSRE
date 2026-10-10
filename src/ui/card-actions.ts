import { App, Notice } from "obsidian";

import { DataStore } from "src/data/data-store/base/data-store";
import { Card } from "src/data/data-structures/card/card";
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
    card.scheduleInfo = SRAlgorithm.getInstance().cardGetResetSchedule();
    await DataStore.getInstance().writeSchedule(card.question);
    new Notice(t("CARD_PROGRESS_RESET"));
}
