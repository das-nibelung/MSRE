import { App, TFile } from "obsidian";

import {
    AtomicVaultWriter,
    VaultWriteConflictError,
} from "src/data/reliability/atomic-vault-writer";
import {
    knowledgeCompilerKey,
    knowledgeSourceFingerprint,
    splitKnowledgeSource,
} from "src/intelligence/knowledge-provenance";

export interface KnowledgeCompilerMigrationReport {
    migrated: number;
    skipped: number;
    conflicts: number;
    failed: number;
}

export interface KnowledgeCompilerV2Patch {
    "sr-compiler-key": string;
    "sr-compiler-version": 2;
    "sr-concept-id": string;
    "sr-migrated-from": 1;
    "sr-source-fingerprint": string;
    "sr-source-lines": string;
    "sr-source-section": "all";
    "sr-source-section-title": "Entire note";
}

function scalar(value: unknown): string {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return "";
}

function reference(value: unknown): string {
    return scalar(Array.isArray(value) ? value[0] : value)
        .replace(/^\[\[|\]\]$/g, "")
        .split("|")[0]
        .trim();
}

export function planKnowledgeCompilerV2Migration(
    artifactPath: string,
    frontmatter: Record<string, unknown> | undefined,
    sourcePath: string,
    sourceText: string,
): KnowledgeCompilerV2Patch | null {
    if (!frontmatter || Number(frontmatter["sr-compiler-version"]) !== 1) return null;
    const concept = scalar(frontmatter["sr-concept"]).trim();
    if (!concept || !sourcePath || artifactPath === sourcePath) return null;
    const section = splitKnowledgeSource(sourceText)[0];
    if (!section) return null;
    const conceptId = knowledgeCompilerKey(sourcePath, concept);
    return {
        "sr-compiler-key": conceptId,
        "sr-compiler-version": 2,
        "sr-concept-id": conceptId,
        "sr-migrated-from": 1,
        "sr-source-fingerprint": knowledgeSourceFingerprint(section.text),
        "sr-source-lines": `${section.startLine}-${section.endLine}`,
        "sr-source-section": "all",
        "sr-source-section-title": "Entire note",
    };
}

function yamlScalar(value: string | number): string {
    return typeof value === "number" ? String(value) : JSON.stringify(value);
}

/** Applies only deterministic scalar root properties and leaves the card body byte-for-byte intact. */
export function applyKnowledgeCompilerV2Patch(
    contents: string,
    patch: KnowledgeCompilerV2Patch,
): string {
    const lineBreak = contents.includes("\r\n") ? "\r\n" : "\n";
    const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const properties = (
        Object.entries(patch) as Array<[keyof KnowledgeCompilerV2Patch, string | number]>
    ).sort(([left], [right]) => left.localeCompare(right));
    if (!match) {
        const block = properties
            .map(([key, value]) => `${key}: ${yamlScalar(value)}`)
            .join(lineBreak);
        return `---${lineBreak}${block}${lineBreak}---${lineBreak}${contents}`;
    }

    let frontmatter = match[1];
    for (const [key, value] of properties) {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`^${escaped}:[^\\r\\n]*(?:\\r?\\n|$)`, "m");
        const next = `${key}: ${yamlScalar(value)}${lineBreak}`;
        frontmatter = pattern.test(frontmatter)
            ? frontmatter.replace(pattern, next)
            : `${frontmatter.replace(/\s+$/, "")}${lineBreak}${next}`;
    }
    const originalBlock = match[0];
    const nextBlock = `---${lineBreak}${frontmatter.replace(/\s+$/, "")}${lineBreak}---${lineBreak}`;
    return `${nextBlock}${contents.slice(originalBlock.length)}`;
}

/** Migrates file-native compiler artifacts without a hidden database or destructive overwrite. */
export async function migrateKnowledgeCompilerV1Artifacts(
    app: App,
    writer: AtomicVaultWriter,
): Promise<KnowledgeCompilerMigrationReport> {
    const report: KnowledgeCompilerMigrationReport = {
        migrated: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
    };
    for (const artifact of app.vault.getMarkdownFiles()) {
        const frontmatter = app.metadataCache.getFileCache(artifact)?.frontmatter as
            Record<string, unknown> | undefined;
        if (Number(frontmatter?.["sr-compiler-version"]) !== 1) continue;
        const sourceReference = reference(frontmatter?.["sr-source"]);
        const source = sourceReference
            ? (app.metadataCache.getFirstLinkpathDest(sourceReference, artifact.path) ??
              app.vault.getFileByPath(sourceReference))
            : null;
        if (!(source instanceof TFile)) {
            report.skipped++;
            continue;
        }
        try {
            const [sourceText, artifactText] = await Promise.all([
                app.vault.cachedRead(source),
                app.vault.read(artifact),
            ]);
            const patch = planKnowledgeCompilerV2Migration(
                artifact.path,
                frontmatter,
                source.path,
                sourceText,
            );
            if (!patch) {
                report.skipped++;
                continue;
            }
            await writer.writeText(
                artifact.path,
                applyKnowledgeCompilerV2Patch(artifactText, patch),
            );
            report.migrated++;
        } catch (error) {
            if (error instanceof VaultWriteConflictError) report.conflicts++;
            else {
                console.error(`MSRE: Unable to migrate compiler artifact ${artifact.path}`, error);
                report.failed++;
            }
        }
    }
    return report;
}
