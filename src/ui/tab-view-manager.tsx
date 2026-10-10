import { PaneType, WorkspaceLeaf } from "obsidian";

import { CARD_BROWSER_VIEW_TYPE, CARD_CREATOR_VIEW_TYPE, SR_TAB_VIEW } from "src/data/constants";
import { SettingsManager } from "src/data/settings-manager";
import SRPlugin from "src/main";
import { CardBrowserView } from "src/ui/card-browser/card-browser-view";
import { NativeCreatorRequest, NativeCreatorView } from "src/ui/native-creator/native-creator-view";
import { SRTabView } from "src/ui/obsidian-ui-components/item-views/sr-tab-view";
import { ReviewQueueLoader } from "src/ui/review-queue-loader";
import { TabViewType } from "src/utils/types";

/**
 * Manages tab views for the Spaced Repetition plugin, allowing for the opening and closing
 * of tabbed views within the application. Handles the registration of different tab view types
 * and facilitates the creation of new tab views based on the specified review mode and optional
 * single note. Ensures that tab views are properly initialized and revealed within the workspace.
 *
 * @property {SRPlugin} plugin - The main plugin instance.
 *
 * @method openSRTabView - Opens a new tab view for the specified review mode and optional single note.
 * @method closeAllTabViews - Closes all tab views.
 */
export default class TabViewManager {
    private plugin: SRPlugin;
    private settingsManager: SettingsManager;
    private reviewQueueLoader: ReviewQueueLoader | null = null;
    private creatorRequest: NativeCreatorRequest = { mode: "card" };

    // Add any new other tab view types to this, then they'll be automatically registered
    private tabViewTypes: TabViewType[] = [
        {
            type: SR_TAB_VIEW,
            viewCreator: (leaf) => {
                return new SRTabView(
                    leaf,
                    this.plugin,
                    this.settingsManager.settings,
                    this.reviewQueueLoader,
                );
            },
        },
        {
            type: CARD_BROWSER_VIEW_TYPE,
            viewCreator: (leaf) => new CardBrowserView(leaf, this.plugin),
        },
        {
            type: CARD_CREATOR_VIEW_TYPE,
            viewCreator: (leaf) => {
                const view = new NativeCreatorView(leaf, this.plugin);
                view.configure(this.creatorRequest);
                return view;
            },
        },
    ];

    // Add any needed resource
    constructor(plugin: SRPlugin, settingsManager: SettingsManager) {
        this.settingsManager = settingsManager;
        this.plugin = plugin;
    }

    /**
     * Opens the Spaced Repetition tab view in the application.
     *
     * This method sets up the necessary state for the tab view and invokes the
     * internal method to open the tab view with the specified parameters.
     *
     * @param osrAppCore - The core application instance used for managing reviewable decks.
     * @param reviewMode - The mode of flashcard review.
     * @param singleNote - Optional parameter specifying a single note to review.
     *                     If provided, the tab view will focus on this note.
     *
     * @returns {Promise<void>} - A promise that resolves when the tab view is opened.
     */
    public async openSRTabView(reviewQueueLoader: ReviewQueueLoader) {
        this.reviewQueueLoader = reviewQueueLoader;

        await this.openTabView(SR_TAB_VIEW, true);
    }

    public async openCardBrowser(notePath: string | null = null): Promise<void> {
        const leaf = await this.openTabView(CARD_BROWSER_VIEW_TYPE, true);
        if (leaf?.view instanceof CardBrowserView) leaf.view.setNoteScope(notePath);
    }

    public refreshCardBrowser(): void {
        for (const leaf of this.plugin.app.workspace.getLeavesOfType(CARD_BROWSER_VIEW_TYPE)) {
            if (leaf.view instanceof CardBrowserView) leaf.view.refresh();
        }
    }

    public async openNativeCreator(request: NativeCreatorRequest): Promise<void> {
        this.creatorRequest = request;
        const leaf = await this.openTabView(CARD_CREATOR_VIEW_TYPE, true);
        if (leaf?.view instanceof NativeCreatorView) leaf.view.configure(request);
    }

    /**
     * Closes all open tab views in the application.
     *
     * This method iterates over all registered tab view types and detaches
     * their corresponding leaves from the workspace, effectively closing them.
     */
    public closeAllTabViews() {
        for (const { type } of this.tabViewTypes) {
            this.plugin.app.workspace
                .getLeavesOfType(type)
                .forEach((leaf: WorkspaceLeaf) => leaf.detach());
        }
    }

    public forEachTabViewType(callback: (type: TabViewType) => void) {
        this.tabViewTypes.forEach((type) => callback(type));
    }

    public registerAllTabViews() {
        this.forEachTabViewType((viewType) =>
            this.plugin.registerView(viewType.type, viewType.viewCreator),
        );
    }

    public async openTabView(
        type: string,
        newLeaf?: PaneType | boolean,
    ): Promise<WorkspaceLeaf | null> {
        const { workspace } = this.plugin.app;

        let leaf: WorkspaceLeaf | null;
        const leaves = workspace.getLeavesOfType(type);

        if (leaves.length > 0) {
            // A leaf with our view already exists, use that
            leaf = leaves[0];
        } else {
            // Our view could not be found in the workspace, create a new leaf as a tab
            leaf = workspace.getLeaf(newLeaf);
            if (leaf !== null && leaf !== undefined) {
                await leaf.setViewState({ type: type, active: true });
            }
        }

        // "Reveal" the leaf in case it is in a collapsed sidebar
        if (leaf !== null && leaf !== undefined) {
            await workspace.revealLeaf(leaf);
        }
        return leaf ?? null;
    }
}
