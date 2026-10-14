import { Card } from "src/data/data-structures/card/card";
import { KnowledgeArea, ReminderRuntimeState } from "src/data/plugin-data";
import { DEFAULT_SETTINGS, ReviewReminderRule, SRSettings } from "src/data/settings";
import {
    buildReminderDeepLink,
    calculateReminderStats,
    evaluateReminders,
    isWithinQuietHours,
    recordsForReminderScope,
} from "src/scheduling/reminder-engine";
import { CardBrowserRecord } from "src/ui/card-browser/card-browser-model";

function record(overrides: Partial<CardBrowserRecord> = {}): CardBrowserRecord {
    return {
        card: {} as Card,
        id: "card-1",
        front: "Question",
        back: "Answer",
        notePath: "Cards/Question.md",
        deckNames: ["Medicine"],
        state: "due",
        dueDate: "2026-10-14",
        interval: 1,
        ease: 250,
        lifecycleState: "active",
        flag: 0,
        tags: [],
        cardType: "basic",
        ...overrides,
    };
}

function settings(overrides: Partial<SRSettings> = {}): SRSettings {
    return {
        ...DEFAULT_SETTINGS,
        enableReviewReminders: true,
        reviewReminderDays: [0, 1, 2, 3, 4, 5, 6],
        reviewReminderTimes: [],
        reviewReminderRules: [],
        reviewReminderMinimumCards: 1,
        reviewReminderCooldownMinutes: 120,
        ...overrides,
    };
}

function state(overrides: Partial<ReminderRuntimeState> = {}): ReminderRuntimeState {
    return {
        history: [],
        lastSentAt: {},
        snoozedUntil: 0,
        skippedUntil: 0,
        ...overrides,
    };
}

function rule(overrides: Partial<ReviewReminderRule> = {}): ReviewReminderRule {
    return {
        id: "focused",
        name: "Focused review",
        enabled: true,
        scope: "deck",
        scopeValue: "Medicine",
        days: [0, 1, 2, 3, 4, 5, 6],
        times: [],
        minimumCards: 1,
        cooldownMinutes: 120,
        smartMode: "none",
        message: "{due} due, {new} new, {minutes} min",
        ...overrides,
    };
}

describe("reminder engine", () => {
    const now = new Date(2026, 9, 14, 18, 5, 0, 0);

    it("handles quiet hours that cross midnight", () => {
        expect(isWithinQuietHours(new Date(2026, 9, 14, 23, 30), true, "22:00", "08:00")).toBe(
            true,
        );
        expect(isWithinQuietHours(new Date(2026, 9, 15, 7, 30), true, "22:00", "08:00")).toBe(true);
        expect(isWithinQuietHours(new Date(2026, 9, 15, 12, 0), true, "22:00", "08:00")).toBe(
            false,
        );
        expect(isWithinQuietHours(new Date(2026, 9, 15, 12, 0), false, "09:00", "17:00")).toBe(
            false,
        );
        expect(isWithinQuietHours(new Date(2026, 9, 15, 12, 0), true, "09:00", "17:00")).toBe(true);
        expect(isWithinQuietHours(new Date(2026, 9, 15, 8, 0), true, "09:00", "17:00")).toBe(false);
        expect(isWithinQuietHours(new Date(2026, 9, 15, 8, 0), true, "08:00", "08:00")).toBe(true);
    });

    it("fires an exact time only once and respects cooldown", () => {
        const configured = settings({ reviewReminderTimes: ["18:00"] });
        const first = evaluateReminders(configured, state(), [record()], [], now);
        expect(first.candidates).toHaveLength(1);
        const sentAt = first.candidates[0].scheduledAt;
        const second = evaluateReminders(
            configured,
            state({ lastSentAt: { global: sentAt } }),
            [record()],
            [],
            new Date(2026, 9, 14, 18, 20),
        );
        expect(second.candidates).toHaveLength(0);
    });

    it("pauses globally while snoozed or skipped", () => {
        const snoozed = evaluateReminders(
            settings(),
            state({ snoozedUntil: now.getTime() + 600_000 }),
            [record()],
            [],
            now,
        );
        expect(snoozed.pausedReason).toBe("snoozed");
        expect(snoozed.candidates).toHaveLength(0);
        const skipped = evaluateReminders(
            settings(),
            state({ skippedUntil: now.getTime() + 86_400_000 }),
            [record()],
            [],
            now,
        );
        expect(skipped.pausedReason).toBe("skipped");
    });

    it("filters nested decks and knowledge areas", () => {
        const records = [
            record({ id: "a", deckNames: ["Medicine/Cardiology"] }),
            record({ id: "b", deckNames: ["Law"] }),
        ];
        const areas: KnowledgeArea[] = [
            { id: "health", name: "Health", deckPaths: ["Medicine/Cardiology"], pinned: false },
        ];
        expect(recordsForReminderScope(records, "deck", "Medicine", areas)).toEqual([records[0]]);
        expect(recordsForReminderScope(records, "area", "health", areas)).toEqual([records[0]]);
        expect(recordsForReminderScope(records, "area", "Health", areas)).toEqual([records[0]]);
        expect(recordsForReminderScope(records, "area", "missing", areas)).toEqual([]);
        expect(recordsForReminderScope(records, "all", "", areas)).toEqual(records);
    });

    it("counts forecast, weak, scheduled, and active records", () => {
        const records = [
            record({ id: "due", lapses: 2 }),
            record({ id: "new", state: "new", dueDate: null }),
            record({
                id: "soon",
                state: "scheduled",
                dueDate: "2026-10-16",
                retention: 0.7,
            }),
            record({ id: "later", state: "scheduled", dueDate: "2026-11-16" }),
            record({ id: "unknown", state: "scheduled", dueDate: null }),
            record({ id: "invalid", state: "scheduled", dueDate: "not-a-date" }),
            record({ id: "suspended", lifecycleState: "suspended" }),
        ];
        expect(calculateReminderStats(records, now, 3)).toEqual({
            due: 1,
            newCards: 1,
            scheduled: 4,
            forecast: 3,
            weak: 2,
            total: 6,
            estimatedMinutes: 1,
        });
    });

    it("applies thresholds and intelligent weak-card rules", () => {
        const weakRule = rule({ smartMode: "weak", minimumCards: 2 });
        const configured = settings({
            reviewReminderMinimumCards: 99,
            reviewReminderRules: [weakRule],
        });
        const records = [
            record({ id: "a", lapses: 3 }),
            record({ id: "b", state: "new", retention: 0.7 }),
        ];
        const result = evaluateReminders(configured, state(), records, [], now, true);
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0].rule.id).toBe("focused");
        expect(result.candidates[0].message).toBe("1 due, 1 new, 1 min");
    });

    it("supports overload, forecast, deadline, and disabled intelligence", () => {
        const cards = [
            record({ id: "a" }),
            record({ id: "b", state: "new" }),
            record({ id: "c", state: "scheduled", dueDate: "2026-10-15" }),
        ];
        const area: KnowledgeArea = {
            id: "health",
            name: "Health",
            deckPaths: ["Medicine"],
            pinned: false,
            goal: { targetDate: "2026-10-15", cardsPerDay: 1 },
        };
        const areaWithoutGoal: KnowledgeArea = {
            id: "without-goal",
            name: "Without goal",
            deckPaths: ["Medicine"],
            pinned: false,
        };
        const areaWithDefaultCapacity: KnowledgeArea = {
            id: "default-capacity",
            name: "Default capacity",
            deckPaths: ["Medicine"],
            pinned: false,
            goal: { targetDate: "2026-10-15" },
        };
        const intelligentRules = [
            rule({ id: "overload", smartMode: "overload" }),
            rule({ id: "forecast", smartMode: "forecast" }),
            rule({
                id: "deadline",
                scope: "area",
                scopeValue: "health",
                smartMode: "deadline",
            }),
            rule({
                id: "missing-deadline",
                scope: "area",
                scopeValue: "without-goal",
                smartMode: "deadline",
            }),
            rule({
                id: "default-capacity",
                scope: "area",
                scopeValue: "default-capacity",
                smartMode: "deadline",
            }),
        ];
        const enabled = settings({
            reviewReminderMinimumCards: 99,
            reviewReminderDailyCapacity: 1,
            reviewReminderRules: intelligentRules,
        });
        expect(
            evaluateReminders(
                enabled,
                state(),
                cards,
                [area, areaWithoutGoal, areaWithDefaultCapacity],
                now,
                true,
            ).candidates.map((candidate) => candidate.rule.id),
        ).toEqual(["overload", "forecast", "deadline", "default-capacity"]);

        const disabled = {
            ...enabled,
            reviewReminderSmartEnabled: false,
        };
        expect(evaluateReminders(disabled, state(), cards, [area], now, true).candidates).toEqual(
            [],
        );
    });

    it("respects active days and reports the next exact time", () => {
        const intervalSignal = evaluateReminders(settings(), state(), [record()], [], now);
        expect(intervalSignal.candidates).toHaveLength(1);

        const future = new Date(2026, 9, 14, 17, 0);
        const scheduled = settings({ reviewReminderTimes: ["18:00"] });
        const before = evaluateReminders(scheduled, state(), [record()], [], future);
        expect(before.candidates).toHaveLength(0);
        expect(before.nextAt).toBe(new Date(2026, 9, 14, 18, 0).getTime());

        const wrongDay = settings({ reviewReminderDays: [4], reviewReminderTimes: [] });
        expect(evaluateReminders(wrongDay, state(), [record()], [], now).candidates).toHaveLength(
            0,
        );
        const noSchedule = evaluateReminders(
            settings({ enableReviewReminders: false, reviewReminderDays: [] }),
            state(),
            [record()],
            [],
            now,
        );
        expect(noSchedule.nextAt).toBeNull();
        const noMatchingDay = evaluateReminders(
            settings({ reviewReminderDays: [], reviewReminderTimes: ["18:00"] }),
            state(),
            [record()],
            [],
            now,
        );
        expect(noMatchingDay.nextAt).toBeNull();
    });

    it("uses a readable fallback title for unnamed rules", () => {
        const configured = settings({
            reviewReminderMinimumCards: 99,
            reviewReminderRules: [rule({ name: "" })],
        });
        const result = evaluateReminders(configured, state(), [record()], [], now, true);
        expect(result.candidates[0].title).toBe("Cards are ready");
    });

    it("pauses during quiet hours", () => {
        const configured = settings({
            reviewReminderQuietHoursEnabled: true,
            reviewReminderQuietHoursStart: "17:00",
            reviewReminderQuietHoursEnd: "19:00",
        });
        const result = evaluateReminders(configured, state(), [record()], [], now);
        expect(result.pausedReason).toBe("quiet-hours");
        expect(result.nextAt).toBeNull();
    });

    it("creates mobile-safe scoped review links", () => {
        expect(buildReminderDeepLink("deck", "Medicine/Cardiology")).toContain(
            "deck=Medicine%2FCardiology",
        );
        expect(buildReminderDeepLink("area", "High yield")).toContain("query=area%3AHigh+yield");
    });
});
