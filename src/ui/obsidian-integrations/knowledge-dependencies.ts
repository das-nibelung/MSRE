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

function plainReference(value: string): string {
    return value.replace(/^\[\[|\]\]$/g, "").trim();
}

/** Prevents contradictory prerequisite edits before they reach Markdown. */
export function wouldCreateKnowledgeCycle(
    edges: ReadonlyArray<Pick<KnowledgeDependencyEdge, "prerequisitePath" | "dependentPath">>,
    prerequisitePath: string,
    dependentPath: string,
): boolean {
    if (prerequisitePath === dependentPath) return true;
    const outgoing = new Map<string, string[]>();
    for (const edge of edges) {
        outgoing.set(edge.prerequisitePath, [
            ...(outgoing.get(edge.prerequisitePath) ?? []),
            edge.dependentPath,
        ]);
    }
    const visited = new Set<string>();
    const pending = [dependentPath];
    while (pending.length) {
        const current = pending.pop();
        if (!current || visited.has(current)) continue;
        if (current === prerequisitePath) return true;
        visited.add(current);
        pending.push(...(outgoing.get(current) ?? []));
    }
    return false;
}

export async function addKnowledgeDependency(
    app: App,
    dependentPath: string,
    prerequisitePath: string,
    reason = "Manual knowledge-graph dependency",
): Promise<boolean> {
    const dependent = app.vault.getFileByPath(dependentPath);
    const prerequisite = app.vault.getFileByPath(prerequisitePath);
    if (!(dependent instanceof TFile) || !(prerequisite instanceof TFile)) return false;
    if (dependent.path === prerequisite.path) return false;
    await app.fileManager.processFrontMatter(dependent, (frontmatter) => {
        const data = frontmatter as Record<string, unknown>;
        const existing = prerequisiteValues(data["sr-prerequisites"]).map(plainReference);
        data["sr-prerequisites"] = [...new Set([...existing, prerequisite.path])].map(
            (path) => `[[${path}]]`,
        );
        const reasons =
            data["sr-dependency-reasons"] &&
            typeof data["sr-dependency-reasons"] === "object" &&
            !Array.isArray(data["sr-dependency-reasons"])
                ? { ...(data["sr-dependency-reasons"] as Record<string, unknown>) }
                : {};
        reasons[prerequisite.path] = reason;
        data["sr-dependency-reasons"] = reasons;
        const sources =
            data["sr-dependency-sources"] &&
            typeof data["sr-dependency-sources"] === "object" &&
            !Array.isArray(data["sr-dependency-sources"])
                ? { ...(data["sr-dependency-sources"] as Record<string, unknown>) }
                : {};
        sources[prerequisite.path] = "manual";
        data["sr-dependency-sources"] = sources;
        const confidences =
            data["sr-dependency-confidence"] &&
            typeof data["sr-dependency-confidence"] === "object" &&
            !Array.isArray(data["sr-dependency-confidence"])
                ? { ...(data["sr-dependency-confidence"] as Record<string, unknown>) }
                : {};
        confidences[prerequisite.path] = 1;
        data["sr-dependency-confidence"] = confidences;
    });
    return true;
}

export async function removeKnowledgeDependency(
    app: App,
    dependentPath: string,
    prerequisitePath: string,
): Promise<boolean> {
    const dependent = app.vault.getFileByPath(dependentPath);
    if (!(dependent instanceof TFile)) return false;
    await app.fileManager.processFrontMatter(dependent, (frontmatter) => {
        const data = frontmatter as Record<string, unknown>;
        data["sr-prerequisites"] = prerequisiteValues(data["sr-prerequisites"])
            .map(plainReference)
            .filter((path) => path !== prerequisitePath)
            .map((path) => `[[${path}]]`);
        if (
            data["sr-dependency-reasons"] &&
            typeof data["sr-dependency-reasons"] === "object" &&
            !Array.isArray(data["sr-dependency-reasons"])
        ) {
            const reasons = { ...(data["sr-dependency-reasons"] as Record<string, unknown>) };
            delete reasons[prerequisitePath];
            data["sr-dependency-reasons"] = reasons;
        }
        for (const property of ["sr-dependency-sources", "sr-dependency-confidence"]) {
            if (
                data[property] &&
                typeof data[property] === "object" &&
                !Array.isArray(data[property])
            ) {
                const values = { ...(data[property] as Record<string, unknown>) };
                delete values[prerequisitePath];
                data[property] = values;
            }
        }
    });
    return true;
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
        const sources =
            frontmatter?.["sr-dependency-sources"] &&
            typeof frontmatter["sr-dependency-sources"] === "object"
                ? (frontmatter["sr-dependency-sources"] as Record<string, unknown>)
                : {};
        const confidences =
            frontmatter?.["sr-dependency-confidence"] &&
            typeof frontmatter["sr-dependency-confidence"] === "object"
                ? (frontmatter["sr-dependency-confidence"] as Record<string, unknown>)
                : {};
        for (const reference of prerequisiteValues(value)) {
            const prerequisitePath = resolvePath(app, reference, dependentPath);
            if (!prerequisitePath || prerequisitePath === dependentPath) continue;
            const key = `${prerequisitePath}\u0000${dependentPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const rawConfidence =
                confidences[reference] ??
                confidences[prerequisitePath] ??
                frontmatter?.["sr-compiler-confidence"];
            const rawSource = sources[reference] ?? sources[prerequisitePath];
            const confidence =
                typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
                    ? Math.max(0, Math.min(1, rawConfidence))
                    : undefined;
            edges.push({
                prerequisitePath,
                dependentPath,
                reason: typeof reasons[reference] === "string" ? reasons[reference] : undefined,
                source:
                    rawSource === "manual"
                        ? "manual"
                        : frontmatter?.["sr-compiler-version"]
                          ? "compiler"
                          : "frontmatter",
                ...(confidence === undefined ? {} : { confidence }),
            });
        }
    }
    return edges;
}
