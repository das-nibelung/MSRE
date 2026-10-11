import { NativeCardType } from "src/data/native-card-store";

export interface QuickAddSeed {
    front: string;
    back: string;
    type: NativeCardType;
    sourceLabel?: string;
}

function cleanInline(value: string): string {
    return value
        .trim()
        .replace(/^[-*+]\s+/, "")
        .replace(/^\d+[.)]\s+/, "")
        .replace(/^#{1,6}\s+/, "")
        .trim();
}

function splitPair(value: string): [string, string] | null {
    const line = cleanInline(value);
    const match = line.match(/^(.+?)(?:\s+::\s+|\s+[—–]\s+|\s+->\s+|\t+)(.+)$/);
    if (match) return [match[1].trim(), match[2].trim()];

    const colon = line.match(/^([^:]{2,80}):\s+(.+)$/);
    return colon ? [colon[1].trim(), colon[2].trim()] : null;
}

function tableSeeds(lines: string[]): QuickAddSeed[] {
    const rows = lines
        .filter((line) => line.includes("|"))
        .map((line) =>
            line
                .replace(/^\s*\||\|\s*$/g, "")
                .split("|")
                .map(cleanInline),
        )
        .filter((cells) => cells.length >= 2 && cells.some(Boolean));
    if (rows.length < 2) return [];
    const content = rows.filter(
        (cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, ""))),
    );
    const start =
        content.length > 1 && /question|front|term|вопрос|термин/i.test(content[0][0]) ? 1 : 0;
    return content
        .slice(start)
        .flatMap((cells) =>
            cells[0] && cells[1]
                ? [{ front: cells[0], back: cells.slice(1).join(" · "), type: "basic" as const }]
                : [],
        );
}

function headingSeeds(text: string): QuickAddSeed[] {
    const matches = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
    if (matches.length === 0) return [];
    return matches.flatMap((match, index) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = matches[index + 1]?.index ?? text.length;
        const body = text.slice(start, end).trim();
        return body ? [{ front: cleanInline(match[1]), back: body, type: "basic" as const }] : [];
    });
}

export function extractBatchClozeSeeds(text: string): QuickAddSeed[] {
    const answers: string[] = [];
    const plain = text
        .replace(/<(strong|mark)>(.*?)<\/\1>/gis, (_match, _tag: string, answer: string) => {
            const clean = answer.replace(/<[^>]+>/g, "").trim();
            answers.push(clean);
            return clean;
        })
        .replace(/==(.+?)==/gs, (_match, answer: string) => {
            answers.push(answer.trim());
            return answer;
        })
        .replace(/\*\*(.+?)\*\*/gs, (_match, answer: string) => {
            answers.push(answer.trim());
            return answer;
        })
        .replace(/\{\{c\d*::(.*?)(?:::[^}]*)?}}/gs, (_match, answer: string) => {
            answers.push(answer.trim());
            return answer;
        })
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim();
    return [...new Set(answers.filter(Boolean))].map((answer) => ({
        front: plain,
        back: answer,
        type: "cloze",
        sourceLabel: "cloze",
    }));
}

export function deriveQuickAddSeeds(markdown: string): QuickAddSeed[] {
    const text = markdown.trim();
    if (!text) return [];

    const clozes = extractBatchClozeSeeds(text);
    if (clozes.length > 0) return clozes;

    const lines = text.split(/\r?\n/);
    const table = tableSeeds(lines);
    if (table.length > 0) return table;

    const headings = headingSeeds(text);
    if (headings.length > 0) return headings;

    const pairs = lines.flatMap((line) => {
        const pair = splitPair(line);
        return pair ? [{ front: pair[0], back: pair[1], type: "basic" as const }] : [];
    });
    if (pairs.length > 0 && pairs.length >= lines.filter((line) => line.trim()).length / 2) {
        return pairs;
    }

    const paragraphs = text
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
    if (paragraphs.length >= 2) {
        return [
            {
                front: cleanInline(paragraphs[0]),
                back: paragraphs.slice(1).join("\n\n"),
                type: "basic",
            },
        ];
    }
    const firstBreak = text.indexOf("\n");
    return [
        {
            front: cleanInline(firstBreak >= 0 ? text.slice(0, firstBreak) : text),
            back: firstBreak >= 0 ? text.slice(firstBreak + 1).trim() : "",
            type: "basic",
        },
    ];
}
