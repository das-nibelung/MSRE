import fs from "node:fs";
import path from "node:path";

describe("iPhone layout contracts", () => {
    const source = (relativePath: string): string =>
        fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");

    it("keeps the native editor inside the viewport without horizontal workspace gestures", () => {
        const css = source("src/ui/native-creator/native-creator-view.css");
        expect(css).toMatch(/\.sr-native-creator-view\s*{[^}]*min-width:\s*0/s);
        expect(css).toMatch(/\.sr-native-creator-view\s*{[^}]*overflow-x:\s*clip/s);
        expect(css).toMatch(/\.sr-native-creator-page\s*{[^}]*max-width:\s*100%/s);
        expect(css).toMatch(/@media \(max-width:\s*600px\)/);
        expect(css).toMatch(/min-height:\s*44px/);
    });

    it("gives the settings content its own full-height momentum scroller", () => {
        const css = source(
            "src/ui/obsidian-ui-components/content-container/settings-page/settings-page.css",
        );
        expect(css).toMatch(/\.sr-settings-page-content\s*{[^}]*overflow-y:\s*auto\s*!important/s);
        expect(css).toMatch(/touch-action:\s*pan-y/);
        expect(css).toMatch(/-webkit-overflow-scrolling:\s*touch/);
        expect(css).toMatch(/max-height:\s*100dvh/);
    });

    it("stacks template controls instead of overflowing a narrow phone", () => {
        const css = source("src/ui/native-creator/native-creator-view.css");
        expect(css).toMatch(
            /@media \(max-width:\s*600px\)[\s\S]*\.sr-note-template-behavior,[\s\S]*grid-template-columns:\s*1fr/,
        );
        expect(css).toMatch(/\.sr-note-template-control select,[\s\S]*min-width:\s*0/);
    });
});
