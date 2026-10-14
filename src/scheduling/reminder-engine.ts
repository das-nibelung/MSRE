import { KnowledgeArea, ReminderRuntimeState } from "src/data/plugin-data";
import {
    ReviewReminderRule,
    ReviewReminderScope,
    ReviewReminderSmartMode,
    SRSettings,
} from "src/data/settings";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";

export interface ReminderStats {
    due: number;
    newCards: number;
    scheduled: number;
    forecast: number;
    weak: number;
    total: number;
    estimatedMinutes: number;
}

export interface ReminderCandidate {
    rule: ReviewReminderRule;
    stats: ReminderStats;
    records: CardBrowserRecord[];
    title: string;
    message: string;
    deepLink: string;
    scheduledAt: number;
}

export interface ReminderEvaluation {
    candidates: ReminderCandidate[];
    allStats: ReminderStats;
    nextAt: number | null;
    pausedReason: "quiet-hours" | "snoozed" | "skipped" | null;
}

function minutesOfDay(value: string): number {
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

export function isWithinQuietHours(
    now: Date,
    enabled: boolean,
    start: string,
    end: string,
): boolean {
    if (!enabled) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    const from = minutesOfDay(start);
    const to = minutesOfDay(end);
    if (from === to) return true;
    return from < to ? current >= from && current < to : current >= from || current < to;
}

function dateAtTime(now: Date, time: string): number {
    const result = new Date(now);
    const [hours, minutes] = time.split(":").map(Number);
    result.setHours(hours, minutes, 0, 0);
    return result.getTime();
}

function nextScheduledTime(now: Date, days: number[], times: string[]): number | null {
    if (!times.length) return null;
    for (let offset = 0; offset <= 7; offset++) {
        const date = new Date(now);
        date.setDate(now.getDate() + offset);
        if (!days.includes(date.getDay())) continue;
        for (const time of [...times].sort()) {
            const candidate = dateAtTime(date, time);
            if (candidate > now.getTime()) return candidate;
        }
    }
    return null;
}

function globalRule(settings: SRSettings): ReviewReminderRule {
    return {
        id: "global",
        name: "Review reminder",
        enabled: settings.enableReviewReminders,
        scope: "all",
        scopeValue: "",
        days: settings.reviewReminderDays,
        times: settings.reviewReminderTimes,
        minimumCards: settings.reviewReminderMinimumCards,
        cooldownMinutes: settings.reviewReminderCooldownMinutes,
        // The global rule preserves the familiar "cards are ready" reminder. Intelligence is
        // additive through focused rules instead of silently suppressing ordinary reminders.
        smartMode: "none",
        message: settings.reviewReminderMessage,
    };
}

export function recordsForReminderScope(
    records: CardBrowserRecord[],
    scope: ReviewReminderScope,
    scopeValue: string,
    areas: KnowledgeArea[],
): CardBrowserRecord[] {
    if (scope === "deck") {
        return records.filter((record) =>
            record.deckNames.some(
                (deck) => deck === scopeValue || deck.startsWith(`${scopeValue}/`),
            ),
        );
    }
    if (scope === "area") {
        const area = areas.find(
            (candidate) => candidate.id === scopeValue || candidate.name === scopeValue,
        );
        if (!area) return [];
        return records.filter((record) =>
            record.deckNames.some((deck) => area.deckPaths.includes(deck)),
        );
    }
    return records;
}

export function calculateReminderStats(
    records: CardBrowserRecord[],
    now: Date,
    forecastDays: number,
): ReminderStats {
    const active = records.filter((record) => record.lifecycleState === "active");
    const forecastUntil = now.getTime() + forecastDays * 86_400_000;
    const forecast = active.filter((record) => {
        if (record.state === "due" || record.state === "new") return true;
        if (!record.dueDate) return false;
        const dueAt = Date.parse(record.dueDate);
        return Number.isFinite(dueAt) && dueAt <= forecastUntil;
    }).length;
    const due = active.filter((record) => record.state === "due").length;
    const newCards = active.filter((record) => record.state === "new").length;
    return {
        due,
        newCards,
        scheduled: active.filter((record) => record.state === "scheduled").length,
        forecast,
        weak: active.filter(
            (record) =>
                (record.lapses ?? 0) >= 2 ||
                (record.retention !== null &&
                    record.retention !== undefined &&
                    record.retention < 0.85),
        ).length,
        total: active.length,
        estimatedMinutes: Math.max(1, Math.ceil((due + newCards) * 0.35)),
    };
}

function smartCondition(
    mode: ReviewReminderSmartMode,
    stats: ReminderStats,
    settings: SRSettings,
    rule: ReviewReminderRule,
    areas: KnowledgeArea[],
    now: Date,
): boolean {
    if (mode !== "none" && !settings.reviewReminderSmartEnabled) return false;
    if (mode === "overload")
        return stats.due + stats.newCards >= settings.reviewReminderDailyCapacity;
    if (mode === "forecast") return stats.forecast > settings.reviewReminderDailyCapacity;
    if (mode === "weak") return stats.weak > 0;
    if (mode === "deadline") {
        const area = areas.find(
            (candidate) => candidate.id === rule.scopeValue || candidate.name === rule.scopeValue,
        );
        if (!area?.goal?.targetDate) return false;
        const days = Math.max(
            1,
            Math.ceil((Date.parse(area.goal.targetDate) - now.getTime()) / 86_400_000),
        );
        const requiredPerDay = Math.ceil(stats.total / days);
        return requiredPerDay > (area.goal.cardsPerDay ?? settings.reviewReminderDailyCapacity);
    }
    return true;
}

function isRuleDue(
    rule: ReviewReminderRule,
    settings: SRSettings,
    state: ReminderRuntimeState,
    now: Date,
    force: boolean,
): { due: boolean; scheduledAt: number } {
    const timestamp = now.getTime();
    if (force) return { due: true, scheduledAt: timestamp };
    if (!rule.days.includes(now.getDay())) return { due: false, scheduledAt: timestamp };
    const lastSentAt = state.lastSentAt[rule.id] ?? 0;
    const cooldown = rule.cooldownMinutes * 60_000;
    if (timestamp - lastSentAt < cooldown) return { due: false, scheduledAt: timestamp };
    if (!rule.times.length) return { due: true, scheduledAt: timestamp };
    const passed = rule.times
        .map((time) => dateAtTime(now, time))
        .filter((time) => time <= timestamp)
        .sort((left, right) => right - left)[0];
    return { due: Boolean(passed && lastSentAt < passed), scheduledAt: passed ?? timestamp };
}

export function buildReminderDeepLink(scope: ReviewReminderScope, scopeValue: string): string {
    const params = new URLSearchParams({ action: "review" });
    if (scope === "deck" && scopeValue) params.set("deck", scopeValue);
    if (scope === "area" && scopeValue) params.set("query", `area:${scopeValue}`);
    return `obsidian://msre?${params.toString()}`;
}

function reminderMessage(rule: ReviewReminderRule, stats: ReminderStats): string {
    if (rule.message.trim()) {
        return rule.message
            .replaceAll("{due}", String(stats.due))
            .replaceAll("{new}", String(stats.newCards))
            .replaceAll("{forecast}", String(stats.forecast))
            .replaceAll("{minutes}", String(stats.estimatedMinutes));
    }
    return `${stats.due} due · ${stats.newCards} new · about ${stats.estimatedMinutes} min`;
}

export function evaluateReminders(
    settings: SRSettings,
    state: ReminderRuntimeState,
    records: CardBrowserRecord[],
    areas: KnowledgeArea[],
    now = new Date(),
    force = false,
): ReminderEvaluation {
    const allStats = calculateReminderStats(records, now, settings.reviewReminderForecastDays);
    if (state.snoozedUntil > now.getTime()) {
        return { candidates: [], allStats, nextAt: state.snoozedUntil, pausedReason: "snoozed" };
    }
    if (state.skippedUntil > now.getTime()) {
        return { candidates: [], allStats, nextAt: state.skippedUntil, pausedReason: "skipped" };
    }
    if (
        isWithinQuietHours(
            now,
            settings.reviewReminderQuietHoursEnabled,
            settings.reviewReminderQuietHoursStart,
            settings.reviewReminderQuietHoursEnd,
        )
    ) {
        return { candidates: [], allStats, nextAt: null, pausedReason: "quiet-hours" };
    }

    const rules = [globalRule(settings), ...settings.reviewReminderRules].filter(
        (rule) => rule.enabled,
    );
    const candidates: ReminderCandidate[] = [];
    for (const rule of rules) {
        const scopedRecords = recordsForReminderScope(records, rule.scope, rule.scopeValue, areas);
        const stats = calculateReminderStats(
            scopedRecords,
            now,
            settings.reviewReminderForecastDays,
        );
        if (stats.due + stats.newCards < rule.minimumCards) continue;
        if (!smartCondition(rule.smartMode, stats, settings, rule, areas, now)) continue;
        const timing = isRuleDue(rule, settings, state, now, force);
        if (!timing.due) continue;
        candidates.push({
            rule,
            stats,
            records: scopedRecords,
            title: rule.name || "Cards are ready",
            message: reminderMessage(rule, stats),
            deepLink: buildReminderDeepLink(rule.scope, rule.scopeValue),
            scheduledAt: timing.scheduledAt,
        });
    }
    const nextTimes = rules
        .map((rule) => nextScheduledTime(now, rule.days, rule.times))
        .filter((value): value is number => value !== null);
    return {
        candidates,
        allStats,
        nextAt: nextTimes.length ? Math.min(...nextTimes) : null,
        pausedReason: null,
    };
}
