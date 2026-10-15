import {
    applyKnowledgeCompilerV2Patch,
    planKnowledgeCompilerV2Migration,
} from "src/intelligence/knowledge-compiler-migration";
import {
    knowledgeCompilerKey,
    knowledgeSourceFingerprint,
} from "src/intelligence/knowledge-provenance";

describe("knowledge compiler V1 migration", () => {
    const sourcePath = "Knowledge/Heart.md";
    const sourceText = "# Heart\n\nThe SA node starts the heartbeat.";

    test("creates deterministic V2 provenance without changing the card body", () => {
        const patch = planKnowledgeCompilerV2Migration(
            "Cards/Pacemaker.md",
            {
                "sr-compiler-version": 1,
                "sr-concept": "Pacemaker",
                "sr-source": `[[${sourcePath}]]`,
            },
            sourcePath,
            sourceText,
        );
        expect(patch).toEqual({
            "sr-compiler-key": knowledgeCompilerKey(sourcePath, "Pacemaker"),
            "sr-compiler-version": 2,
            "sr-concept-id": knowledgeCompilerKey(sourcePath, "Pacemaker"),
            "sr-migrated-from": 1,
            "sr-source-fingerprint": knowledgeSourceFingerprint(sourceText),
            "sr-source-lines": "1-3",
            "sr-source-section": "all",
            "sr-source-section-title": "Entire note",
        });
        if (!patch) throw new Error("migration patch missing");
        const original = "---\ntags: [compiled]\nsr-compiler-version: 1\n---\nQuestion::Answer\n";
        const migrated = applyKnowledgeCompilerV2Patch(original, patch);

        expect(migrated).toContain("tags: [compiled]");
        expect(migrated).toContain("sr-compiler-version: 2");
        expect(migrated).toContain('sr-source-section: "all"');
        expect(migrated.slice(migrated.indexOf("Question::Answer"))).toBe("Question::Answer\n");
        expect(applyKnowledgeCompilerV2Patch(migrated, patch)).toBe(migrated);
    });

    test("does not migrate unrelated, current, or invalid artifacts", () => {
        expect(
            planKnowledgeCompilerV2Migration(
                "Cards/a.md",
                { "sr-compiler-version": 2, "sr-concept": "A" },
                sourcePath,
                sourceText,
            ),
        ).toBeNull();
        expect(
            planKnowledgeCompilerV2Migration(
                "Cards/a.md",
                { "sr-compiler-version": 1 },
                sourcePath,
                sourceText,
            ),
        ).toBeNull();
    });

    test("adds frontmatter to a legacy body and preserves CRLF files", () => {
        const patch = planKnowledgeCompilerV2Migration(
            "Cards/a.md",
            { "sr-compiler-version": 1, "sr-concept": "A" },
            sourcePath,
            sourceText,
        );
        if (!patch) throw new Error("migration patch missing");
        const migrated = applyKnowledgeCompilerV2Patch("Question\r\nAnswer\r\n", patch);

        expect(migrated).toContain("---\r\n");
        expect(migrated.endsWith("Question\r\nAnswer\r\n")).toBe(true);
    });
});
