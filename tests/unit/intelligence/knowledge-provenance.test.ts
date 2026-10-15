import {
    knowledgeCompilerKey,
    knowledgeSourceFingerprint,
    splitKnowledgeSource,
} from "src/intelligence/knowledge-provenance";

describe("knowledge compiler provenance", () => {
    test("keeps fingerprints stable across frontmatter and trailing whitespace", () => {
        const first = "---\ntags: [source]\n---\n# Heart\nSA node   \n";
        const second = "# Heart\nSA node\n";

        expect(knowledgeSourceFingerprint(first)).toBe(knowledgeSourceFingerprint(second));
        expect(knowledgeCompilerKey("Medicine/Heart.md", "SA NODE")).toBe(
            knowledgeCompilerKey("Medicine/Heart.md", "sa node"),
        );
    });

    test("splits heading branches and ignores headings inside code fences", () => {
        const sections = splitKnowledgeSource(
            "# Heart\nIntro\n## Rhythm\nSA node\n```md\n# Not a section\n```\n# Lung\nGas exchange",
        );

        expect(sections.map((section) => section.title)).toEqual([
            "Entire note",
            "Heart",
            "·Rhythm",
            "Lung",
        ]);
        expect(sections[1].text).toContain("SA node");
        expect(sections[1].text).not.toContain("Gas exchange");
    });

    test("reports exact editor lines when frontmatter and comments precede a section", () => {
        const sections = splitKnowledgeSource(
            "---\ntags: [medicine]\nstatus: active\n---\n<!-- private\ncomment -->\n# Heart\nSA node\n## Rhythm\nAV node",
        );

        expect(sections[0]).toMatchObject({ startLine: 1, endLine: 10 });
        expect(sections[1]).toMatchObject({ title: "Heart", startLine: 7, endLine: 10 });
        expect(sections[2]).toMatchObject({ title: "·Rhythm", startLine: 9, endLine: 10 });
    });
});
