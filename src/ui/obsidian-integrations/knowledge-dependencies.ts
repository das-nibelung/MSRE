import { App, TFile } from "obsidian";

import { KnowledgeDependencyEdge } from "src/scheduling/review-session-planner";

function prerequisiteValues(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap(prerequisiteValues);
    if (typeof value !== "string") return [];
    const links = [...value.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)]
        .map((match) => match[1]?.trim() ?? "")
        .filter(Boolean);
    if (links.length) return links;
    return value
        .split(/[,;\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function resolvePath(app: App, reference: string, dependentPath: string): string | null {
    const target = app.metadataCache.getFirstLinkpathDest(reference, dependentPath);
    if (target) return target.path;
    const direct = app.vault.getFileByPath(reference.replace(/^\/+/, ""));
    return direct instanceof TFile ? direct.path : null;
}

/** Reads the deliberately explicit, user-editable dependency property from Markdown notes. */
export function collectKnowledgeDependencies(
    app: App,
    sourcePaths: Iterable<string>,
): KnowledgeDependencyEdge[] {
    const edges: KnowledgeDependencyEdge[] = [];
    const seen = new Set<string>();
    for (const dependentPath of new Set(sourcePaths)) {
        const file = app.vault.getFileByPath(dependentPath);
        if (!(file instanceof TFile)) continue;
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
            Record<string, unknown> | undefined;
        const value = frontmatter?.["sr-prerequisites"] ?? frontmatter?.["srPrerequisites"];
        const reasons =
            frontmatter?.["sr-dependency-reasons"] &&
            typeof frontmatter["sr-dependency-reasons"] === "object"
                ? (frontmatter["sr-dependency-reasons"] as Record<string, unknown>)
                : {};
        for (const reference of prerequisiteValues(value)) {
            const prerequisitePath = resolvePath(app, reference, dependentPath);
            if (!prerequisitePath || prerequisitePath === dependentPath) continue;
            const key = `${prerequisitePath}\u0000${dependentPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({
                prerequisitePath,
                dependentPath,
                reason: typeof reasons[reference] === "string" ? reasons[reference] : undefined,
                source: frontmatter?.["sr-compiler-version"] ? "compiler" : "frontmatter",
            });
        }
    }
    return edges;
}
