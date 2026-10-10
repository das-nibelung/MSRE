import "src/ui/obsidian-ui-components/modals/custom-study-modal.css";
import { App, ButtonComponent, Modal, setIcon } from "obsidian";

import { t } from "src/lang/helpers";
import { CustomStudyOptions } from "src/ui/review-queue-loader";

type CustomStudyDraft = Omit<CustomStudyOptions, "targetDeckPath">;

export class CustomStudyModal extends Modal {
    private draft: CustomStudyDraft = {
        scope: "due",
        limit: 50,
        order: "due-first",
    };

    constructor(
        app: App,
        private readonly deckName: string,
        private readonly targetDeckPath: string[],
        private readonly onStart: (options: CustomStudyOptions) => void | Promise<void>,
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("sr-custom-study-modal");
        const hero = this.contentEl.createDiv("sr-custom-study-hero");
        const icon = hero.createDiv("sr-custom-study-icon");
        setIcon(icon, "sliders-horizontal");
        const copy = hero.createDiv();
        copy.createEl("h2", { text: t("CUSTOM_STUDY") });
        copy.createEl("p", { text: t("CUSTOM_STUDY_DESCRIPTION") });
        copy.createSpan({ text: this.deckName });

        const scope = this.contentEl.createDiv("sr-custom-study-section");
        scope.createEl("h3", { text: t("CUSTOM_STUDY_SCOPE") });
        const scopePicker = scope.createDiv("sr-custom-study-segmented");
        for (const [value, label] of [
            ["due", t("CUSTOM_STUDY_DUE")],
            ["new", t("CUSTOM_STUDY_NEW")],
            ["all", t("CUSTOM_STUDY_ALL")],
        ] as const) {
            const button = new ButtonComponent(scopePicker).setButtonText(label).onClick(() => {
                this.draft.scope = value;
                this.updatePressedState(scopePicker, value);
            });
            button.buttonEl.dataset.value = value;
        }
        this.updatePressedState(scopePicker, this.draft.scope);

        const controls = this.contentEl.createDiv("sr-custom-study-grid");
        const limitGroup = controls.createDiv("sr-custom-study-control");
        limitGroup.createEl("label", { text: t("CUSTOM_STUDY_LIMIT") });
        const limit = limitGroup.createEl("input", {
            attr: { type: "number", min: "1", max: "9999", inputmode: "numeric" },
        });
        limit.value = String(this.draft.limit);
        limit.addEventListener("input", () => {
            this.draft.limit = Math.min(9999, Math.max(1, Number(limit.value) || 1));
        });

        const orderGroup = controls.createDiv("sr-custom-study-control");
        orderGroup.createEl("label", { text: t("CUSTOM_STUDY_ORDER") });
        const order = orderGroup.createEl("select", { cls: "dropdown" });
        order.createEl("option", { value: "due-first", text: t("ORDER_DUE_FIRST") });
        order.createEl("option", { value: "random", text: t("ORDER_RANDOM") });
        order.addEventListener("change", () => {
            this.draft.order = order.value as CustomStudyDraft["order"];
        });

        const actions = this.contentEl.createDiv("sr-custom-study-actions");
        new ButtonComponent(actions).setButtonText(t("CANCEL")).onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText(t("START_CUSTOM_STUDY"))
            .setCta()
            .onClick(async () => {
                await this.onStart({ ...this.draft, targetDeckPath: [...this.targetDeckPath] });
                this.close();
            });
    }

    private updatePressedState(parent: HTMLElement, value: string): void {
        for (const button of parent.querySelectorAll<HTMLButtonElement>("button")) {
            const active = button.dataset.value === value;
            button.toggleClass("is-active", active);
            button.setAttribute("aria-pressed", String(active));
        }
    }
}
