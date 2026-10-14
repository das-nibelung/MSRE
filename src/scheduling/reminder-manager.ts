import { Notice, requestUrl } from "obsidian";

import { DataManager } from "src/data/data-manager";
import { ReminderHistoryEntry } from "src/data/plugin-data";
import { ReviewReminderExternalProvider } from "src/data/settings";
import SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import {
    buildReminderDeepLink,
    evaluateReminders,
    recordsForReminderScope,
    ReminderCandidate,
    ReminderEvaluation,
} from "src/scheduling/reminder-engine";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";
import { UIManager, UIState } from "src/ui/ui-manager";

/** Coordinates reminder policy, delivery channels, history, and review actions. */
export class ReminderManager {
    private reviewReminderTimer: number | null = null;
    private isReviewReminderChecking = false;

    constructor(
        private readonly plugin: SRPlugin,
        private readonly uiManager: UIManager,
        private readonly dataManager: DataManager,
    ) {}

    public restartReviewReminders(): void {
        this.stopReviewReminders();
        this.startReviewReminders();
    }

    private startReviewReminders(): void {
        const settings = this.dataManager.data.settings;
        if (!this.plugin.isInitialized || !settings.enableReviewReminders) return;
        if (settings.reviewReminderCheckOnStartup) void this.checkReviewReminders(false);
        const intervalMinutes = Math.min(Math.max(settings.reviewReminderIntervalMinutes, 1), 1440);
        this.reviewReminderTimer = window.setInterval(
            (): void => void this.checkReviewReminders(false),
            intervalMinutes * 60_000,
        );
    }

    public stopReviewReminders(): void {
        if (this.reviewReminderTimer !== null) {
            window.clearInterval(this.reviewReminderTimer);
            this.reviewReminderTimer = null;
        }
        this.isReviewReminderChecking = false;
    }

    public getEvaluation(force = false, now = new Date()): ReminderEvaluation {
        return evaluateReminders(
            this.dataManager.data.settings,
            this.dataManager.data.reminderState,
            createStudyRecords(this.plugin),
            this.dataManager.data.knowledgeAreas.filter((area) => !area.archivedAt),
            now,
            force,
        );
    }

    public async checkNow(): Promise<number> {
        return await this.checkReviewReminders(true);
    }

    private async checkReviewReminders(force: boolean): Promise<number> {
        if (
            !this.plugin.isInitialized ||
            !this.plugin.isDataManagerLoaded() ||
            !this.dataManager.isOsrCoreLoaded() ||
            this.isReviewReminderChecking ||
            !this.dataManager.data.settings.enableReviewReminders
        ) {
            return 0;
        }
        if (
            !force &&
            (this.uiManager.uiState !== UIState.Closed ||
                this.uiManager.isSRInFocus ||
                this.isUserEditingText() ||
                this.dataManager.syncLock)
        ) {
            return 0;
        }

        this.isReviewReminderChecking = true;
        try {
            await this.dataManager.sync();
            const evaluation = this.getEvaluation(force);
            for (const candidate of evaluation.candidates) await this.dispatch(candidate);
            if (
                evaluation.candidates.length &&
                this.dataManager.data.settings.reviewReminderAutoOpen
            ) {
                await this.startReview(
                    evaluation.candidates[0].rule.scope,
                    evaluation.candidates[0].rule.scopeValue,
                );
            }
            this.uiManager.tabViewManager.refreshReminderCenter();
            return evaluation.candidates.length;
        } finally {
            this.isReviewReminderChecking = false;
        }
    }

    private async dispatch(candidate: ReminderCandidate): Promise<void> {
        const settings = this.dataManager.data.settings;
        const entry: ReminderHistoryEntry = {
            id: `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: Date.now(),
            ruleId: candidate.rule.id,
            title: candidate.title,
            message: candidate.message,
            scope: candidate.rule.scope,
            scopeValue: candidate.rule.scopeValue,
            due: candidate.stats.due,
            newCards: candidate.stats.newCards,
            forecast: candidate.stats.forecast,
            delivery: [],
            status: "sent",
            deepLink: candidate.deepLink,
        };
        try {
            await this.uiManager.notifyReviewReminder(candidate.message);
            entry.delivery.push("obsidian");
            this.uiManager.showReminderActionBanner(entry, {
                start: () => void this.startReview(entry.scope, entry.scopeValue),
                snooze: () => void this.snooze(10, entry.id),
                skip: () => void this.skipToday(entry.id),
            });
            if (settings.reviewReminderSystemNotification && (await this.sendSystem(entry))) {
                entry.delivery.push("system");
            }
            if (settings.reviewReminderExternalProvider !== "off") {
                await this.sendExternal(entry);
                entry.delivery.push(settings.reviewReminderExternalProvider);
            }
        } catch (error) {
            entry.status = "failed";
            entry.message = `${entry.message} · ${error instanceof Error ? error.message : "Delivery failed"}`;
        }
        const state = this.dataManager.data.reminderState;
        state.lastSentAt[candidate.rule.id] = Date.now();
        state.history.unshift(entry);
        state.history = state.history.slice(0, settings.reviewReminderHistoryLimit);
        await this.dataManager.savePluginData();
    }

    private async sendSystem(entry: ReminderHistoryEntry): Promise<boolean> {
        const view = activeDocument.defaultView;
        const NotificationClass = view?.Notification;
        if (!NotificationClass) return false;
        let permission = NotificationClass.permission;
        if (permission === "default") permission = await NotificationClass.requestPermission();
        if (permission !== "granted") return false;
        const notification = new NotificationClass(entry.title, {
            body: entry.message,
            tag: `msre-${entry.ruleId}`,
            requireInteraction: true,
            data: { deepLink: entry.deepLink },
        });
        notification.onclick = () => {
            view?.focus();
            void this.startReview(entry.scope, entry.scopeValue);
            notification.close();
        };
        return true;
    }

    private async sendExternal(entry: ReminderHistoryEntry): Promise<void> {
        const settings = this.dataManager.data.settings;
        const provider = settings.reviewReminderExternalProvider;
        const endpoint = settings.reviewReminderExternalEndpoint.trim().replace(/\/+$/g, "");
        const token = this.getExternalToken();
        if (!endpoint) throw new Error("External notification endpoint is empty");
        const snooze = "obsidian://msre?action=reminder-snooze&minutes=10";
        const skip = "obsidian://msre?action=reminder-skip";
        if (provider === "ntfy") {
            const topic = settings.reviewReminderExternalTopic.trim();
            if (!topic) throw new Error("ntfy topic is empty");
            await requestUrl({
                url: `${endpoint}/${encodeURIComponent(topic)}`,
                method: "POST",
                headers: {
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    Title: entry.title,
                    Click: entry.deepLink,
                    Actions: `view, Start review, ${entry.deepLink}; view, Snooze 10m, ${snooze}; view, Skip today, ${skip}`,
                    Tags: "books,alarm_clock",
                },
                body: entry.message,
            });
            return;
        }
        if (provider === "gotify") {
            const separator = endpoint.includes("?") ? "&" : "?";
            await requestUrl({
                url: `${endpoint}${token ? `${separator}token=${encodeURIComponent(token)}` : ""}`,
                method: "POST",
                contentType: "application/json",
                body: JSON.stringify({
                    title: entry.title,
                    message: entry.message,
                    priority: 7,
                    extras: {
                        "client::notification": { click: { url: entry.deepLink } },
                    },
                }),
            });
            return;
        }
        if (provider === "home-assistant") {
            await requestUrl({
                url: endpoint,
                method: "POST",
                contentType: "application/json",
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
                body: JSON.stringify({
                    title: entry.title,
                    message: entry.message,
                    due: entry.due,
                    newCards: entry.newCards,
                    forecast: entry.forecast,
                    url: entry.deepLink,
                    actions: { start: entry.deepLink, snooze, skip },
                }),
            });
        }
    }

    public async testExternalDelivery(): Promise<void> {
        const provider = this.dataManager.data.settings.reviewReminderExternalProvider;
        if (provider === "off") {
            new Notice("Choose an external notification provider first");
            return;
        }
        await this.sendExternal({
            id: "test",
            createdAt: Date.now(),
            ruleId: "test",
            title: "Spaced Repetition test",
            message: "Your external reminder channel is connected.",
            scope: "all",
            scopeValue: "",
            due: 0,
            newCards: 0,
            forecast: 0,
            delivery: [],
            status: "sent",
            deepLink: buildReminderDeepLink("all", ""),
        });
        new Notice(`${provider} notification sent`);
    }

    public getExternalToken(): string {
        return localStorage.getItem(this.tokenStorageKey()) ?? "";
    }

    public setExternalToken(value: string): void {
        const key = this.tokenStorageKey();
        if (value.trim()) localStorage.setItem(key, value.trim());
        else localStorage.removeItem(key);
    }

    private tokenStorageKey(): string {
        const provider: ReviewReminderExternalProvider =
            this.dataManager.data.settings.reviewReminderExternalProvider;
        return `personal-spaced-repetition:reminder-token:${this.plugin.app.vault.getName()}:${provider}`;
    }

    public async snooze(minutes: number, entryId?: string): Promise<void> {
        const state = this.dataManager.data.reminderState;
        state.snoozedUntil = Date.now() + Math.max(1, minutes) * 60_000;
        this.setHistoryStatus(entryId, "snoozed");
        await this.dataManager.savePluginData();
        this.uiManager.tabViewManager.refreshReminderCenter();
        new Notice(`Reminders snoozed for ${minutes} minutes`);
    }

    public async skipToday(entryId?: string): Promise<void> {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        this.dataManager.data.reminderState.skippedUntil = tomorrow.getTime();
        this.setHistoryStatus(entryId, "skipped");
        await this.dataManager.savePluginData();
        this.uiManager.tabViewManager.refreshReminderCenter();
        new Notice("Reminders skipped until tomorrow");
    }

    private setHistoryStatus(
        entryId: string | undefined,
        status: ReminderHistoryEntry["status"],
    ): void {
        if (!entryId) return;
        const entry = this.dataManager.data.reminderState.history.find(
            (candidate) => candidate.id === entryId,
        );
        if (entry) entry.status = status;
    }

    public async markAllRead(): Promise<void> {
        const now = Date.now();
        this.dataManager.data.reminderState.history.forEach((entry) => (entry.readAt = now));
        await this.dataManager.savePluginData();
        this.uiManager.tabViewManager.refreshReminderCenter();
    }

    public async clearHistory(): Promise<void> {
        this.dataManager.data.reminderState.history = [];
        await this.dataManager.savePluginData();
        this.uiManager.tabViewManager.refreshReminderCenter();
    }

    public async startReview(scope: "all" | "deck" | "area", scopeValue: string): Promise<void> {
        const records = recordsForReminderScope(
            createStudyRecords(this.plugin),
            scope,
            scopeValue,
            this.dataManager.data.knowledgeAreas,
        ).filter(
            (record) =>
                record.lifecycleState === "active" &&
                (record.state === "due" || record.state === "new"),
        );
        const stableIds = records
            .map((record) => record.card.stableId)
            .filter((id): id is string => Boolean(id));
        if (!stableIds.length) {
            new Notice("No due cards in this reminder");
            return;
        }
        await this.uiManager.openDeckContainer(FlashcardReviewMode.Review, undefined, stableIds);
    }

    private isUserEditingText(): boolean {
        const activeElement = activeDocument.activeElement;
        if (activeElement === null) return false;
        if (
            activeElement.instanceOf(HTMLTextAreaElement) ||
            activeElement.instanceOf(HTMLInputElement)
        ) {
            return true;
        }
        return (
            activeElement.instanceOf(HTMLElement) &&
            (activeElement.isContentEditable ||
                activeElement.closest(".cm-editor, .markdown-source-view") !== null)
        );
    }
}
