import "src/ui/obsidian-ui-components/content-container/settings-page/statistics-page/statistics-page.css";
import {
    ArcElement,
    BarController,
    BarElement,
    CategoryScale,
    Chart,
    Legend,
    LinearScale,
    PieController,
    SubTitle,
    Title,
    Tooltip,
} from "chart.js";
import { ButtonComponent, Notice, setIcon, Setting, SettingGroup } from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import h from "vhtml";

import { DataManager } from "src/data/data-manager";
import { Stats } from "src/data/data-structures/deck/stats";
import { SettingsManager } from "src/data/settings-manager";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { RepItemState } from "src/scheduling/algorithms/base/repetition-item";
import { SRAlgorithm } from "src/scheduling/algorithms/base/sr-algorithm";
import { textInterval } from "src/scheduling/algorithms/osr/note-scheduling";
import {
    analyzeScheduler,
    optimizeFsrsWeights,
    SchedulerMetrics,
} from "src/scheduling/fsrs/scheduler-analytics";
import { SettingsPage } from "src/ui/obsidian-ui-components/content-container/settings-page/settings-page";
import { SettingsPageType } from "src/ui/obsidian-ui-components/content-container/settings-page/settings-page-manager";
import ChartComponent from "src/ui/obsidian-ui-components/content-container/settings-page/statistics-page/chart-component";
import NoteStatsComponent from "src/ui/obsidian-ui-components/content-container/settings-page/statistics-page/note-stats-component";
import { getKeysPreserveType, getTypedObjectEntries, mapRecord } from "src/utils/types";

Chart.register(
    BarElement,
    BarController,
    Legend,
    Title,
    Tooltip,
    SubTitle,
    CategoryScale,
    LinearScale,
    PieController,
    ArcElement,
);

/**
 * Represents a statistics settings page.
 *
 * @class StatisticsPage
 * @extends {SettingsPage}
 */
export class StatisticsPage extends SettingsPage {
    private forecastChart: ChartComponent | null = null;
    private intervalsChart: ChartComponent | null = null;
    private easesChart: ChartComponent | null = null;
    private cardTypesChart: ChartComponent | null = null;
    private noteStatsGrid: NoteStatsComponent | null = null;
    private selectedPresetId = "builtin-default-options";

    constructor(
        pageContainerEl: HTMLElement,
        plugin: SRPlugin,
        settingsManager: SettingsManager,
        dataManager: DataManager,
        pageType: SettingsPageType,
        openPage: (pageType: SettingsPageType) => void,
        scrollListener: (scrollPosition: number) => void,
    ) {
        super(
            pageContainerEl,
            plugin,
            settingsManager,
            dataManager,
            pageType,
            () => {},
            () => {},
            openPage,
            scrollListener,
        );
        this.containerEl.addClass("sr-statistics-page");
        this.plugin = plugin;
    }

    render(): void {
        this.destroyCharts();
        void this.renderCharts();
    }

    /**
     * Destroys the StatisticsPagea and all its components.
     */
    destroy(): void {
        this.destroyCharts();
        this.containerEl.removeEventListener("scroll", (_) => {
            this.scrollListener(this.containerEl.scrollTop);
        });
    }

    destroyCharts(): void {
        if (this.forecastChart !== null) this.forecastChart.destroy();
        if (this.intervalsChart !== null) this.intervalsChart.destroy();
        if (this.easesChart !== null) this.easesChart.destroy();
        if (this.cardTypesChart !== null) this.cardTypesChart.destroy();
        if (this.noteStatsGrid !== null) this.noteStatsGrid.destroy();

        this.forecastChart = null;
        this.intervalsChart = null;
        this.easesChart = null;
        this.cardTypesChart = null;
        this.noteStatsGrid = null;

        this.containerEl.empty();
    }

    private async renderCharts(): Promise<void> {
        await this.dataManager.sync();

        this.renderSchedulerLab();

        // TODO: Add a loading screen while it syncs

        // Add forecast
        const cardStats: Stats | null = this.dataManager.osrCore.cardStats;
        if (cardStats === null) {
            return;
        }

        let maxN: number = cardStats.delayedDays.getMaxValue();
        for (let dueOffset = 0; dueOffset <= maxN; dueOffset++) {
            cardStats.delayedDays.clearCountIfMissing(dueOffset);
        }

        const dueDatesFlashcardsCopy: Record<number, number> = { 0: 0 };
        for (const [dueOffset, dueCount] of getTypedObjectEntries(cardStats.delayedDays.dict)) {
            if (dueOffset <= 0) {
                dueDatesFlashcardsCopy[0] += dueCount;
            } else {
                dueDatesFlashcardsCopy[dueOffset] = dueCount;
            }
        }

        const scheduledCount: number = cardStats.youngCount + cardStats.matureCount;
        maxN = Math.max(maxN, 1);

        new Setting(this.containerEl)
            .setName(t("PERIOD_TITLE"))
            .setDesc(t("PERIOD_DESC"))
            .addDropdown((el) => {
                el.addOption("month", t("MONTH"))
                    .addOption("quarter", t("QUARTER"))
                    .addOption("year", t("YEAR"))
                    .addOption("lifetime", t("LIFETIME"))
                    .setValue("month");

                el.selectEl.setAttr("id", "sr-chart-period");
            });

        new SettingGroup(this.containerEl)
            .setHeading(t("FORECAST"))
            .addSetting((setting: Setting) => {
                this.forecastChart = new ChartComponent(
                    setting.settingEl,
                    "forecastChart",
                    "forecastChartSummary",
                    "bar",
                    "",
                    t("FORECAST_DESC"),
                    Object.keys(dueDatesFlashcardsCopy),
                    Object.values(dueDatesFlashcardsCopy),
                    t("REVIEWS_PER_DAY", { avg: (scheduledCount / maxN).toFixed(1) }),
                    t("SCHEDULED"),
                    t("DAYS"),
                    t("NUMBER_OF_CARDS"),
                );
            });

        maxN = cardStats.intervals.getMaxValue();
        for (let interval = 0; interval <= maxN; interval++) {
            cardStats.intervals.clearCountIfMissing(interval);
        }

        // Add intervals
        const averageInterval: string = textInterval(
            Math.round((cardStats.intervals.getTotalOfValueMultiplyCount() / scheduledCount) * 10) /
                10 || 0,
            false,
        );
        const longestInterval: string = textInterval(cardStats.intervals.getMaxValue(), false);

        new SettingGroup(this.containerEl)
            .setHeading(t("INTERVALS"))
            .addSetting((setting: Setting) => {
                this.intervalsChart = new ChartComponent(
                    setting.settingEl,
                    "intervalsChart",
                    "intervalsChartSummary",
                    "bar",
                    "",
                    t("INTERVALS_DESC"),
                    Object.keys(cardStats.intervals.dict),
                    Object.values(cardStats.intervals.dict),
                    t("INTERVALS_SUMMARY", { avg: averageInterval, longest: longestInterval }),
                    t("COUNT"),
                    t("DAYS"),
                    t("NUMBER_OF_CARDS"),
                );
            });

        // Add eases
        const eases: number[] = getKeysPreserveType(cardStats.eases.dict);
        for (let ease = Math.min(...eases); ease <= Math.max(...eases); ease++) {
            cardStats.eases.clearCountIfMissing(ease);
        }
        const averageEase: number =
            Math.round(cardStats.eases.getTotalOfValueMultiplyCount() / scheduledCount) || 0;

        new SettingGroup(this.containerEl).setHeading(t("EASES")).addSetting((setting: Setting) => {
            this.easesChart = new ChartComponent(
                setting.settingEl,
                "easesChart",
                "easesChartSummary",
                "bar",
                "",
                "",
                Object.keys(cardStats.eases.dict),
                Object.values(cardStats.eases.dict),
                t("EASES_SUMMARY", { avgEase: averageEase }),
                t("COUNT"),
                t("EASES"),
                t("NUMBER_OF_CARDS"),
            );
        });

        // Add card types
        const totalCardsCount: number =
            this.dataManager.osrCore.reviewableDeckTree.getDistinctRepItemCount(
                RepItemState.AnyItem,
                true,
            );

        new SettingGroup(this.containerEl)
            .setHeading(t("CARD_TYPES"))
            .addSetting((setting: Setting) => {
                this.cardTypesChart = new ChartComponent(
                    setting.settingEl,
                    "cardTypesChart",
                    "cardTypesChartSummary",
                    "pie",
                    "",
                    t("CARD_TYPES_DESC"),
                    [
                        `${t("CARD_TYPE_NEW")} - ${Math.round((cardStats.newCount / totalCardsCount) * 100)}%`,
                        `${t("CARD_TYPE_YOUNG")} - ${Math.round(
                            (cardStats.youngCount / totalCardsCount) * 100,
                        )}%`,
                        `${t("CARD_TYPE_MATURE")} - ${Math.round(
                            (cardStats.matureCount / totalCardsCount) * 100,
                        )}%`,
                    ],
                    [cardStats.newCount, cardStats.youngCount, cardStats.matureCount],
                    t("CARD_TYPES_SUMMARY", { totalCardsCount }),
                );
            });

        const noteEases = mapRecord(
            SRAlgorithm.getInstance().noteStats().dict,
            (key: string, value: number): [string, number] => {
                return [key.split(".")[0], Math.round(value)];
            },
        );

        new SettingGroup(this.containerEl).setHeading(t("NOTES")).addSetting((setting: Setting) => {
            this.noteStatsGrid = new NoteStatsComponent(setting.settingEl, noteEases);
        });
    }

    private renderSchedulerLab(): void {
        const collectionStore = this.dataManager.collectionStore;
        const collection = collectionStore.getCollectionSnapshot();
        const reviewLog = collectionStore.getReviewLogSnapshot();
        const metrics = analyzeScheduler(
            collection,
            reviewLog,
            this.dataManager.data.knowledgeAreas,
        );
        const presets = collectionStore.getDeckOptions();
        if (!presets.some((preset) => preset.id === this.selectedPresetId)) {
            this.selectedPresetId = presets[0]?.id ?? "builtin-default-options";
        }
        const selected = presets.find((preset) => preset.id === this.selectedPresetId);

        const hero = this.containerEl.createDiv("sr-fsrs-lab-hero");
        const heroCopy = hero.createDiv();
        const eyebrow = heroCopy.createDiv("sr-fsrs-eyebrow");
        const spark = eyebrow.createSpan();
        setIcon(spark, "sparkles");
        eyebrow.createSpan({ text: "FSRS LAB" });
        heroCopy.createEl("h1", { text: "Scheduler & memory" });
        heroCopy.createEl("p", {
            text: "Measure recall, tune FSRS from your own history, and see tomorrow's workload before changing anything.",
        });
        const preset = hero.createEl("select", {
            cls: "dropdown sr-fsrs-preset",
            attr: { "aria-label": "Scheduler preset" },
        });
        for (const option of presets) {
            const optionEl = preset.createEl("option", {
                text: option.name,
                value: option.id,
            });
            optionEl.selected = option.id === this.selectedPresetId;
        }
        preset.addEventListener("change", () => {
            this.selectedPresetId = preset.value;
            this.render();
        });

        const metricGrid = this.containerEl.createDiv("sr-fsrs-metric-grid");
        this.renderMetric(
            metricGrid,
            "True retention",
            this.percent(metrics.trueRetention),
            "Actual successful recalls",
        );
        this.renderMetric(
            metricGrid,
            "Log loss",
            metrics.logLoss.toFixed(3),
            "Prediction calibration",
        );
        this.renderMetric(metricGrid, "RMSE", metrics.rmse.toFixed(3), "Prediction error");
        this.renderMetric(
            metricGrid,
            "Response",
            this.duration(metrics.averageResponseMs),
            `${metrics.reviewCount} reviews`,
        );

        const actionPanel = this.containerEl.createDiv("sr-fsrs-action-panel");
        const actionCopy = actionPanel.createDiv();
        actionCopy.createEl("h2", {
            text: selected?.optimization ? "Personal model ready" : "Personalize FSRS",
        });
        actionCopy.createEl("p", {
            text: selected?.optimization
                ? `Calibrated on ${selected.optimization.sampleSize} reviews · ${new Date(selected.optimization.optimizedAt).toLocaleDateString()}`
                : "Calibration is local and uses only your immutable review history.",
        });
        const actionButtons = actionPanel.createDiv("sr-fsrs-action-buttons");
        new ButtonComponent(actionButtons)
            .setButtonText("Optimize")
            .setCta()
            .onClick(() => void this.optimizePreset());
        new ButtonComponent(actionButtons)
            .setButtonText("Reschedule")
            .setDisabled(!selected?.optimization)
            .onClick(() => void this.reschedulePreset());

        const twoColumn = this.containerEl.createDiv("sr-fsrs-two-column");
        this.renderActivity(twoColumn, metrics);
        this.renderForecast(twoColumn, metrics);
        this.renderRatings(twoColumn, metrics);
        this.renderMemoryState(twoColumn, metrics);
        this.renderRankings(twoColumn, "Difficult topics", metrics.difficultTopics);
        this.renderRankings(twoColumn, "Problematic templates", metrics.problematicTemplates);
        if (metrics.knowledgeAreaEfficiency.length) {
            this.renderAreaEfficiency(twoColumn, metrics);
        }
    }

    private renderMetric(parent: HTMLElement, label: string, value: string, detail: string): void {
        const card = parent.createDiv("sr-fsrs-metric");
        card.createSpan({ text: label });
        card.createEl("strong", { text: value });
        card.createEl("small", { text: detail });
    }

    private renderActivity(parent: HTMLElement, metrics: SchedulerMetrics): void {
        const panel = this.createPanel(parent, "Review activity", "Last 12 weeks");
        const heatmap = panel.createDiv("sr-fsrs-heatmap");
        const max = Math.max(1, ...metrics.activity.map((item) => item.count));
        for (const item of metrics.activity) {
            const cell = heatmap.createSpan("sr-fsrs-heat-cell");
            cell.setCssProps({ "--sr-intensity": String(item.count / max) });
            cell.setAttribute("aria-label", `${item.day}: ${item.count} reviews`);
            cell.setAttribute("title", `${item.day}: ${item.count}`);
        }
    }

    private renderForecast(parent: HTMLElement, metrics: SchedulerMetrics): void {
        const total = metrics.forecast.reduce((sum, item) => sum + item.count, 0);
        const panel = this.createPanel(
            parent,
            "Workload forecast",
            `${total} reviews · next 90 days`,
        );
        const bars = panel.createDiv("sr-fsrs-forecast");
        const firstMonth = metrics.forecast.slice(0, 30);
        const max = Math.max(1, ...firstMonth.map((item) => item.count));
        for (const item of firstMonth) {
            const bar = bars.createSpan("sr-fsrs-forecast-bar");
            bar.setCssProps({ height: `${Math.max(4, (item.count / max) * 100)}%` });
            bar.title = `${item.day}: ${item.count}`;
        }
        const simulator = panel.createDiv("sr-fsrs-simulator");
        const simulatorCopy = simulator.createDiv();
        simulatorCopy.createSpan({ text: "Retention scenario" });
        const simulation = simulatorCopy.createEl("strong");
        const retention = simulator.createEl("input", {
            attr: {
                type: "range",
                min: "75",
                max: "99",
                step: "1",
                value: String(
                    Math.round(
                        (this.dataManager.collectionStore.getDeckOptionsById(this.selectedPresetId)
                            ?.desiredRetention ?? 0.9) * 100,
                    ),
                ),
                "aria-label": "Simulated desired retention",
            },
        });
        const updateSimulation = () => {
            const target = Number(retention.value) / 100;
            const projected = Math.round(total * Math.pow(target / 0.9, 2.4));
            simulation.setText(`${retention.value}% · ≈ ${projected} reviews / 90 days`);
        };
        retention.addEventListener("input", updateSimulation);
        updateSimulation();
    }

    private renderRatings(parent: HTMLElement, metrics: SchedulerMetrics): void {
        const panel = this.createPanel(parent, "Answer quality", "Again · Hard · Good · Easy");
        const total = Math.max(
            1,
            metrics.ratings.reduce((sum, value) => sum + value, 0),
        );
        const strip = panel.createDiv("sr-fsrs-rating-strip");
        const labels = ["Again", "Hard", "Good", "Easy"];
        metrics.ratings.forEach((count, index) => {
            const segment = strip.createSpan(`is-rating-${index + 1}`);
            segment.setCssProps({ width: `${(count / total) * 100}%` });
        });
        const legend = panel.createDiv("sr-fsrs-rating-legend");
        labels.forEach((label, index) =>
            legend.createSpan({ text: `${label} ${metrics.ratings[index]}` }),
        );
    }

    private renderMemoryState(parent: HTMLElement, metrics: SchedulerMetrics): void {
        const panel = this.createPanel(parent, "Memory state", "Live FSRS card state");
        const rows: Array<[string, string]> = [
            ["Stability", `${metrics.averageStability.toFixed(1)} d`],
            ["Difficulty", metrics.averageDifficulty.toFixed(1)],
            ["Retrievability", this.percent(metrics.averageRetrievability)],
        ];
        for (const [label, value] of rows) {
            const row = panel.createDiv("sr-fsrs-stat-row");
            row.createSpan({ text: label });
            row.createEl("strong", { text: value });
        }
    }

    private renderRankings(
        parent: HTMLElement,
        title: string,
        rows: Array<{ name: string; score: number; cards: number }>,
    ): void {
        const panel = this.createPanel(parent, title, "Ranked by lapse rate");
        if (!rows.length) panel.createDiv({ cls: "sr-fsrs-empty", text: "No review data yet" });
        for (const item of rows) {
            const row = panel.createDiv("sr-fsrs-stat-row");
            const copy = row.createDiv();
            copy.createSpan({ text: item.name });
            copy.createEl("small", { text: `${item.cards} cards` });
            row.createEl("strong", { text: this.percent(item.score) });
        }
    }

    private renderAreaEfficiency(parent: HTMLElement, metrics: SchedulerMetrics): void {
        const panel = this.createPanel(parent, "Knowledge areas", "Retention by area");
        for (const area of metrics.knowledgeAreaEfficiency) {
            const row = panel.createDiv("sr-fsrs-stat-row");
            const copy = row.createDiv();
            copy.createSpan({ text: area.name });
            copy.createEl("small", { text: `${area.reviews} reviews` });
            row.createEl("strong", { text: this.percent(area.retention) });
        }
    }

    private createPanel(parent: HTMLElement, title: string, detail: string): HTMLElement {
        const panel = parent.createDiv("sr-fsrs-panel");
        const header = panel.createDiv("sr-fsrs-panel-header");
        header.createEl("h3", { text: title });
        header.createSpan({ text: detail });
        return panel;
    }

    private async optimizePreset(): Promise<void> {
        const store = this.dataManager.collectionStore;
        const preset = store.getDeckOptionsById(this.selectedPresetId);
        if (!preset) return;
        const collection = store.getCollectionSnapshot();
        const eligibleDecks = new Set(
            Object.values(collection.decks)
                .filter((deck) => !deck.deletedAt && deck.optionsId === preset.id)
                .map((deck) => deck.id),
        );
        const cardIds = new Set(
            Object.values(collection.cards)
                .filter((card) => !card.deletedAt && eligibleDecks.has(card.deckId))
                .map((card) => card.id),
        );
        const log = store.getReviewLogSnapshot();
        log.entries = Object.fromEntries(
            Object.entries(log.entries).filter(([, entry]) => cardIds.has(entry.cardId)),
        );
        const result = optimizeFsrsWeights(log, preset.fsrsWeights);
        if (result.sampleSize < 20) {
            new Notice("At least 20 reviews are recommended; the current result is provisional.");
        }
        await store.saveDeckOptions({
            ...preset,
            fsrsWeights: result.weights,
            optimization: { ...result, optimizedAt: Date.now() },
        });
        new Notice(`FSRS optimized from ${result.sampleSize} reviews.`);
        this.render();
    }

    private async reschedulePreset(): Promise<void> {
        const store = this.dataManager.collectionStore;
        const preset = store.getDeckOptionsById(this.selectedPresetId);
        if (!preset?.optimization) return;
        const collection = store.getCollectionSnapshot();
        const deckPaths = Object.values(collection.decks)
            .filter((deck) => !deck.deletedAt && deck.optionsId === preset.id)
            .map((deck) => deck.name);
        const count = await store.rescheduleFsrsCards({
            deckPaths,
            desiredRetention: preset.desiredRetention,
            stabilityScale: preset.optimization.stabilityScale,
            loadBalance: preset.loadBalance,
        });
        new Notice(`${count} FSRS cards rescheduled. A backup was created first.`);
        this.render();
    }

    private percent(value: number): string {
        return `${Math.round(value * 100)}%`;
    }

    private duration(value: number): string {
        if (!value) return "—";
        return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
    }
}
