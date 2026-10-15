import { analyzeCardQuality } from "src/data/card-quality";
import { ReviewLogEntry } from "src/data/collection/collection-types";
import { NativeCardType } from "src/data/native-card-store";
import { CardBrowserRecord, compactCardText } from "src/ui/card-browser/card-browser-model";
import { KnowledgeRelationEdge } from "src/ui/obsidian-integrations/knowledge-dependencies";

export type IntelligenceFindingKind =
    "duplicate" | "contradiction" | "gap" | "atomicity" | "split" | "error";

export type IntelligenceFindingSeverity = "high" | "medium" | "low";

export interface IntelligenceDraft {
    front: string;
    back: string;
    type: NativeCardType;
    sourceLabel: string;
}

export interface IntelligenceFinding {
    id: string;
    kind: IntelligenceFindingKind;
    severity: IntelligenceFindingSeverity;
    title: string;
    summary: string;
    confidence: number;
    cardIds: string[];
    noteIds: string[];
    sourcePaths: string[];
    evidence: string[];
    drafts: IntelligenceDraft[];
}

export interface CollectionIntelligenceInput {
    records: CardBrowserRecord[];
    reviewLog: ReviewLogEntry[];
    duplicateGroups: string[][];
    relatedByNoteId: Record<string, Array<{ id: string; score: number }>>;
    relations: KnowledgeRelationEdge[];
}

export interface CollectionIntelligenceReport {
    generatedAt: number;
    cards: number;
    findings: IntelligenceFinding[];
    counts: Record<IntelligenceFindingKind, number>;
}

const ALL_KINDS: IntelligenceFindingKind[] = [
    "duplicate",
    "contradiction",
    "gap",
    "atomicity",
    "split",
    "error",
];

function normalize(value: string): string {
    return compactCardText(value)
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function words(value: string): Set<string> {
    return new Set(
        normalize(value)
            .split(" ")
            .filter((word) => word.length > 2),
    );
}

function similarity(left: string, right: string): number {
    const a = words(left);
    const b = words(right);
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    for (const word of a) if (b.has(word)) overlap++;
    return overlap / Math.max(a.size, b.size);
}

function stableId(kind: IntelligenceFindingKind, values: string[]): string {
    const source = `${kind}:${[...values].sort().join(":")}`;
    let hash = 2_166_136_261;
    for (const character of source) {
        hash ^= character.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16_777_619);
    }
    return `${kind}-${(hash >>> 0).toString(36)}`;
}

function unique(values: Array<string | null | undefined>): string[] {
    return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function recordPaths(records: CardBrowserRecord[]): string[] {
    return unique(records.map((record) => record.notePath));
}

function noteIds(records: CardBrowserRecord[]): string[] {
    return unique(records.map((record) => record.noteId));
}

function severity(confidence: number, highAt = 0.86): IntelligenceFindingSeverity {
    return confidence >= highAt ? "high" : confidence >= 0.68 ? "medium" : "low";
}

function issueLabel(code: string): string {
    return code.replaceAll("-", " ");
}

function splitAnswer(record: CardBrowserRecord): IntelligenceDraft[] {
    const answer = record.back.trim();
    const lines = answer
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:[-*+] |\d+[.)] )/, "").trim())
        .filter(Boolean);
    const parts =
        lines.length >= 2
            ? lines
            : answer
                  .split(/(?:;|\.(?=\s+[\p{Lu}А-ЯЁ]))/u)
                  .map((part) => part.trim())
                  .filter((part) => part.length >= 8);
    if (parts.length < 2 || parts.length > 12) return [];
    const root = compactCardText(record.front).replace(/[?？]\s*$/, "");
    return parts.map((part, index) => ({
        front: `${root} — part ${index + 1}?`,
        back: part,
        type: "basic",
        sourceLabel: `Split from ${record.notePath || "card"}`,
    }));
}

function contradictionPairs(
    records: CardBrowserRecord[],
    relatedByNoteId: CollectionIntelligenceInput["relatedByNoteId"],
): Array<{ left: CardBrowserRecord; right: CardBrowserRecord; confidence: number }> {
    const byNote = new Map<string, CardBrowserRecord[]>();
    for (const record of records) {
        if (!record.noteId) continue;
        byNote.set(record.noteId, [...(byNote.get(record.noteId) ?? []), record]);
    }
    const seen = new Set<string>();
    const pairs: Array<{ left: CardBrowserRecord; right: CardBrowserRecord; confidence: number }> =
        [];
    for (const [noteId, related] of Object.entries(relatedByNoteId)) {
        for (const match of related.filter((item) => item.score >= 0.46)) {
            const pairKey = [noteId, match.id].sort().join(":");
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            for (const left of byNote.get(noteId) ?? []) {
                for (const right of byNote.get(match.id) ?? []) {
                    const questionScore = similarity(left.front, right.front);
                    const answerScore = similarity(left.back, right.back);
                    const leftAnswer = normalize(left.back);
                    const rightAnswer = normalize(right.back);
                    const negation = /\b(?:not|never|no|without|не|нет|никогда|нельзя|без)\b/u;
                    const polarityMismatch =
                        negation.test(leftAnswer) !== negation.test(rightAnswer);
                    const numericLeft = leftAnswer.match(/\b\d+(?:[.,]\d+)?\b/g)?.join("|") ?? "";
                    const numericRight = rightAnswer.match(/\b\d+(?:[.,]\d+)?\b/g)?.join("|") ?? "";
                    const numericMismatch = Boolean(
                        numericLeft && numericRight && numericLeft !== numericRight,
                    );
                    if (
                        questionScore >= 0.72 &&
                        (polarityMismatch || numericMismatch || answerScore < 0.18)
                    ) {
                        pairs.push({
                            left,
                            right,
                            confidence: Math.min(
                                0.98,
                                0.55 + questionScore * 0.35 + (polarityMismatch ? 0.08 : 0),
                            ),
                        });
                    }
                }
            }
        }
    }
    return pairs.slice(0, 80);
}

export function analyzeCollectionIntelligence(
    input: CollectionIntelligenceInput,
): CollectionIntelligenceReport {
    const findings: IntelligenceFinding[] = [];
    const active = input.records.filter((record) => record.lifecycleState === "active");
    const byNote = new Map<string, CardBrowserRecord[]>();
    for (const record of active) {
        if (record.noteId)
            byNote.set(record.noteId, [...(byNote.get(record.noteId) ?? []), record]);
    }

    for (const group of input.duplicateGroups) {
        const grouped = group.flatMap((id) => byNote.get(id) ?? []);
        if (grouped.length < 2) continue;
        const confidence = Math.min(0.98, 0.8 + grouped.length * 0.025);
        findings.push({
            id: stableId("duplicate", group),
            kind: "duplicate",
            severity: severity(confidence),
            title: `${grouped.length} cards may test the same knowledge`,
            summary:
                "Local embeddings found a near-duplicate cluster. Compare wording before merging.",
            confidence,
            cardIds: grouped.map((record) => record.id),
            noteIds: noteIds(grouped),
            sourcePaths: recordPaths(grouped),
            evidence: grouped.slice(0, 4).map((record) => compactCardText(record.front)),
            drafts: [],
        });
    }

    for (const pair of contradictionPairs(active, input.relatedByNoteId)) {
        findings.push({
            id: stableId("contradiction", [pair.left.id, pair.right.id]),
            kind: "contradiction",
            severity: severity(pair.confidence, 0.82),
            title: "Similar questions have incompatible answers",
            summary:
                "The detector found matching prompts with different polarity, numbers, or facts.",
            confidence: pair.confidence,
            cardIds: [pair.left.id, pair.right.id],
            noteIds: noteIds([pair.left, pair.right]),
            sourcePaths: recordPaths([pair.left, pair.right]),
            evidence: [
                `${compactCardText(pair.left.front)} → ${compactCardText(pair.left.back)}`,
                `${compactCardText(pair.right.front)} → ${compactCardText(pair.right.back)}`,
            ],
            drafts: [],
        });
    }

    for (const record of active) {
        const report = analyzeCardQuality({
            kind: record.cardType === "cloze" ? "cloze-selection" : "basic",
            question: record.front,
            answer: record.back,
            requireAnswer: true,
        });
        const meaningful = report.issues.filter((issue) => issue.code !== "possible-duplicate");
        if (meaningful.length) {
            const confidence = Math.min(0.97, 0.62 + meaningful.length * 0.09);
            findings.push({
                id: stableId("atomicity", [record.id]),
                kind: "atomicity",
                severity: report.blocking ? "high" : severity(confidence, 0.88),
                title: report.blocking
                    ? "Card cannot be graded reliably"
                    : "Card can be more atomic",
                summary: meaningful.map((issue) => issueLabel(issue.code)).join(" · "),
                confidence,
                cardIds: [record.id],
                noteIds: noteIds([record]),
                sourcePaths: recordPaths([record]),
                evidence: [compactCardText(record.front), compactCardText(record.back)].filter(
                    Boolean,
                ),
                drafts: [],
            });
        }
        const drafts = splitAnswer(record);
        if (drafts.length) {
            const confidence = Math.min(0.96, 0.72 + drafts.length * 0.025);
            findings.push({
                id: stableId("split", [record.id]),
                kind: "split",
                severity: severity(confidence, 0.9),
                title: `Split this card into ${drafts.length} atomic prompts`,
                summary:
                    "The answer contains independent facts that are easier to recall separately.",
                confidence,
                cardIds: [record.id],
                noteIds: noteIds([record]),
                sourcePaths: recordPaths([record]),
                evidence: drafts.slice(0, 4).map((draft) => draft.back),
                drafts,
            });
        }
    }

    const incomingPrerequisites = new Set(
        input.relations.filter((edge) => edge.type === "prerequisite").map((edge) => edge.toPath),
    );
    for (const record of active) {
        const weak = (record.lapses ?? 0) >= 3 || (record.retention ?? 1) < 0.72;
        if (!weak || !record.notePath || incomingPrerequisites.has(record.notePath)) continue;
        const related = record.noteId ? (input.relatedByNoteId[record.noteId] ?? []) : [];
        const confidence = Math.min(
            0.92,
            0.62 + Math.min(0.2, (record.lapses ?? 0) * 0.03) + (related.length ? 0.06 : 0),
        );
        findings.push({
            id: stableId("gap", [record.id]),
            kind: "gap",
            severity: severity(confidence, 0.84),
            title: "A prerequisite may be missing",
            summary:
                "This card is repeatedly difficult but has no declared prerequisite in the knowledge graph.",
            confidence,
            cardIds: [record.id],
            noteIds: noteIds([record]),
            sourcePaths: [record.notePath],
            evidence: [
                `${record.lapses ?? 0} lapses`,
                record.retention == null
                    ? "Retention unavailable"
                    : `${Math.round(record.retention * 100)}% predicted retention`,
            ],
            drafts: [],
        });
    }

    const reviewsByCard = new Map<string, ReviewLogEntry[]>();
    for (const entry of input.reviewLog.filter(
        (item) => !item.deletedAt && item.mode === "review",
    )) {
        reviewsByCard.set(entry.cardId, [...(reviewsByCard.get(entry.cardId) ?? []), entry]);
    }
    for (const record of active) {
        const history = [
            ...(record.history ?? []),
            ...(record.collectionCardId ? (reviewsByCard.get(record.collectionCardId) ?? []) : []),
        ];
        const recent = history.sort((a, b) => b.reviewedAt - a.reviewedAt).slice(0, 12);
        if (recent.length < 3) continue;
        const again = recent.filter((entry) => entry.rating === 1).length;
        const ratio = again / recent.length;
        if (again < 2 || ratio < 0.34) continue;
        const confidence = Math.min(0.98, 0.64 + ratio * 0.34);
        const drafts = splitAnswer(record);
        findings.push({
            id: stableId("error", [record.id]),
            kind: "error",
            severity: severity(confidence, 0.82),
            title: "Repeated errors need a targeted card",
            summary: `${again} of the last ${recent.length} reviews were Again. Review wording or add a smaller prerequisite card.`,
            confidence,
            cardIds: [record.id],
            noteIds: noteIds([record]),
            sourcePaths: recordPaths([record]),
            evidence: [compactCardText(record.front), `${Math.round(ratio * 100)}% Again`],
            drafts,
        });
    }

    findings.sort(
        (left, right) =>
            ({ high: 0, medium: 1, low: 2 })[left.severity] -
                { high: 0, medium: 1, low: 2 }[right.severity] ||
            right.confidence - left.confidence,
    );
    const counts = Object.fromEntries(
        ALL_KINDS.map((kind) => [kind, findings.filter((item) => item.kind === kind).length]),
    ) as Record<IntelligenceFindingKind, number>;
    return { generatedAt: Date.now(), cards: active.length, findings, counts };
}
