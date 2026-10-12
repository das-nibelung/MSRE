import { Keymap } from "obsidian";

import type SRPlugin from "src/main";

export const SR_HOVER_SOURCE = "personal-spaced-repetition";

export function cardSourceTarget(notePath: string, blockId?: string | null): string {
    if (!blockId) return notePath;
    const normalizedBlockId = blockId.startsWith("^") ? blockId : `^${blockId}`;
    return `${notePath}#${normalizedBlockId}`;
}

export function attachObsidianLink(
    plugin: SRPlugin,
    element: HTMLElement,
    target: string,
    sourcePath: string,
): void {
    if (element.dataset.srObsidianLink === "true") return;
    element.dataset.srObsidianLink = "true";
    element.addClass("internal-link");
    element.setAttribute("data-href", target);
    if (element instanceof HTMLAnchorElement) element.href = target;

    element.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const newLeaf = event.button === 1 || Keymap.isModEvent(event);
        void plugin.app.workspace.openLinkText(target, sourcePath, newLeaf);
    });
    element.addEventListener("mouseover", (event: MouseEvent) => {
        plugin.app.workspace.trigger("hover-link", {
            event,
            source: SR_HOVER_SOURCE,
            hoverParent: plugin,
            targetEl: element,
            linktext: target,
            sourcePath,
        });
    });
}

export function enhanceRenderedObsidianLinks(
    plugin: SRPlugin,
    root: HTMLElement,
    sourcePath: string,
): void {
    root.findAll(".internal-link").forEach((element) => {
        const target = element.getAttr("data-href") || element.getAttr("href");
        if (target) attachObsidianLink(plugin, element, target, sourcePath);
    });
}
