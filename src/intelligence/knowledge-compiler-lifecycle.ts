import { knowledgeCompilerKey } from "src/intelligence/knowledge-provenance";

export type CompilerDiffKind = "create" | "update" | "rename" | "unchanged" | "orphan";
export type CompilerOrphanAction = "archive" | "manual" | "delete" | "ignore";

export interface CompilerProposalSnapshot {
    sourceIndex: number;
    concept: string;
    front: string;
    back: string;
    type: string;
    sourceQuote: string;
    deckPath: string;
}

export interface CompilerArtifactSnapshot {
    path: string;
    key: string;
    conceptId: string;
    concept: string;
    front: string;
    back: string;
    type: string;
    sourceQuote: string;
    deckPath: string;
    sectionId: string;
    managed: boolean;
}

export interface CompilerFieldChange {
    field: "concept" | "question" | "answer" | "type" | "deck" | "source";
    before: string;
    after: string;
}

export interface CompilerDiffItem {
    id: string;
    kind: CompilerDiffKind;
    proposalIndex: number | null;
    artifactPath: string | null;
    artifactKey: string | null;
    changes: CompilerFieldChange[];
    similarity: number;
    orphanAction?: CompilerOrphanAction;
}

export interface CompilerDiffPlan {
    items: CompilerDiffItem[];
    counts: Record<CompilerDiffKind, number>;
}

function normalized(value: string): string {
    return value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/<!--[^>]*-->/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenSimilarity(left: string, right: string): number {
    const a = new Set(normalized(left).split(" ").filter(Boolean));
    const b = new Set(normalized(right).split(" ").filter(Boolean));
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const token of a) if (b.has(token)) overlap++;
    return overlap / (a.size + b.size - overlap);
}

/**
 * Conservative rename score. An exact source quote is treated as identity; otherwise both the
 * question and answer must remain recognisably similar before an old artifact may be reused.
 */
export function compilerRenameSimilarity(
    proposal: CompilerProposalSnapshot,
    artifact: CompilerArtifactSnapshot,
): number {
    const quoteA = normalized(proposal.sourceQuote);
    const quoteB = normalized(artifact.sourceQuote);
    if (quoteA.length >= 8 && quoteA === quoteB) return 1;
    const front = tokenSimilarity(proposal.front, artifact.front);
    const back = tokenSimilarity(proposal.back, artifact.back);
    const quote = tokenSimilarity(proposal.sourceQuote, artifact.sourceQuote);
    return front * 0.42 + back * 0.38 + quote * 0.2;
}

function changesFor(
    proposal: CompilerProposalSnapshot,
    artifact: CompilerArtifactSnapshot,
): CompilerFieldChange[] {
    const candidates: Array<CompilerFieldChange> = [
        { field: "concept", before: artifact.concept, after: proposal.concept },
        { field: "question", before: artifact.front, after: proposal.front },
        { field: "answer", before: artifact.back, after: proposal.back },
        { field: "type", before: artifact.type, after: proposal.type },
        { field: "deck", before: artifact.deckPath, after: proposal.deckPath },
        { field: "source", before: artifact.sourceQuote, after: proposal.sourceQuote },
    ];
    return candidates.filter((change) => normalized(change.before) !== normalized(change.after));
}

function diffId(proposalIndex: number | null, artifactPath: string | null): string {
    return `${proposalIndex ?? "orphan"}:${artifactPath ?? "new"}`;
}

/** Builds a deterministic, side-effect-free compiler plan suitable for preview and tests. */
export function planKnowledgeCompilerDiff(
    sourcePath: string,
    proposals: CompilerProposalSnapshot[],
    artifacts: CompilerArtifactSnapshot[],
): CompilerDiffPlan {
    const managed = artifacts.filter((artifact) => artifact.managed);
    const manual = artifacts.filter((artifact) => !artifact.managed);
    const available = new Map(managed.map((artifact) => [artifact.path, artifact]));
    const items: CompilerDiffItem[] = [];
    const unmatched: CompilerProposalSnapshot[] = [];

    for (const proposal of proposals) {
        const key = knowledgeCompilerKey(sourcePath, proposal.concept || proposal.front);
        const reserved = manual.find(
            (candidate) => candidate.key === key || candidate.conceptId === key,
        );
        if (reserved) {
            items.push({
                id: diffId(proposal.sourceIndex, reserved.path),
                kind: "unchanged",
                proposalIndex: proposal.sourceIndex,
                artifactPath: reserved.path,
                artifactKey: reserved.key,
                changes: [],
                similarity: 1,
            });
            continue;
        }
        const artifact = [...available.values()].find(
            (candidate) => candidate.key === key || candidate.conceptId === key,
        );
        if (!artifact) {
            unmatched.push(proposal);
            continue;
        }
        available.delete(artifact.path);
        const changes = changesFor(proposal, artifact);
        items.push({
            id: diffId(proposal.sourceIndex, artifact.path),
            kind: changes.length ? "update" : "unchanged",
            proposalIndex: proposal.sourceIndex,
            artifactPath: artifact.path,
            artifactKey: artifact.key,
            changes,
            similarity: 1,
        });
    }

    // Only accept mutual best matches. This prevents two similar proposals from claiming one old
    // artifact and keeps ambiguous cases visible as create + orphan instead of silently guessing.
    const scores = unmatched.flatMap((proposal) =>
        [...available.values()].map((artifact) => ({
            proposal,
            artifact,
            score: compilerRenameSimilarity(proposal, artifact),
        })),
    );
    for (const proposal of unmatched) {
        const ranked = scores
            .filter(
                (candidate) =>
                    candidate.proposal === proposal && available.has(candidate.artifact.path),
            )
            .sort((left, right) => right.score - left.score);
        const best = ranked[0];
        if (best && best.score >= 0.72) {
            const artifactBest = scores
                .filter(
                    (candidate) =>
                        candidate.artifact.path === best.artifact.path &&
                        unmatched.includes(candidate.proposal),
                )
                .sort((left, right) => right.score - left.score)[0];
            const ambiguous = ranked[1] && best.score - ranked[1].score < 0.08;
            if (artifactBest?.proposal === proposal && !ambiguous) {
                available.delete(best.artifact.path);
                items.push({
                    id: diffId(proposal.sourceIndex, best.artifact.path),
                    kind: "rename",
                    proposalIndex: proposal.sourceIndex,
                    artifactPath: best.artifact.path,
                    artifactKey: best.artifact.key,
                    changes: changesFor(proposal, best.artifact),
                    similarity: best.score,
                });
                continue;
            }
        }
        items.push({
            id: diffId(proposal.sourceIndex, null),
            kind: "create",
            proposalIndex: proposal.sourceIndex,
            artifactPath: null,
            artifactKey: null,
            changes: [],
            similarity: 0,
        });
    }

    for (const artifact of available.values()) {
        items.push({
            id: diffId(null, artifact.path),
            kind: "orphan",
            proposalIndex: null,
            artifactPath: artifact.path,
            artifactKey: artifact.key,
            changes: [],
            similarity: 0,
            orphanAction: "archive",
        });
    }

    items.sort((left, right) => {
        if (left.proposalIndex === null) return 1;
        if (right.proposalIndex === null) return -1;
        return left.proposalIndex - right.proposalIndex;
    });
    const counts: Record<CompilerDiffKind, number> = {
        create: 0,
        update: 0,
        rename: 0,
        unchanged: 0,
        orphan: 0,
    };
    for (const item of items) counts[item.kind]++;
    return { items, counts };
}
