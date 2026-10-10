import "src/ui/obsidian-ui-components/modals/modal-view.css";
import { App, Modal, Platform } from "obsidian";

import { SettingsManager } from "src/data/settings-manager";
import type SRPlugin from "src/main";
import ContentManager from "src/ui/obsidian-ui-components/content-container/content-manager";
import { ReviewQueueLoader } from "src/ui/review-queue-loader";
import EmulatedPlatform from "src/utils/platform-detector";

export class SRModalView extends Modal {
    private contentManager: ContentManager;
    private plugin: SRPlugin;
    private settingsManager: SettingsManager;
    private resizeObserver: ResizeObserver | null = null;
    private closeButtonFrame: number | null = null;
    private modalMutationObservers: MutationObserver[] = [];

    constructor(
        app: App,
        plugin: SRPlugin,
        settingsManager: SettingsManager,
        reviewQueueLoader: ReviewQueueLoader,
    ) {
        super(app);
        this.plugin = plugin;
        this.settingsManager = settingsManager;

        // Setup base containers
        if (Platform.isMobile || EmulatedPlatform().isMobile) {
            this.setModalSize(
                this.settingsManager.settings.flashcardHeightPercentageMobile,
                this.settingsManager.settings.flashcardWidthPercentageMobile,
            );
        } else {
            this.setModalSize(
                this.settingsManager.settings.flashcardHeightPercentage,
                this.settingsManager.settings.flashcardWidthPercentage,
            );

            this.resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
                void this.onResize(entries);
            });
            this.resizeObserver.observe(this.modalEl);
        }

        this.modalEl.setAttribute("id", "sr-modal-view");
        this.modalEl.addClass("sr-view");
        this.containerEl.addClass("sr-modal-host");
        this.removeNativeCloseButtons();

        this.contentEl.addClass("sr-modal-content");

        // Init static elements in views
        this.contentManager = new ContentManager(
            app,
            plugin,
            reviewQueueLoader,
            this.settingsManager.settings,
            this.contentEl,
            () => {
                this.close();
            },
        );
        this.plugin.uiManager.setContentManager(this.contentManager);
    }

    onOpen(): void {
        this.getHostDocuments().forEach((doc) => doc.body.addClass("sr-review-modal-open"));
        this.removeNativeCloseButtons();
        this.closeButtonFrame = activeWindow.requestAnimationFrame(() => {
            this.removeNativeCloseButtons();
        });
        this.getHostDocuments().forEach((doc) => {
            const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
            const observer = new Observer(() => {
                this.removeNativeCloseButtons();
            });
            observer.observe(doc.body, {
                attributes: true,
                attributeFilter: ["class", "aria-label"],
                childList: true,
                subtree: true,
            });
            this.modalMutationObservers.push(observer);
        });
        void this.contentManager.open();
    }

    onClose(): void {
        if (this.closeButtonFrame !== null) {
            activeWindow.cancelAnimationFrame(this.closeButtonFrame);
            this.closeButtonFrame = null;
        }
        this.modalMutationObservers.forEach((observer) => observer.disconnect());
        this.modalMutationObservers = [];
        this.getHostDocuments().forEach((doc) => doc.body.removeClass("sr-review-modal-open"));
        this.contentManager.close();
    }

    /**
     * Obsidian places the native mobile modal close button outside modalEl and
     * can mount it after onOpen on iOS. Obsidian has no public option to omit
     * the control, so remove it immediately and whenever the host reinserts it.
     */
    private removeNativeCloseButtons(): void {
        this.getHostDocuments().forEach((doc) => {
            doc.querySelectorAll<HTMLElement>(
                '.modal-close-button, [aria-label="Close"], [aria-label="Закрыть"]',
            ).forEach((button) => {
                if (button.hasClass("sr-modal-close-button")) return;
                button.remove();
            });

            doc.querySelectorAll<SVGElement>(".lucide-x").forEach((icon) => {
                const control = icon.closest<HTMLElement>(
                    "button, .clickable-icon, .modal-close-button",
                );
                if (
                    control === null ||
                    control.hasClass("sr-modal-close-button") ||
                    this.modalEl.contains(control)
                ) {
                    return;
                }

                const rect = control.getBoundingClientRect();
                const isTopRightSystemControl =
                    rect.top < 96 && rect.right > doc.documentElement.clientWidth - 96;
                if (isTopRightSystemControl) control.remove();
            });
        });
    }

    private getHostDocuments(): Document[] {
        return [...new Set([globalThis["document"], activeDocument])];
    }

    private async onResize(entries: ResizeObserverEntry[]) {
        const modalEl = entries[0].target as HTMLElement;
        const parent = modalEl.parentElement;

        if (parent === null) return;

        const elementHeight = modalEl.offsetHeight;
        const parentHeight = parent.offsetHeight;
        const heightPercent = (elementHeight / parentHeight) * 100;

        const elementWidth = modalEl.offsetWidth;
        const parentWidth = parent.offsetWidth;
        const widthPercent = (elementWidth / parentWidth) * 100;

        this.setRoundedModalCorners(!(heightPercent >= 100 || widthPercent >= 100));

        await this.saveSizeToSettings(
            heightPercent,
            widthPercent,
            Platform.isMobile || EmulatedPlatform().isMobile,
        );
    }

    private setRoundedModalCorners(rounded: boolean) {
        this.modalEl.setCssProps({ "border-Radius": rounded ? "var(--modal-radius)" : "0" });
    }

    private setModalSize(heightPercent: number, widthPercent: number) {
        this.modalEl.setCssProps({ height: heightPercent + "%" });
        this.modalEl.setCssProps({ width: widthPercent + "%" });

        this.setRoundedModalCorners(
            !(
                parseInt(this.modalEl.getCssPropertyValue("height").split("%")[0]) >= 100 ||
                parseInt(this.modalEl.getCssPropertyValue("width").split("%")[0]) >= 100
            ),
        );
    }

    private async saveSizeToSettings(
        heightPercent: number,
        widthPercent: number,
        isMobile: boolean,
    ) {
        if (isNaN(heightPercent) || isNaN(widthPercent)) return;

        if (isMobile) {
            this.settingsManager.settings.flashcardHeightPercentageMobile = heightPercent;
            this.settingsManager.settings.flashcardWidthPercentageMobile = widthPercent;
        } else {
            this.settingsManager.settings.flashcardHeightPercentage = heightPercent;
            this.settingsManager.settings.flashcardWidthPercentage = widthPercent;
        }
        await this.plugin.dataManager.savePluginData();
    }
}
