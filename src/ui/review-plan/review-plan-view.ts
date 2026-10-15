import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";

import { REVIEW_PLAN_VIEW_TYPE } from "src/data/constants";
import type SRPlugin from "src/main";
import {
    ExcludedPlannedCard,
    PlannedCard,
    ReviewPlanScoreBreakdown,
} from "src/scheduling/review-session-planner";
import { compactCardText } from "src/ui/card-browser/card-browser-model";
import { ReviewPlanPreview, ReviewQueueLoader } from "src/ui/review-queue-loader";

const RESTORE_WINDOW_MS = 12 * 60 * 60 * 1000;

function percentage(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function signedPercentage(value: number): string {
    const rounded = Math.round(value * 100);
    return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

export class ReviewPlanView extends ItemView {
    private loader: ReviewQueueLoader | null = null;
    private preview: ReviewPlanPreview | null = null;
    private cards: PlannedCard[] = [];
    private excluded: ExcludedPlannedCard[] = [];
    private expandedIds = new Set<string>();
    private simulationDays: 7 | 30 = 7;
    private showAllExcluded = false;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: SRPlugin,
    ) {
        super(leaf);
        this.navigation = true;
    }

    getViewType(): string {
        return REVIEW_PLAN_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "Review plan";
    }

    getIcon(): string {
        return "list-tree";
    }

    onOpen(): Promise<void> {
        this.contentEl.addClass("sr-review-plan-view");
        this.render();
        return Promise.resolve();
    }

    async configure(loader: ReviewQueueLoader): Promise<void> {
        this.loader = loader;
        this.preview = null;
        this.render();
        try {
            const preview = await loader.buildReviewPlanPreview();
            this.preview = preview;
            this.cards = [...preview.cards];
            this.excluded = [...preview.excluded];
            this.restoreDraft();
        } catch (error) {
            console.error("Could not build review plan", error);
            new Notice("Could not build the review plan. Your cards are safe.");
        }
        this.render();
    }

    private restoreDraft(): void {
        if (!this.preview) return;
        const draft = this.plugin.dataManager.data.reviewPlanState;
        if (!draft.updatedAt || Date.now() - draft.updatedAt > RESTORE_WINDOW_MS) return;
        const candidates = new Map(
            this.preview.rankedCards.flatMap((item) =>
                item.card.legacyStableId ? [[item.card.legacyStableId, item] as const] : [],
            ),
        );
        const currentIds = new Set(
            this.cards.flatMap((item) =>
                item.card.legacyStableId ? [item.card.legacyStableId] : [],
            ),
        );
        const excludedByDraft = new Set(draft.excludedStableIds);
        const restored: PlannedCard[] = [];
        for (const stableId of draft.orderedStableIds) {
            const item = candidates.get(stableId);
            if (item) item.manualReason = draft.manualReasons[stableId];
            if (!item || !currentIds.has(stableId) || draft.excludedStableIds.includes(stableId))
                continue;
            restored.push(item);
            currentIds.delete(stableId);
        }
        for (const item of this.cards) {
            const stableId = item.card.legacyStableId;
            if (stableId && excludedByDraft.has(stableId)) continue;
            if (!stableId || currentIds.has(stableId)) restored.push(item);
        }
        for (const item of this.cards) {
            const stableId = item.card.legacyStableId;
            if (!stableId || !excludedByDraft.has(stableId)) continue;
            item.manualReason = draft.manualReasons[stableId];
            this.excluded.unshift({
                card: item.card,
                dueAt: item.dueAt,
                code: "manual",
                headline: "Removed from this session",
                detail: draft.manualReasons[stableId] ?? "Manual session choice.",
            });
        }
        this.cards = restored;
    }

    private render(): void {
        this.contentEl.empty();
        const shell = this.contentEl.createDiv("sr-review-plan-shell");
        this.renderHeader(shell);
        if (!this.loader || !this.preview) {
            const loading = shell.createDiv("sr-review-plan-loading");
            setIcon(loading.createSpan(), "loader-circle");
            loading.createEl("strong", { text: "Building today’s plan" });
            loading.createEl("span", {
                text: "Reading due dates, memory risk and knowledge dependencies…",
            });
            return;
        }
        this.renderOverview(shell);
        this.renderQueue(shell);
        this.renderExcluded(shell);
        this.renderSimulation(shell);
        this.renderDependencyEvidence(shell);
    }

    private renderHeader(shell: HTMLElement): void {
        const header = shell.createDiv("sr-review-plan-header");
        const copy = header.createDiv("sr-review-plan-title");
        copy.createEl("span", { text: "TODAY’S SESSION" });
        copy.createEl("h1", { text: "Review plan" });
        copy.createEl("p", {
            text: "See why every card is here, adjust the order, then start with intent.",
        });
        const actions = header.createDiv("sr-review-plan-header-actions");
        const refresh = actions.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": "Rebuild plan" },
        });
        setIcon(refresh, "refresh-cw");
        refresh.addEventListener("click", () => {
            if (this.loader) void this.configure(this.loader);
        });
        const start = actions.createEl("button", {
            cls: "mod-cta sr-review-plan-start",
            text: this.cards.length ? `Start · ${this.cards.length}` : "Start review",
        });
        start.disabled = !this.preview || this.cards.length === 0;
        start.addEventListener("click", () => void this.startReview());
    }

    private renderOverview(shell: HTMLElement): void {
        if (!this.preview) return;
        const now = this.preview.generatedAt;
        const due = this.cards.filter(
            (item) => item.card.queue !== "new" && item.dueAt !== null && item.dueAt <= now,
        ).length;
        const overdue = this.cards.filter(
            (item) =>
                item.card.queue !== "new" && item.dueAt !== null && item.dueAt < now - 86_400_000,
        ).length;
        const overview = shell.createDiv("sr-review-plan-overview");
        const metrics = [
            [String(this.cards.length), "planned"],
            [String(due), "due"],
            [String(overdue), "overdue"],
            [String(this.estimatedMinutes()), "minutes"],
        ];
        for (const [value, label] of metrics) {
            const metric = overview.createDiv("sr-review-plan-metric");
            metric.createEl("strong", { text: value });
            metric.createSpan({ text: label });
        }
        const narrative = shell.createDiv("sr-review-plan-narrative");
        setIcon(narrative.createSpan(), "sparkles");
        const text = narrative.createDiv();
        text.createEl("strong", { text: "Why this plan" });
        text.createEl("p", {
            text:
                overdue > 0
                    ? `It clears ${overdue} overdue ${overdue === 1 ? "card" : "cards"}, protects weak memories and respects the current time budget.`
                    : "It protects the weakest memories first, respects deck limits and keeps prerequisites ahead of dependent concepts.",
        });
    }

    private renderQueue(shell: HTMLElement): void {
        const section = shell.createEl("section", { cls: "sr-review-plan-section" });
        const heading = section.createDiv("sr-review-plan-section-heading");
        heading.createEl("h2", { text: "Session order" });
        heading.createSpan({ text: "Tap a row for the complete score" });
        const list = section.createDiv("sr-review-plan-list");
        if (!this.cards.length) {
            list.createEl("p", {
                cls: "sr-review-plan-empty",
                text: "No cards are ready for this session.",
            });
            return;
        }
        this.cards.forEach((item, index) => this.renderCardRow(list, item, index));
    }

    private renderCardRow(list: HTMLElement, item: PlannedCard, index: number): void {
        const row = list.createDiv("sr-review-plan-row");
        row.toggleClass("is-expanded", this.expandedIds.has(item.card.id));
        const rank = row.createEl("button", {
            cls: "sr-review-plan-rank",
            text: String(index + 1).padStart(2, "0"),
            attr: { "aria-label": "Show score breakdown" },
        });
        rank.addEventListener("click", () => this.toggleExpanded(item.card.id));
        const body = row.createDiv("sr-review-plan-row-body");
        const top = body.createDiv("sr-review-plan-row-top");
        const title = top.createEl("button", { cls: "sr-review-plan-card-title" });
        title.createEl("strong", { text: this.cardLabel(item) });
        title.createSpan({ text: item.card.deckPath || "No deck" });
        title.addEventListener("click", () => this.toggleExpanded(item.card.id));
        const score = top.createDiv("sr-review-plan-score");
        score.createEl("strong", { text: Math.round(item.score).toLocaleString() });
        score.createSpan({ text: "score" });
        const reason = this.planReason(item);
        const reasonLine = body.createDiv("sr-review-plan-reason");
        setIcon(reasonLine.createSpan(), reason.icon);
        reasonLine.createSpan({ text: reason.text });
        const controls = row.createDiv("sr-review-plan-controls");
        this.iconButton(controls, "arrow-up", "Move earlier", index === 0, () =>
            this.moveCard(index, -1),
        );
        this.iconButton(controls, "arrow-down", "Move later", index === this.cards.length - 1, () =>
            this.moveCard(index, 1),
        );
        this.iconButton(controls, "minus", "Remove from session", false, () =>
            this.excludeCard(index),
        );
        if (this.expandedIds.has(item.card.id)) this.renderBreakdown(body, item);
    }

    private renderBreakdown(body: HTMLElement, item: PlannedCard): void {
        const details = body.createDiv("sr-review-plan-breakdown");
        const labels: Array<[keyof ReviewPlanScoreBreakdown, string]> = [
            ["overdue", "Overdue"],
            ["forgetting", "Forgetting risk"],
            ["importance", "Importance"],
            ["dependency", "Dependency value"],
            ["learning", "Learning step"],
            ["blocked", "Blocked penalty"],
            ["schedule", "Ahead penalty"],
            ["manual", "Manual adjustment"],
        ];
        for (const [key, label] of labels) {
            const line = details.createDiv("sr-review-plan-breakdown-line");
            line.createSpan({ text: label });
            line.createEl("strong", {
                text: `${item.scoreBreakdown[key] >= 0 ? "+" : ""}${Math.round(item.scoreBreakdown[key])}`,
            });
        }
        if (item.prerequisiteConfidence > 0) {
            const confidence = details.createDiv("sr-review-plan-confidence");
            confidence.createSpan({ text: "Prerequisite confidence" });
            confidence.createEl("strong", { text: percentage(item.prerequisiteConfidence) });
        }
        const field = details.createEl("label", { cls: "sr-review-plan-manual-reason" });
        field.createSpan({ text: "Reason for manual priority" });
        const input = field.createEl("input", {
            type: "text",
            placeholder: "For example: exam tomorrow",
            value: item.manualReason ?? "",
        });
        input.addEventListener("change", () => {
            item.manualReason = input.value.trim() || undefined;
            void this.persistDraft();
        });
    }

    private renderExcluded(shell: HTMLElement): void {
        const section = shell.createEl("details", { cls: "sr-review-plan-excluded" });
        const summary = section.createEl("summary");
        summary.createEl("strong", { text: "Not in today’s plan" });
        summary.createSpan({ text: `${this.excluded.length} cards · every exclusion explained` });
        const list = section.createDiv("sr-review-plan-excluded-list");
        const visible = this.showAllExcluded ? this.excluded : this.excluded.slice(0, 80);
        for (const excluded of visible) {
            const row = list.createDiv("sr-review-plan-excluded-row");
            const copy = row.createDiv();
            copy.createEl("strong", { text: this.excludedLabel(excluded) });
            copy.createSpan({ text: `${excluded.headline} · ${excluded.detail}` });
            if (excluded.code === "manual" || excluded.code === "time-limit") {
                const add = row.createEl("button", {
                    cls: "clickable-icon",
                    attr: { "aria-label": "Add to session" },
                });
                setIcon(add, "plus");
                add.addEventListener("click", () => this.includeCard(excluded));
            }
        }
        if (this.excluded.length > visible.length) {
            const more = list.createEl("button", {
                cls: "sr-review-plan-more",
                text: `Show ${this.excluded.length - visible.length} more explanations`,
            });
            more.addEventListener("click", () => {
                this.showAllExcluded = true;
                this.render();
            });
        }
    }

    private renderSimulation(shell: HTMLElement): void {
        if (!this.preview) return;
        const section = shell.createEl("section", { cls: "sr-review-plan-section" });
        const heading = section.createDiv("sr-review-plan-section-heading");
        const copy = heading.createDiv();
        copy.createEl("h2", { text: "Load forecast" });
        copy.createSpan({ text: "Known due dates; schedules are not changed" });
        const toggle = heading.createDiv("sr-review-plan-toggle");
        for (const days of [7, 30] as const) {
            const button = toggle.createEl("button", { text: `${days}d` });
            button.toggleClass("is-active", this.simulationDays === days);
            button.addEventListener("click", () => {
                this.simulationDays = days;
                this.render();
            });
        }
        const simulation = this.simulationDays === 7 ? this.preview.week : this.preview.month;
        const summary = section.createDiv("sr-review-plan-forecast-summary");
        summary.createEl("strong", {
            text: `${simulation.totalCards} cards · ${simulation.totalMinutes} min`,
        });
        summary.createSpan({
            text: simulation.peakDate
                ? `Peak ${simulation.peakCards} on ${simulation.peakDate}`
                : "No scheduled load",
        });
        const chart = section.createDiv("sr-review-plan-forecast");
        const max = Math.max(1, ...simulation.buckets.map((bucket) => bucket.cards));
        for (const bucket of simulation.buckets) {
            const bar = chart.createDiv("sr-review-plan-forecast-column");
            const fill = bar.createDiv("sr-review-plan-forecast-fill");
            fill.setCssProps({ height: `${Math.max(3, (bucket.cards / max) * 100)}%` });
            fill.toggleClass("is-overdue", bucket.overdue > 0);
            bar.createSpan({ text: bucket.date.slice(5) });
            bar.setAttribute("aria-label", `${bucket.date}: ${bucket.cards} cards`);
        }
    }

    private renderDependencyEvidence(shell: HTMLElement): void {
        if (!this.preview) return;
        const section = shell.createEl("section", { cls: "sr-review-plan-section" });
        const heading = section.createDiv("sr-review-plan-section-heading");
        heading.createEl("h2", { text: "Dependency evidence" });
        heading.createSpan({ text: "Did reviewing the prerequisite actually help?" });
        const items = [...this.preview.dependencyImpact]
            .sort((left, right) => right.confidence - left.confidence)
            .slice(0, 8);
        if (!items.length) {
            section.createEl("p", {
                cls: "sr-review-plan-empty",
                text: "Add prerequisite links in the knowledge graph to measure their effect.",
            });
            return;
        }
        const list = section.createDiv("sr-review-plan-evidence-list");
        for (const item of items) {
            const row = list.createDiv("sr-review-plan-evidence-row");
            const copy = row.createDiv();
            copy.createEl("strong", {
                text: `${this.shortPath(item.prerequisitePath)} → ${this.shortPath(item.dependentPath)}`,
            });
            const total = item.withPrerequisite.reviews + item.withoutPrerequisite.reviews;
            copy.createSpan({
                text:
                    total > 0
                        ? `${signedPercentage(item.uplift)} dependent-card success · ${total} observations`
                        : "Awaiting paired review history",
            });
            const gauges = row.createDiv("sr-review-plan-evidence-gauges");
            gauges.createEl("strong", { text: percentage(item.strength) });
            gauges.createSpan({ text: `${percentage(item.confidence)} confidence` });
        }
    }

    private planReason(item: PlannedCard): { icon: string; text: string } {
        if (item.manualReason) return { icon: "hand", text: item.manualReason };
        if (item.dependencyBoost > 0)
            return {
                icon: "git-branch-plus",
                text: `Unlocks ${item.unlocks.length} dependent ${item.unlocks.length === 1 ? "concept" : "concepts"}`,
            };
        if (item.blockedBy.length)
            return { icon: "route", text: "Placed after a weak prerequisite" };
        if (item.card.queue === "learning" || item.card.queue === "relearning")
            return { icon: "zap", text: "Active learning step" };
        if (item.card.queue === "new") return { icon: "sparkle", text: "New knowledge" };
        const components: Array<[keyof ReviewPlanScoreBreakdown, number]> = [
            ["importance", item.scoreBreakdown.importance],
            ["learning", item.scoreBreakdown.learning],
            ["overdue", item.scoreBreakdown.overdue],
            ["forgetting", item.scoreBreakdown.forgetting],
            ["dependency", item.scoreBreakdown.dependency],
            ["blocked", item.scoreBreakdown.blocked],
            ["schedule", item.scoreBreakdown.schedule],
        ];
        const dominant = components
            .filter(([key]) => key !== "manual")
            .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))[0]?.[0];
        if (dominant === "overdue") return { icon: "clock-alert", text: "Overdue risk" };
        if (dominant === "importance") return { icon: "badge-alert", text: "High importance" };
        return { icon: "brain", text: "Forgetting risk" };
    }

    private cardLabel(item: PlannedCard): string {
        const note =
            this.plugin.dataManager.collectionStore.getCollectionSnapshot().notes[item.card.noteId];
        const first = note ? Object.values(note.fields).find((value) => value.trim()) : "";
        return (
            compactCardText(first ?? "").slice(0, 120) ||
            this.shortPath(note?.source.path ?? "Card")
        );
    }

    private excludedLabel(item: ExcludedPlannedCard): string {
        const note =
            this.plugin.dataManager.collectionStore.getCollectionSnapshot().notes[item.card.noteId];
        const first = note ? Object.values(note.fields).find((value) => value.trim()) : "";
        return (
            compactCardText(first ?? "").slice(0, 100) ||
            this.shortPath(note?.source.path ?? "Card")
        );
    }

    private shortPath(path: string): string {
        return path.split("/").pop()?.replace(/\.md$/i, "") || path;
    }

    private iconButton(
        parent: HTMLElement,
        icon: string,
        label: string,
        disabled: boolean,
        action: () => void,
    ): void {
        const button = parent.createEl("button", {
            cls: "clickable-icon",
            attr: { "aria-label": label },
        });
        button.disabled = disabled;
        setIcon(button, icon);
        button.addEventListener("click", action);
    }

    private toggleExpanded(id: string): void {
        if (this.expandedIds.has(id)) this.expandedIds.delete(id);
        else this.expandedIds.add(id);
        this.render();
    }

    private moveCard(index: number, delta: number): void {
        const next = index + delta;
        if (next < 0 || next >= this.cards.length) return;
        const [item] = this.cards.splice(index, 1);
        this.cards.splice(next, 0, item);
        item.manualReason ??= "Manual priority";
        this.expandedIds.add(item.card.id);
        void this.persistDraft();
        this.render();
    }

    private excludeCard(index: number): void {
        const [item] = this.cards.splice(index, 1);
        if (!item) return;
        item.manualReason ??= "Removed from current session";
        this.excluded.unshift({
            card: item.card,
            dueAt: item.dueAt,
            code: "manual",
            headline: "Removed from this session",
            detail: item.manualReason,
        });
        void this.persistDraft();
        this.render();
    }

    private includeCard(excluded: ExcludedPlannedCard): void {
        const candidate = this.preview?.rankedCards.find(
            (item) => item.card.id === excluded.card.id,
        );
        if (!candidate) return;
        candidate.manualReason = "Added manually";
        this.cards.push(candidate);
        this.excluded = this.excluded.filter((item) => item !== excluded);
        this.expandedIds.add(candidate.card.id);
        void this.persistDraft();
        this.render();
    }

    private estimatedMinutes(): number {
        const average = this.preview?.plan.averageResponseMs ?? 12_000;
        return Math.ceil((this.cards.length * average) / 60_000);
    }

    private async persistDraft(): Promise<void> {
        const state = this.plugin.dataManager.data.reviewPlanState;
        state.updatedAt = Date.now();
        state.orderedStableIds = this.cards.flatMap((item) =>
            item.card.legacyStableId ? [item.card.legacyStableId] : [],
        );
        state.excludedStableIds = this.excluded
            .filter((item) => item.code === "manual")
            .flatMap((item) => (item.card.legacyStableId ? [item.card.legacyStableId] : []));
        state.manualReasons = Object.fromEntries(
            [...this.cards, ...(this.preview?.rankedCards ?? [])].flatMap((item) => {
                const stableId = item.card.legacyStableId;
                const reason = item.manualReason;
                return stableId && reason ? [[stableId, reason] as [string, string]] : [];
            }),
        );
        await this.plugin.dataManager.savePluginData();
    }

    private async startReview(): Promise<void> {
        if (!this.loader || !this.cards.length) return;
        await this.persistDraft();
        this.loader.setPlannedSession(this.cards);
        await this.plugin.uiManager.openPreparedReview(this.loader);
    }
}
