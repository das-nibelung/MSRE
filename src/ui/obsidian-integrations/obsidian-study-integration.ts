import {
    ButtonComponent,
    MarkdownPostProcessorContext,
    normalizePath,
    Notice,
    TFile,
} from "obsidian";

import type SRPlugin from "src/main";
import { FlashcardReviewMode } from "src/scheduling/flashcard-review-sequencer";
import {
    CardBrowserRecord,
    compactCardText,
    filterCardBrowserRecords,
} from "src/ui/card-browser/card-browser-model";
import { attachObsidianLink } from "src/ui/obsidian-integrations/obsidian-links";
import { createStudyRecords } from "src/ui/obsidian-integrations/study-records";

const GENERATED_START = "<!-- msre:knowledge-hub:start -->";
const GENERATED_END = "<!-- msre:knowledge-hub:end -->";

interface StudyEmbedConfig {
    query: string;
    deck: string;
    limit: number;
    title: string;
    view: "cards" | "links" | "summary";
}

function parseConfig(source: string): StudyEmbedConfig {
    const values = new Map<string, string>();
    for (const line of source.split("\n")) {
        const separator = line.indexOf(":");
        if (separator < 0) continue;
        values.set(
            line.slice(0, separator).trim().toLocaleLowerCase(),
            line.slice(separator + 1).trim(),
        );
    }
    const rawView = values.get("view");
    const view = rawView === "links" || rawView === "summary" ? rawView : "cards";
    return {
        query: values.get("query") ?? "is:due OR is:new",
        deck: values.get("deck") ?? "all",
        limit: Math.max(1, Math.min(50, Number(values.get("limit")) || 6)),
        title: values.get("title") ?? "Study",
        view,
    };
}

function stableIds(records: CardBrowserRecord[]): string[] {
    return records.map((record) => record.card.stableId).filter((id): id is string => Boolean(id));
}

function renderMetrics(parent: HTMLElement, records: CardBrowserRecord[]): void {
    const metrics = parent.createDiv("sr-study-embed-metrics");
    const values = [
        ["Cards", records.length],
        ["Due", records.filter((record) => record.state === "due").length],
        ["New", records.filter((record) => record.state === "new").length],
        ["Lapses", records.reduce((sum, record) => sum + (record.lapses ?? 0), 0)],
    ] as const;
    for (const [label, value] of values) {
        const item = metrics.createDiv("sr-study-embed-metric");
        item.createEl("strong", { text: String(value) });
        item.createSpan({ text: label });
    }
}

function linkedPaths(
    plugin: SRPlugin,
    sourcePath: string,
): Array<{ path: string; direction: string }> {
    const outgoing = Object.keys(plugin.app.metadataCache.resolvedLinks[sourcePath] ?? {}).map(
        (path) => ({ path, direction: "Outgoing" }),
    );
    const backlinks = Object.entries(plugin.app.metadataCache.resolvedLinks)
        .filter(([, destinations]) => sourcePath in destinations)
        .map(([path]) => ({ path, direction: "Backlink" }));
    return [...outgoing, ...backlinks].filter(
        (item, index, all) => all.findIndex((candidate) => candidate.path === item.path) === index,
    );
}

export function registerStudyMarkdownBlocks(plugin: SRPlugin): void {
    plugin.registerMarkdownCodeBlockProcessor(
        "spaced-repetition",
        (source: string, element: HTMLElement, context: MarkdownPostProcessorContext) => {
            const config = parseConfig(source);
            const records = filterCardBrowserRecords(
                createStudyRecords(plugin),
                config.query,
                "all",
                config.deck,
            );
            element.addClass("sr-study-embed");
            const header = element.createDiv("sr-study-embed-header");
            const heading = header.createDiv();
            heading.createEl("strong", { text: config.title });
            heading.createSpan({
                text: config.deck === "all" ? config.query || "All cards" : config.deck,
            });
            const actions = header.createDiv("sr-study-embed-actions");
            new ButtonComponent(actions)
                .setIcon("library-big")
                .setTooltip("Browse cards")
                .onClick(
                    () => void plugin.uiManager.openCardBrowser(null, config.query, config.deck),
                );
            new ButtonComponent(actions)
                .setIcon("play")
                .setTooltip("Review these cards")
                .setCta()
                .onClick(() => {
                    const ids = stableIds(
                        records.filter((record) => record.lifecycleState === "active"),
                    );
                    if (!ids.length) return new Notice("No matching cards to review");
                    void plugin.uiManager.openDeckContainer(
                        FlashcardReviewMode.Review,
                        undefined,
                        ids,
                    );
                });

            renderMetrics(element, records);
            if (config.view === "summary") return;

            const list = element.createDiv("sr-study-embed-list");
            if (config.view === "links") {
                const links = linkedPaths(plugin, context.sourcePath).slice(0, config.limit);
                if (!links.length)
                    list.createSpan({ text: "No linked notes", cls: "sr-study-embed-empty" });
                for (const item of links) {
                    const row = list.createDiv("sr-study-embed-link");
                    row.createSpan({ text: item.direction });
                    const file = plugin.app.vault.getFileByPath(item.path);
                    const anchor = row.createEl("a", {
                        text: file?.basename ?? item.path,
                        href: item.path,
                    });
                    attachObsidianLink(plugin, anchor, item.path, context.sourcePath);
                }
                return;
            }

            for (const record of records.slice(0, config.limit)) {
                const row = list.createDiv("sr-study-embed-card");
                const content = row.createDiv();
                content.createEl("strong", { text: compactCardText(record.front) || "Media card" });
                content.createSpan({
                    text: `${record.deckNames[0] ?? "No deck"} · ${record.state}`,
                });
                const anchor = row.createEl("a", { text: "Open", href: record.notePath });
                attachObsidianLink(plugin, anchor, record.notePath, context.sourcePath);
            }
            if (records.length > config.limit) {
                list.createSpan({
                    cls: "sr-study-embed-more",
                    text: `+${records.length - config.limit} more in the browser`,
                });
            }
        },
    );
}

export async function syncStudyProperties(plugin: SRPlugin, files?: TFile[]): Promise<number> {
    const records = createStudyRecords(plugin);
    const paths = new Set((files ?? plugin.app.vault.getMarkdownFiles()).map((file) => file.path));
    const grouped = new Map<string, CardBrowserRecord[]>();
    for (const record of records) {
        if (!paths.has(record.notePath)) continue;
        const group = grouped.get(record.notePath) ?? [];
        group.push(record);
        grouped.set(record.notePath, group);
    }
    let updated = 0;
    for (const [path, cards] of grouped) {
        const file = plugin.app.vault.getFileByPath(path);
        if (!file) continue;
        await plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
            const properties = frontmatter as Record<string, unknown>;
            properties["sr_cards"] = cards.length;
            properties["sr_due"] = cards.filter((card) => card.state === "due").length;
            properties["sr_new"] = cards.filter((card) => card.state === "new").length;
            properties["sr_lapses"] = cards.reduce((sum, card) => sum + (card.lapses ?? 0), 0);
            properties["sr_decks"] = [...new Set(cards.flatMap((card) => card.deckNames))];
            properties["sr_areas"] = [...new Set(cards.flatMap((card) => card.areaNames ?? []))];
            const retentions = cards
                .map((card) => card.retention)
                .filter((value): value is number => value !== null && value !== undefined);
            if (retentions.length) {
                properties["sr_retention"] = Number(
                    (retentions.reduce((sum, value) => sum + value, 0) / retentions.length).toFixed(
                        3,
                    ),
                );
            } else delete properties["sr_retention"];
            properties["sr_updated"] = new Date().toISOString();
        });
        updated++;
    }
    return updated;
}

function mocPath(plugin: SRPlugin): string {
    return normalizePath(
        `${plugin.dataManager.data.settings.scheduleDataVaultLocation}/Knowledge Hub.md`,
    );
}

async function ensureFolder(plugin: SRPlugin, path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        if (!plugin.app.vault.getAbstractFileByPath(current)) {
            await plugin.app.vault.createFolder(current);
        }
    }
}

export async function generateKnowledgeMoc(
    plugin: SRPlugin,
    options: { open?: boolean; notify?: boolean } = {},
): Promise<TFile> {
    await ensureFolder(plugin, plugin.dataManager.data.settings.scheduleDataVaultLocation);
    const records = createStudyRecords(plugin);
    const lines = [
        GENERATED_START,
        "# Knowledge Hub",
        "",
        "> [!tip] Live study dashboard",
        "> This section is maintained by Personal Spaced Repetition. Content outside the markers is preserved.",
        "",
        "```spaced-repetition",
        "title: Ready to study",
        "query: is:due OR is:new",
        "limit: 8",
        "view: cards",
        "```",
        "",
        "## Knowledge areas",
        "",
    ];
    const areas = plugin.dataManager.data.knowledgeAreas.filter((area) => !area.archivedAt);
    for (const area of areas) {
        const cards = records.filter((record) =>
            record.deckNames.some((deck) => area.deckPaths.includes(deck)),
        );
        const due = cards.filter((card) => card.state === "due").length;
        lines.push(
            `### ${area.icon ? `${area.icon} ` : ""}${area.name}`,
            "",
            `${cards.length} cards · ${due} due · ${area.deckPaths.length} decks · [Browse](obsidian://msre?action=open-browser&query=${encodeURIComponent(`area:${area.name}`)}) · [Review](obsidian://msre?action=review&query=${encodeURIComponent(`area:${area.name}`)}) · [Map](obsidian://msre?action=canvas-control&area=${encodeURIComponent(area.id)})`,
            "",
        );
        const sources = [...new Set(cards.map((card) => card.notePath).filter(Boolean))].slice(
            0,
            12,
        );
        if (sources.length)
            lines.push(
                sources
                    .map((path) => `- [[${path}|${path.split("/").pop()?.replace(/\.md$/, "")}]]`)
                    .join("\n"),
                "",
            );
    }
    lines.push(GENERATED_END);
    const generated = lines.join("\n");
    const path = mocPath(plugin);
    const existing = plugin.app.vault.getFileByPath(path);
    let file: TFile;
    if (existing) {
        const current = await plugin.app.vault.read(existing);
        const start = current.indexOf(GENERATED_START);
        const end = current.indexOf(GENERATED_END);
        const content =
            start >= 0 && end >= start
                ? `${current.slice(0, start)}${generated}${current.slice(end + GENERATED_END.length)}`
                : `${current.trim()}\n\n${generated}\n`;
        await plugin.app.vault.modify(existing, content);
        file = existing;
    } else {
        file = await plugin.app.vault.create(path, `${generated}\n`);
    }
    if (options.open) await plugin.app.workspace.getLeaf("tab").openFile(file);
    if (options.notify) new Notice("Knowledge Hub updated");
    return file;
}

export function studyEmbedTemplate(notePath?: string): string {
    return [
        "```spaced-repetition",
        "title: Study",
        notePath ? `query: note:${notePath}` : "query: is:due OR is:new",
        "limit: 6",
        "view: cards",
        "```",
    ].join("\n");
}
