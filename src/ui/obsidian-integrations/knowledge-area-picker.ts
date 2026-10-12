import { ButtonComponent, Modal, Notice, Setting } from "obsidian";

import { NativeCardStore } from "src/data/native-card-store";
import type SRPlugin from "src/main";
import { generateKnowledgeCanvas } from "src/ui/obsidian-integrations/knowledge-canvas";

class CanvasAreaPicker extends Modal {
    constructor(
        private readonly plugin: SRPlugin,
        private readonly deck: string,
    ) {
        super(plugin.app);
    }

    onOpen(): void {
        this.contentEl.addClass("sr-area-picker");
        this.contentEl.createEl("h2", { text: "Assign knowledge area" });
        this.contentEl.createEl("p", {
            text: `Choose where “${this.deck}” belongs. Cards and source files will not be moved.`,
        });
        let selected = "";
        new Setting(this.contentEl).setName("Knowledge area").addDropdown((dropdown) => {
            dropdown.addOption("", "No knowledge area");
            for (const area of this.plugin.dataManager.data.knowledgeAreas.filter(
                (candidate) => !candidate.archivedAt,
            )) {
                dropdown.addOption(area.id, `${area.icon ? `${area.icon} ` : ""}${area.name}`);
            }
            dropdown.onChange((value) => (selected = value));
        });
        const actions = this.contentEl.createDiv("sr-bases-prompt-actions");
        new ButtonComponent(actions).setButtonText("Cancel").onClick(() => this.close());
        new ButtonComponent(actions)
            .setButtonText("Assign")
            .setCta()
            .onClick(() => void this.assign(selected || null));
    }

    private async assign(areaId: string | null): Promise<void> {
        const store = new NativeCardStore(this.plugin);
        if (areaId) await store.assignDeckToKnowledgeArea(this.deck, areaId);
        else await store.unassignDeckFromKnowledgeAreas(this.deck);
        await generateKnowledgeCanvas(this.plugin, { notify: false });
        this.close();
        new Notice(areaId ? "Deck assigned to knowledge area" : "Deck unassigned");
    }
}

export function openCanvasAreaPicker(plugin: SRPlugin, deck: string): void {
    new CanvasAreaPicker(plugin, deck).open();
}
