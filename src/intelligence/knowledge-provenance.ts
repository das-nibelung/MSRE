export interface KnowledgeSourceSection {
    id: string;
    title: string;
    level: number;
    text: string;
    startLine: number;
    endLine: number;
}

function stableHash(value: string): string {
    let hash = 2_166_136_261;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return (hash >>> 0).toString(36);
}

export function normalizeKnowledgeSource(value: string): string {
    return value
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim();
}

export function knowledgeSourceFingerprint(value: string): string {
    return `ks2-${stableHash(normalizeKnowledgeSource(value))}`;
}

export function knowledgeCompilerKey(sourcePath: string, concept: string): string {
    const normalizedConcept = concept
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    return `kc2-${stableHash(`${sourcePath}\u0000${normalizedConcept}`)}`;
}

/** Splits a note into independently compilable heading sections without changing its Markdown. */
export function splitKnowledgeSource(value: string): KnowledgeSourceSection[] {
    const normalized = normalizeKnowledgeSource(value);
    const lines = normalized.split("\n");
    const headings: Array<{ line: number; level: number; title: string }> = [];
    let fence = "";
    lines.forEach((line, index) => {
        const fenceMatch = line.match(/^\s*(```+|~~~+)/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!fence) fence = marker;
            else if (fence === marker) fence = "";
            return;
        }
        if (fence) return;
        const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
        if (match) headings.push({ line: index, level: match[1].length, title: match[2].trim() });
    });
    const whole: KnowledgeSourceSection = {
        id: "all",
        title: "Entire note",
        level: 0,
        text: normalized,
        startLine: 1,
        endLine: lines.length,
    };
    if (!headings.length) return [whole];
    const sections = headings.map((heading, index): KnowledgeSourceSection => {
        const next = headings
            .slice(index + 1)
            .find((candidate) => candidate.level <= heading.level);
        const end = next?.line ?? lines.length;
        return {
            id: `section-${stableHash(`${heading.line}:${heading.title}`)}`,
            title: `${"·".repeat(Math.max(0, heading.level - 1))}${heading.title}`,
            level: heading.level,
            text: lines.slice(heading.line, end).join("\n").trim(),
            startLine: heading.line + 1,
            endLine: end,
        };
    });
    return [whole, ...sections.filter((section) => section.text.length > 0)];
}
