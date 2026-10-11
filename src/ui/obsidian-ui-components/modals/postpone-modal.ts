import { App, ButtonComponent, Modal, Setting } from "obsidian";

export class PostponeModal extends Modal {
    private resolve: ((value: number | null) => void) | null = null;
    private settled = false;

    static choose(app: App): Promise<number | null> {
        const modal = new PostponeModal(app);
        return new Promise((resolve) => {
            modal.resolve = resolve;
            modal.open();
        });
    }

    onOpen(): void {
        this.modalEl.addClass("sr-postpone-modal");
        this.contentEl.createEl("h2", { text: "Study this card later" });
        this.contentEl.createEl("p", {
            text: "The card stays in your vault and returns to the queue at the selected time.",
        });
        const presets = this.contentEl.createDiv("sr-postpone-presets");
        for (const [label, minutes] of [
            ["In 15 minutes", 15],
            ["In 1 hour", 60],
            ["This evening", -1],
            ["Tomorrow", -2],
        ] as Array<[string, number]>) {
            new ButtonComponent(presets).setButtonText(label).onClick(() => {
                const date = new Date();
                if (minutes === -1) date.setHours(19, 0, 0, 0);
                else if (minutes === -2) {
                    date.setDate(date.getDate() + 1);
                    date.setHours(9, 0, 0, 0);
                } else date.setMinutes(date.getMinutes() + minutes);
                if (date.getTime() <= Date.now()) date.setDate(date.getDate() + 1);
                this.finish(date.getTime());
            });
        }
        let selected = "";
        new Setting(this.contentEl)
            .setName("Exact time")
            .setDesc("Choose any local date and time.")
            .addText((text) => {
                text.inputEl.type = "datetime-local";
                text.onChange((value) => (selected = value));
            });
        const actions = this.contentEl.createDiv("sr-postpone-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.finish(null));
        new ButtonComponent(actions)
            .setButtonText("Postpone")
            .setCta()
            .onClick(() => {
                const timestamp = Date.parse(selected);
                if (Number.isFinite(timestamp) && timestamp > Date.now()) this.finish(timestamp);
            });
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.settled) {
            this.settled = true;
            this.resolve?.(null);
        }
    }

    private finish(value: number | null): void {
        if (this.settled) return;
        this.settled = true;
        this.resolve?.(value);
        this.close();
    }
}
