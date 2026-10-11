import { Menu } from "obsidian";

import { CardFlag } from "src/data/collection/collection-types";
import { t } from "src/lang/helpers";
import MenuButtonComponent from "src/ui/obsidian-ui-components/content-container/menu-button";

export default class CardMenuButtonComponent extends MenuButtonComponent {
    private isResetButtonDisabled: boolean;
    public constructor(
        container: HTMLElement,
        isExtended: boolean,
        showDeleteButton: boolean,
        isModal: boolean,
        isResetButtonDisabled: boolean,
        deleteCurrentCard: () => void,
        editClickHandler: () => void,
        jumpToCurrentCard: () => Promise<void>,
        displayCurrentCardInfoNotice: () => void,
        buryCurrentCard: () => Promise<void>,
        postponeCurrentCard: () => Promise<void>,
        suspendCurrentCard: () => Promise<void>,
        setCurrentCardFlag: (flag: CardFlag) => Promise<void>,
        skipCurrentCard: () => void,
        onOpenResetModalClick: () => void,
        closeModal?: () => void,
        classNames?: string[],
    ) {
        super(
            container,
            (evt: MouseEvent) => {
                const cardMenu = new Menu();

                this.buildMenu(
                    cardMenu,
                    showDeleteButton,
                    isModal,
                    isExtended,
                    editClickHandler,
                    onOpenResetModalClick,
                    skipCurrentCard,
                    jumpToCurrentCard,
                    displayCurrentCardInfoNotice,
                    buryCurrentCard,
                    postponeCurrentCard,
                    suspendCurrentCard,
                    setCurrentCardFlag,
                    deleteCurrentCard,
                    closeModal,
                );

                cardMenu.showAtMouseEvent(evt);
            },
            classNames,
        );
        this.isResetButtonDisabled = isResetButtonDisabled;
    }

    public setResetButtonDisabled(disabled: boolean) {
        this.isResetButtonDisabled = disabled;
    }

    private buildMenu(
        cardMenu: Menu,
        showDeleteButton: boolean,
        isModal: boolean,
        isExtended: boolean,
        editClickHandler: () => void,
        onOpenResetModalClick: () => void,
        skipCurrentCard: () => void,
        jumpToCurrentCard: () => Promise<void>,
        displayCurrentCardInfoNotice: () => void,
        buryCurrentCard: () => Promise<void>,
        postponeCurrentCard: () => Promise<void>,
        suspendCurrentCard: () => Promise<void>,
        setCurrentCardFlag: (flag: CardFlag) => Promise<void>,
        deleteCurrentCard: () => void,
        closeModal?: () => void,
    ) {
        if (isExtended) {
            cardMenu.addItem((item) => {
                item.setTitle(t("EDIT_CARD"))
                    .setIcon("pencil")
                    .onClick(() => {
                        editClickHandler();
                    });
            });
            cardMenu.addItem((item) => {
                item.setTitle(t("RESET_CARD_PROGRESS"))
                    .setIcon("reset")
                    .onClick(() => {
                        onOpenResetModalClick();
                    })
                    .setDisabled(this.isResetButtonDisabled);
            });
            cardMenu.addItem((item) => {
                item.setTitle(t("SKIP"))
                    .setIcon("chevrons-right")
                    .onClick(() => {
                        skipCurrentCard();
                    });
            });
        }

        if (isModal) {
            cardMenu.addItem((item) => {
                item.setTitle(t("OPEN_IN_BACKGROUND"))
                    .setIcon("send-to-back")
                    .onClick(async () => {
                        // Doesn't close modal, just opens in background and focuses
                        await jumpToCurrentCard();
                    });
            });
            cardMenu.addItem((item) => {
                item.setTitle(t("JUMP_TO_AND_CLOSE"))
                    .setIcon("arrow-up-right")
                    .onClick(async () => {
                        await jumpToCurrentCard();
                        if (closeModal) {
                            closeModal();
                        }
                    });
            });
        } else {
            cardMenu.addItem((item) => {
                item.setTitle(t("JUMP_TO"))
                    .setIcon("arrow-up-right")
                    .onClick(async () => {
                        await jumpToCurrentCard();
                    });
            });
        }
        cardMenu.addItem((item) => {
            item.setTitle(t("VIEW_CARD_INFO"))
                .setIcon("info")
                .onClick(() => {
                    displayCurrentCardInfoNotice();
                });
        });
        cardMenu.addItem((item) => {
            item.setTitle(t("BURY_SIBLINGS"))
                .setIcon("moon")
                .onClick(() => void buryCurrentCard());
        });
        cardMenu.addItem((item) => {
            item.setTitle("Postpone…")
                .setIcon("clock-3")
                .onClick(() => void postponeCurrentCard());
        });
        cardMenu.addItem((item) => {
            item.setTitle(t("SUSPEND_CARD"))
                .setIcon("pause-circle")
                .onClick(() => void suspendCurrentCard());
        });
        cardMenu.addItem((item) => {
            item.setTitle(t("FLAG_CURRENT_CARD"))
                .setIcon("flag")
                .onClick((event) => this.openFlagMenu(event, setCurrentCardFlag));
        });
        if (showDeleteButton) {
            cardMenu.addSeparator();
            cardMenu.addItem((item) => {
                item.setTitle(t("DELETE_CARD"))
                    .setIcon("trash")
                    .setWarning(true)
                    .onClick(() => {
                        deleteCurrentCard();
                    });
            });
        }
    }

    private openFlagMenu(
        event: MouseEvent | KeyboardEvent,
        setCurrentCardFlag: (flag: CardFlag) => Promise<void>,
    ): void {
        const menu = new Menu();
        const labels = [
            t("NO_FLAG"),
            t("FLAG_RED"),
            t("FLAG_ORANGE"),
            t("FLAG_GREEN"),
            t("FLAG_BLUE"),
            t("FLAG_PINK"),
            t("FLAG_TURQUOISE"),
            t("FLAG_PURPLE"),
        ];
        for (const value of [0, 1, 2, 3, 4, 5, 6, 7] as CardFlag[]) {
            menu.addItem((item) =>
                item
                    .setTitle(labels[value])
                    .setIcon(value === 0 ? "x" : "flag")
                    .onClick(() => void setCurrentCardFlag(value)),
            );
        }
        if (event instanceof MouseEvent) menu.showAtMouseEvent(event);
        else
            menu.showAtPosition({
                x: activeWindow.innerWidth / 2,
                y: activeWindow.innerHeight / 2,
            });
    }
}
