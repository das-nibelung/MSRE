import {
    ButtonComponent,
    ItemView,
    Modal,
    Notice,
    setIcon,
    Setting,
    WorkspaceLeaf,
} from "obsidian";

import { REMINDER_CENTER_VIEW_TYPE } from "src/data/constants";
import { NativeCardStore } from "src/data/native-card-store";
import { ReminderHistoryEntry } from "src/data/plugin-data";
import {
    ReviewReminderRule,
    ReviewReminderScope,
    ReviewReminderSmartMode,
} from "src/data/settings";
import type SRPlugin from "src/main";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function newRule(): ReviewReminderRule {
    return {
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: "Focused review",
        enabled: true,
        scope: "deck",
        scopeValue: "",
        days: [0, 1, 2, 3, 4, 5, 6],
        times: ["18:00"],
        minimumCards: 1,
        cooldownMinutes: 120,
        smartMode: "none",
        message: "",
    };
}

class ReminderRuleModal extends Modal {
    private draft: ReviewReminderRule;

    constructor(
        private readonly plugin: SRPlugin,
        rule: ReviewReminderRule | null,
        private readonly onSave: (rule: ReviewReminderRule) => void,
    ) {
        super(plugin.app);
        this.draft = structuredClone(rule ?? newRule());
    }

    onOpen(): void {
        this.modalEl.addClass("sr-reminder-rule-modal");
        this.contentEl.createEl("h2", { text: "Reminder rule" });
        this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: "A focused signal for one deck, one knowledge area, or the complete collection.",
        });
        new Setting(this.contentEl)
            .setName("Name")
            .addText((text) =>
                text.setValue(this.draft.name).onChange((value) => (this.draft.name = value)),
            );
        new Setting(this.contentEl)
            .setName("Enabled")
            .addToggle((toggle) =>
                toggle
                    .setValue(this.draft.enabled)
                    .onChange((value) => (this.draft.enabled = value)),
            );

        const target = new Setting(this.contentEl).setName("Scope");
        target.addDropdown((dropdown) =>
            dropdown
                .addOptions({ all: "All cards", deck: "Deck", area: "Knowledge area" })
                .setValue(this.draft.scope)
                .onChange((value) => {
                    this.draft.scope = value as ReviewReminderScope;
                    this.draft.scopeValue = "";
                    this.renderTarget(target);
                }),
        );
        this.renderTarget(target);

        const days = new Setting(this.contentEl)
            .setName("Days")
            .setDesc("Choose the days on which this rule can fire.");
        const dayStrip = days.controlEl.createDiv("sr-reminder-day-strip");
        DAY_NAMES.forEach((name, index) => {
            const button = dayStrip.createEl("button", { text: name });
            button.toggleClass("is-active", this.draft.days.includes(index));
            button.addEventListener("click", () => {
                if (this.draft.days.includes(index)) {
                    this.draft.days = this.draft.days.filter((day) => day !== index);
                } else this.draft.days.push(index);
                button.toggleClass("is-active", this.draft.days.includes(index));
            });
        });
        new Setting(this.contentEl)
            .setName("Times")
            .setDesc("Comma-separated local times, for example 09:00, 18:30.")
            .addText((text) =>
                text.setValue(this.draft.times.join(", ")).onChange((value) => {
                    this.draft.times = value
                        .split(",")
                        .map((time) => time.trim())
                        .filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time));
                }),
            );
        new Setting(this.contentEl).setName("Minimum ready cards").addText((text) => {
            text.inputEl.type = "number";
            text.setValue(String(this.draft.minimumCards)).onChange(
                (value) => (this.draft.minimumCards = Math.max(1, Number(value) || 1)),
            );
        });
        new Setting(this.contentEl).setName("Cooldown, minutes").addText((text) => {
            text.inputEl.type = "number";
            text.setValue(String(this.draft.cooldownMinutes)).onChange(
                (value) => (this.draft.cooldownMinutes = Math.max(1, Number(value) || 120)),
            );
        });
        new Setting(this.contentEl)
            .setName("Intelligent condition")
            .setDesc("The reminder fires only when this condition is true.")
            .addDropdown((dropdown) =>
                dropdown
                    .addOptions({
                        none: "Ready cards exist",
                        overload: "Daily load exceeded",
                        forecast: "Heavy forecast",
                        deadline: "Area deadline at risk",
                        weak: "Weak cards detected",
                    })
                    .setValue(this.draft.smartMode)
                    .onChange((value) => (this.draft.smartMode = value as ReviewReminderSmartMode)),
            );
        new Setting(this.contentEl)
            .setName("Message")
            .setDesc("Optional variables: {due}, {new}, {forecast}, {minutes}.")
            .addTextArea((text) =>
                text.setValue(this.draft.message).onChange((value) => (this.draft.message = value)),
            );
        const actions = this.contentEl.createDiv("sr-reminder-modal-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText("Save rule")
            .setCta()
            .onClick(() => {
                if (!this.draft.days.length || !this.draft.name.trim()) {
                    new Notice("Choose at least one day and enter a rule name");
                    return;
                }
                if (this.draft.scope !== "all" && !this.draft.scopeValue) {
                    new Notice("Choose a deck or knowledge area");
                    return;
                }
                this.onSave(this.draft);
                this.close();
            });
    }

    private renderTarget(setting: Setting): void {
        setting.controlEl.querySelector(".sr-reminder-target")?.remove();
        if (this.draft.scope === "all") return;
        const select = setting.controlEl.createEl("select", {
            cls: "dropdown sr-reminder-target",
        });
        select.createEl("option", { value: "", text: "Choose…" });
        const values =
            this.draft.scope === "deck"
                ? new NativeCardStore(this.plugin).getDeckPaths().map((path) => ({
                      value: path,
                      label: path,
                  }))
                : this.plugin.dataManager.data.knowledgeAreas
                      .filter((area) => !area.archivedAt)
                      .map((area) => ({ value: area.name, label: area.name }));
        values.forEach((item) =>
            select.createEl("option", { value: item.value, text: item.label }),
        );
        select.value = this.draft.scopeValue;
        select.addEventListener("change", () => (this.draft.scopeValue = select.value));
    }
}

export class ReminderCenterView extends ItemView {
    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
    }

    getViewType(): string {
        return REMINDER_CENTER_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Reminder Center";
    }

    getIcon(): string {
        return "bell-ring";
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass("sr-reminder-center");
        this.render();
        return Promise.resolve();
    }

    refresh(): void {
        if (this.contentEl.isShown()) this.render();
    }

    private render(): void {
        this.contentEl.empty();
        const settings = this.plugin.dataManager.data.settings;
        const state = this.plugin.dataManager.data.reminderState;
        const evaluation = this.plugin.reminderManager.getEvaluation(false);
        const header = this.contentEl.createDiv("sr-reminder-center-header");
        const title = header.createDiv();
        title.createEl("h2", { text: "Reminder Center" });
        title.createSpan({
            text: settings.enableReviewReminders
                ? evaluation.pausedReason
                    ? `Paused · ${evaluation.pausedReason.replace("-", " ")}`
                    : "Watching your study load"
                : "Reminders are disabled",
        });
        const headerActions = header.createDiv("sr-reminder-header-actions");
        new ButtonComponent(headerActions)
            .setIcon("refresh-cw")
            .setButtonText("Check now")
            .onClick(
                () =>
                    void this.plugin.reminderManager.checkNow().then((count) => {
                        if (!count) new Notice("No reminder rules match right now");
                    }),
            );
        new ButtonComponent(headerActions)
            .setIcon("plus")
            .setButtonText("New rule")
            .setCta()
            .onClick(() => this.openRule(null));

        const overview = this.contentEl.createDiv("sr-reminder-overview");
        this.metric(overview, "Due now", evaluation.allStats.due, "is-due");
        this.metric(overview, "New", evaluation.allStats.newCards, "is-new");
        this.metric(
            overview,
            `${settings.reviewReminderForecastDays}d forecast`,
            evaluation.allStats.forecast,
        );
        this.metric(overview, "Weak", evaluation.allStats.weak, "is-weak");

        const pulse = this.contentEl.createDiv("sr-reminder-pulse");
        const pulseCopy = pulse.createDiv();
        pulseCopy.createEl("strong", {
            text:
                evaluation.allStats.due + evaluation.allStats.newCards
                    ? `${evaluation.allStats.estimatedMinutes} minutes to clear today`
                    : "Today is clear",
        });
        pulseCopy.createSpan({
            text: evaluation.nextAt
                ? `Next scheduled signal ${new Date(evaluation.nextAt).toLocaleString()}`
                : "Interval checks are active; exact times are optional.",
        });
        const pulseActions = pulse.createDiv("sr-reminder-pulse-actions");
        new ButtonComponent(pulseActions)
            .setButtonText("Start review")
            .setCta()
            .onClick(() => void this.plugin.reminderManager.startReview("all", ""));
        new ButtonComponent(pulseActions)
            .setButtonText("10 min")
            .onClick(() => void this.plugin.reminderManager.snooze(10));
        new ButtonComponent(pulseActions)
            .setButtonText("1 hour")
            .onClick(() => void this.plugin.reminderManager.snooze(60));
        new ButtonComponent(pulseActions)
            .setButtonText("Skip today")
            .onClick(() => void this.plugin.reminderManager.skipToday());

        this.renderRules();
        this.renderHistory(state.history);
    }

    private metric(parent: HTMLElement, label: string, value: number, cls = ""): void {
        const metric = parent.createDiv(`sr-reminder-metric ${cls}`);
        metric.createEl("strong", { text: String(value) });
        metric.createSpan({ text: label });
    }

    private renderRules(): void {
        const section = this.contentEl.createDiv("sr-reminder-section");
        const heading = section.createDiv("sr-reminder-section-heading");
        heading.createEl("h3", { text: "Rules" });
        heading.createSpan({ text: "Global schedule plus focused signals" });
        const settings = this.plugin.dataManager.data.settings;
        const global = section.createDiv("sr-reminder-rule is-global");
        const globalIcon = global.createSpan("sr-reminder-rule-icon");
        setIcon(globalIcon, "globe-2");
        const globalCopy = global.createDiv("sr-reminder-rule-copy");
        globalCopy.createEl("strong", { text: "Global review signal" });
        globalCopy.createSpan({
            text: settings.reviewReminderTimes.length
                ? `${settings.reviewReminderTimes.join(" · ")} · ${settings.reviewReminderMinimumCards}+ cards`
                : `Every ${settings.reviewReminderIntervalMinutes} min · ${settings.reviewReminderMinimumCards}+ cards`,
        });
        global.createSpan({
            cls: `sr-reminder-rule-status ${settings.enableReviewReminders ? "is-on" : ""}`,
            text: settings.enableReviewReminders ? "On" : "Off",
        });

        for (const rule of settings.reviewReminderRules) {
            const row = section.createDiv("sr-reminder-rule");
            const icon = row.createSpan("sr-reminder-rule-icon");
            setIcon(
                icon,
                rule.scope === "deck" ? "folder" : rule.scope === "area" ? "library-big" : "layers",
            );
            const copy = row.createDiv("sr-reminder-rule-copy");
            copy.createEl("strong", { text: rule.name });
            copy.createSpan({
                text: `${rule.scopeValue || "All cards"} · ${rule.times.join(" · ") || "interval"} · ${rule.smartMode}`,
            });
            const toggle = row.createEl("button", {
                cls: `sr-reminder-rule-status ${rule.enabled ? "is-on" : ""}`,
                text: rule.enabled ? "On" : "Off",
            });
            toggle.addEventListener("click", () => void this.toggleRule(rule.id));
            const edit = row.createEl("button", {
                cls: "clickable-icon",
                attr: { "aria-label": "Edit reminder rule" },
            });
            setIcon(edit, "pencil");
            edit.addEventListener("click", () => this.openRule(rule));
            const remove = row.createEl("button", {
                cls: "clickable-icon",
                attr: { "aria-label": "Delete reminder rule" },
            });
            setIcon(remove, "trash-2");
            remove.addEventListener("click", () => void this.deleteRule(rule.id));
        }
    }

    private renderHistory(history: ReminderHistoryEntry[]): void {
        const section = this.contentEl.createDiv("sr-reminder-section");
        const heading = section.createDiv("sr-reminder-section-heading");
        const copy = heading.createDiv();
        copy.createEl("h3", { text: "History" });
        copy.createSpan({ text: `${history.filter((entry) => !entry.readAt).length} unread` });
        const actions = heading.createDiv("sr-reminder-history-actions");
        new ButtonComponent(actions)
            .setIcon("check-check")
            .setTooltip("Mark all read")
            .onClick(() => void this.plugin.reminderManager.markAllRead());
        new ButtonComponent(actions)
            .setIcon("trash-2")
            .setTooltip("Clear history")
            .onClick(() => void this.plugin.reminderManager.clearHistory());
        if (!history.length) {
            const empty = section.createDiv("sr-reminder-empty");
            setIcon(empty.createSpan(), "bell-off");
            empty.createSpan({
                text: "No reminders yet. The timeline will stay quiet until a rule matches.",
            });
            return;
        }
        const timeline = section.createDiv("sr-reminder-timeline");
        for (const entry of history) {
            const item = timeline.createDiv(`sr-reminder-event is-${entry.status}`);
            item.toggleClass("is-unread", !entry.readAt);
            const dot = item.createSpan("sr-reminder-event-dot");
            setIcon(dot, entry.status === "failed" ? "triangle-alert" : "bell");
            const eventCopy = item.createDiv("sr-reminder-event-copy");
            eventCopy.createEl("strong", { text: entry.title });
            eventCopy.createSpan({ text: entry.message });
            eventCopy.createEl("small", {
                text: `${new Date(entry.createdAt).toLocaleString()} · ${entry.delivery.join(" + ") || "not delivered"}`,
            });
            const stats = item.createDiv("sr-reminder-event-stats");
            stats.createSpan({ text: `${entry.due} due` });
            stats.createSpan({ text: `${entry.newCards} new` });
            new ButtonComponent(item)
                .setIcon("play")
                .setTooltip("Start this review")
                .onClick(
                    () =>
                        void this.plugin.reminderManager.startReview(entry.scope, entry.scopeValue),
                );
        }
    }

    private openRule(rule: ReviewReminderRule | null): void {
        new ReminderRuleModal(this.plugin, rule, (next) => void this.saveRule(next)).open();
    }

    private async saveRule(rule: ReviewReminderRule): Promise<void> {
        const settings = this.plugin.dataManager.settingsManager.settings;
        const index = settings.reviewReminderRules.findIndex(
            (candidate) => candidate.id === rule.id,
        );
        if (index >= 0) settings.reviewReminderRules[index] = rule;
        else settings.reviewReminderRules.push(rule);
        await this.plugin.dataManager.settingsManager.save();
        this.plugin.reminderManager.restartReviewReminders();
        this.render();
    }

    private async toggleRule(id: string): Promise<void> {
        const settings = this.plugin.dataManager.settingsManager.settings;
        const rule = settings.reviewReminderRules.find((candidate) => candidate.id === id);
        if (rule) rule.enabled = !rule.enabled;
        await this.plugin.dataManager.settingsManager.save();
        this.plugin.reminderManager.restartReviewReminders();
        this.render();
    }

    private async deleteRule(id: string): Promise<void> {
        const settings = this.plugin.dataManager.settingsManager.settings;
        settings.reviewReminderRules = settings.reviewReminderRules.filter(
            (candidate) => candidate.id !== id,
        );
        await this.plugin.dataManager.settingsManager.save();
        this.plugin.reminderManager.restartReviewReminders();
        this.render();
    }
}
