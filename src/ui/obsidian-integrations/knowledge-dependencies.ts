import { App, TFile } from "obsidian";

import { KnowledgeDependencyEdge } from "src/scheduling/review-session-planner";

export const KNOWLEDGE_RELATION_TYPES = [
    "prerequisite",
    "part",
    "example",
    "supports",
    "contradicts",
] as const;

export type KnowledgeRelationType = (typeof KNOWLEDGE_RELATION_TYPES)[number];

export interface KnowledgeRelationEdge {
    fromPath: string;
    toPath: string;
    type: KnowledgeRelationType;
    reason?: string;
    source: "manual" | "compiler" | "frontmatter";
}

interface StoredKnowledgeRelation {
    type: KnowledgeRelationType;
    target: string;
    reason?: string;
}

function isKnowledgeRelationType(value: unknown): value is KnowledgeRelationType {
    return (
        typeof value === "string" &&
        KNOWLEDGE_RELATION_TYPES.includes(value as KnowledgeRelationType)
    );
}

function storedRelations(value: unknown): StoredKnowledgeRelation[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const candidate = entry as Record<string, unknown>;
        if (!isKnowledgeRelationType(candidate.type) || typeof candidate.target !== "string")
            return [];
        const target = plainReference(candidate.target);
        if (!target) return [];
        return [
            {
                type: candidate.type,
                target,
                ...(typeof candidate.reason === "string" && candidate.reason.trim()
                    ? { reason: candidate.reason.trim() }
                    : {}),
            },
        ];
    });
}

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

/** Stores every semantic relation as portable Markdown frontmatter. Prerequisites also keep the
 * legacy property used by the scheduler, so the graph and review order never diverge. */
export async function addKnowledgeRelation(
    app: App,
    fromPath: string,
    toPath: string,
    type: KnowledgeRelationType,
    reason = "Manual knowledge-graph relation",
): Promise<boolean> {
    if (type === "prerequisite") return addKnowledgeDependency(app, toPath, fromPath, reason);
    const from = app.vault.getFileByPath(fromPath);
    const to = app.vault.getFileByPath(toPath);
    if (!(from instanceof TFile) || !(to instanceof TFile) || from.path === to.path) return false;
    await app.fileManager.processFrontMatter(from, (frontmatter) => {
        const data = frontmatter as Record<string, unknown>;
        const relations = storedRelations(data["sr-relations"]);
        const next = relations.filter(
            (relation) => !(relation.type === type && relation.target === to.path),
        );
        next.push({ type, target: to.path, ...(reason.trim() ? { reason: reason.trim() } : {}) });
        data["sr-relations"] = next.map((relation) => ({
            type: relation.type,
            target: `[[${relation.target}]]`,
            ...(relation.reason ? { reason: relation.reason } : {}),
        }));
    });
    return true;
}

export async function removeKnowledgeRelation(
    app: App,
    fromPath: string,
    toPath: string,
    type: KnowledgeRelationType,
): Promise<boolean> {
    if (type === "prerequisite") return removeKnowledgeDependency(app, toPath, fromPath);
    const from = app.vault.getFileByPath(fromPath);
    if (!(from instanceof TFile)) return false;
    await app.fileManager.processFrontMatter(from, (frontmatter) => {
        const data = frontmatter as Record<string, unknown>;
        data["sr-relations"] = storedRelations(data["sr-relations"])
            .filter((relation) => !(relation.type === type && relation.target === toPath))
            .map((relation) => ({
                type: relation.type,
                target: `[[${relation.target}]]`,
                ...(relation.reason ? { reason: relation.reason } : {}),
            }));
    });
    return true;
}

/** Collects typed graph relations while preserving existing prerequisite metadata. */
export function collectKnowledgeRelations(
    app: App,
    sourcePaths: Iterable<string>,
): KnowledgeRelationEdge[] {
    const paths = [...new Set(sourcePaths)];
    const relations: KnowledgeRelationEdge[] = collectKnowledgeDependencies(app, paths).map(
        (edge) => ({
            fromPath: edge.prerequisitePath,
            toPath: edge.dependentPath,
            type: "prerequisite",
            reason: edge.reason,
            source: edge.source,
        }),
    );
    const seen = new Set(
        relations.map((edge) => `${edge.type}\u0000${edge.fromPath}\u0000${edge.toPath}`),
    );
    for (const fromPath of paths) {
        const file = app.vault.getFileByPath(fromPath);
        if (!(file instanceof TFile)) continue;
        const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
            Record<string, unknown> | undefined;
        for (const relation of storedRelations(frontmatter?.["sr-relations"])) {
            const toPath = resolvePath(app, relation.target, fromPath);
            if (!toPath || toPath === fromPath) continue;
            const key = `${relation.type}\u0000${fromPath}\u0000${toPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            relations.push({
                fromPath,
                toPath,
                type: relation.type,
                reason: relation.reason,
                source: "frontmatter",
            });
        }
    }
    return relations;
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
