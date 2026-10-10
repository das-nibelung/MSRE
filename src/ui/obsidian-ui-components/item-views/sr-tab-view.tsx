import "src/ui/obsidian-ui-components/item-views/tab-view.css";
import { ItemView, Platform, setIcon, WorkspaceLeaf } from "obsidian";

import { SR_TAB_VIEW } from "src/data/constants";
import { SRSettings } from "src/data/settings";
import { t } from "src/lang/helpers";
import SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import ContentManager from "src/ui/obsidian-ui-components/content-container/content-manager";
import { ReviewQueueLoader } from "src/ui/review-queue-loader";
import EmulatedPlatform from "src/utils/platform-detector";

/**
 * Represents a tab view for spaced repetition plugin.
 *
 * This class extends the ItemView and is used to display the deck and flashcard uis.
 *
 * @property {SRPlugin} plugin - The main plugin instance.
 * @property {SRPlugin} leaf - The leaf instance for the view.
 * @property {ReviewQueueLoader} reviewQueueLoader - The review queue loader instance.
 *
 * @method getViewType - Returns the view type identifier.
 * @method getIcon - Returns the icon identifier for the view.
 * @method getDisplayText - Returns the display text for the view.
 * @method onOpen - Initializes the view and loads necessary data when opened.
 * @method onClose - Cleans up resources when the view is closed.
 */
export class SRTabView extends ItemView {
    private reviewQueueLoader: ReviewQueueLoader | null = null;
    private contentManager: ContentManager | null = null;

    private plugin: SRPlugin | null = null;
    private viewContainerEl: HTMLElement | null = null;
    private viewContentEl: HTMLElement | null = null;
    private settings: SRSettings | null = null;
    private openingPromise: Promise<void> | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        plugin: SRPlugin,
        settings: SRSettings,
        reviewQueueLoader: ReviewQueueLoader | null,
    ) {
        super(leaf);

        // Init properties
        this.plugin = plugin;
        this.navigation = false;
        this.settings = settings;
        this.reviewQueueLoader = reviewQueueLoader;

        // Build ui
        const viewContent = this.containerEl.getElementsByClassName("view-content");

        if (viewContent.length === 0) return;

        this.viewContainerEl = viewContent[0] as HTMLElement;
        this.viewContainerEl.addClass("sr-tab-view");
        this.viewContainerEl.addClass("sr-view");

        this.viewContentEl = this.viewContainerEl.createDiv("sr-tab-view-content");
        const isMobile: boolean = Platform.isMobile || EmulatedPlatform().isMobile;
        const heightPercent: number = isMobile
            ? this.settings.flashcardHeightPercentageMobile
            : this.settings.flashcardHeightPercentage;

        const widthPercent: number = isMobile
            ? this.settings.flashcardWidthPercentageMobile
            : this.settings.flashcardWidthPercentage;

        this.setSize(widthPercent, heightPercent);

        if (heightPercent < 100 || widthPercent < 100) {
            this.viewContentEl.addClass("sr-center-view");
        }
    }

    /**
     * Returns the view type identifier for the SRTabView.
     *
     * @returns {string} The view type identifier.
     */
    getViewType() {
        return SR_TAB_VIEW;
    }

    /**
     * Retrieves the icon identifier for the SRTabView.
     *
     * @returns {string} The tab icon identifier.
     */
    getIcon() {
        return "SpacedRepIcon";
    }

    /**
     * Returns the display text for the SRTabView.
     *
     * @returns {string} The display text for the SRTabView.
     */
    getDisplayText() {
        return "Spaced Repetition";
    }

    /**
     * Initializes the SRTabView when opened by loading the review sequencer data
     * and setting up the deck and flashcard views if they are not already initialized.
     */
    async onOpen() {
        await this.openContent();
    }

    /** Rehydrates a workspace-restored tab once the review command supplies its queue. */
    async setReviewQueueLoader(reviewQueueLoader: ReviewQueueLoader): Promise<void> {
        if (this.reviewQueueLoader === reviewQueueLoader && this.contentManager !== null) return;
        this.reviewQueueLoader = reviewQueueLoader;
        await this.openContent();
    }

    private async openContent(): Promise<void> {
        if (this.openingPromise !== null) return this.openingPromise;
        this.openingPromise = this.initializeContent().finally(() => {
            this.openingPromise = null;
        });
        return this.openingPromise;
    }

    private async initializeContent(): Promise<void> {
        if (this.viewContainerEl === null || this.viewContentEl === null) return;

        if (this.reviewQueueLoader === null || this.settings === null || this.plugin === null) {
            this.drawRecoveryState();
            return;
        }

        // Reposition the navbar if it's mobile, because lese it overlaps the buttons in the tab view
        if (activeDocument.body.classList.contains("is-mobile")) {
            const mobileNavbar = activeDocument.getElementsByClassName("mobile-navbar")[0];
            if (mobileNavbar) {
                (mobileNavbar as HTMLElement).setCssProps({ position: "relative" });
            }
        }

        // Removes the bottom fade mask if it's mobile and floating nav, because else it overlaps the bottom part of the flashcard and makes it hard to read
        if (
            activeDocument.body.classList.contains("is-phone") &&
            activeDocument.body.classList.contains("is-floating-nav")
        ) {
            activeDocument.body.style.setProperty(
                "--view-bottom-fade-mask",
                "linear-gradient(to top, rgba(0, 0, 0, 0.5) 0%, #000000 calc(16px - 0px))",
            );
        }

        this.contentManager?.close();
        this.viewContentEl.empty();
        this.viewContentEl.addClass("is-loading");
        this.drawLoadingState();

        try {
            this.contentManager = new ContentManager(
                this.app,
                this.plugin,
                this.reviewQueueLoader,
                this.settings,
                this.viewContentEl,
            );
            this.plugin.uiManager.setContentManager(this.contentManager);
            await this.contentManager.open();
            this.viewContentEl.removeClass("is-loading");
            this.viewContentEl.querySelector(".sr-view-status")?.remove();
        } catch (error) {
            console.error("Spaced Repetition: failed to open review view", error);
            this.contentManager?.close();
            this.contentManager = null;
            this.drawErrorState();
        }
    }

    private drawLoadingState(): void {
        if (!this.viewContentEl) return;
        const status = this.viewContentEl.createDiv("sr-view-status");
        const icon = status.createDiv("sr-view-status-icon is-loading");
        setIcon(icon, "loader-circle");
        status.createEl("h2", { text: t("REVIEW_VIEW_PREPARING") });
        status.createEl("p", { text: t("REVIEW_VIEW_PREPARING_HELP") });
    }

    private drawRecoveryState(): void {
        if (!this.viewContentEl) return;
        this.viewContentEl.empty();
        const status = this.viewContentEl.createDiv("sr-view-status");
        const icon = status.createDiv("sr-view-status-icon");
        setIcon(icon, "refresh-cw");
        status.createEl("h2", { text: t("REVIEW_VIEW_RESTORE") });
        status.createEl("p", {
            text: t("REVIEW_VIEW_RESTORE_HELP"),
        });
        const retry = status.createEl("button", { text: t("REVIEW_VIEW_OPEN_LIBRARY") });
        retry.addClass("mod-cta");
        retry.addEventListener("click", () => {
            if (!this.plugin?.isInitialized) {
                window.setTimeout(() => this.drawRecoveryState(), 350);
                return;
            }
            void this.plugin.uiManager.openDeckContainer(
                this.reviewQueueLoader?.getReviewMode() ?? FlashcardReviewMode.Review,
            );
        });
    }

    private drawErrorState(): void {
        if (!this.viewContentEl) return;
        this.viewContentEl.empty();
        this.viewContentEl.removeClass("is-loading");
        const status = this.viewContentEl.createDiv("sr-view-status is-error");
        const icon = status.createDiv("sr-view-status-icon");
        setIcon(icon, "triangle-alert");
        status.createEl("h2", { text: t("REVIEW_VIEW_ERROR") });
        status.createEl("p", {
            text: t("REVIEW_VIEW_ERROR_HELP"),
        });
        const retry = status.createEl("button", { text: t("TRY_AGAIN") });
        retry.addClass("mod-cta");
        retry.addEventListener("click", () => void this.openContent());
    }

    /**
     * Closes the SRTabView by shutting down any active deck or flashcard views.
     * Ensures that resources associated with these views are properly released.
     */

    // eslint-disable-next-line @typescript-eslint/require-await
    async onClose() {
        // Resets the changes made in onOpen
        if (activeDocument.body.classList.contains("is-mobile")) {
            const mobileNavbar = activeDocument.getElementsByClassName("mobile-navbar")[0];
            if (mobileNavbar) {
                (mobileNavbar as HTMLElement).setCssProps({ position: "unset" });
            }
        }

        // Resets the changes made in onOpen
        if (
            activeDocument.body.classList.contains("is-phone") &&
            activeDocument.body.classList.contains("is-floating-nav")
        ) {
            activeDocument.body.style.setProperty(
                "--view-bottom-fade-mask",
                "linear-gradient(to top, rgba(0, 0, 0, 0.5) 0%, #000000 calc(34px - 0px + 12px))",
            );
        }

        if (this.contentManager) this.contentManager.close();
    }

    private setSize(widthPercent: number, heightPercent: number) {
        if (!this.viewContentEl) return;
        this.viewContentEl.setCssProps({
            width: widthPercent + "%",
            "max-width": widthPercent + "%",
            height: heightPercent + "%",
            "max-height": heightPercent + "%",
        });
    }
}
