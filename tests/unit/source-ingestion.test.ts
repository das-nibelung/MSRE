import { App, loadPdfJs, TFile } from "obsidian";

import { extractIntelligenceSource } from "src/intelligence/source-ingestion";

function file(path: string, size = 32): TFile {
    const value = new TFile();
    Object.assign(value, {
        path,
        name: path.split("/").pop() ?? path,
        basename: (path.split("/").pop() ?? path).replace(/\.[^.]+$/, ""),
        extension: path.split(".").pop() ?? "",
        stat: { size, ctime: 1, mtime: 1 },
    });
    return value;
}

function app(
    options: {
        files?: Record<string, TFile>;
        text?: Record<string, string>;
        binary?: ArrayBuffer;
    } = {},
): App {
    const files = options.files ?? {};
    const text = options.text ?? {};
    return {
        vault: {
            cachedRead: jest.fn((target: TFile) => Promise.resolve(text[target.path] ?? "")),
            read: jest.fn((target: TFile) => Promise.resolve(text[target.path] ?? "")),
            readBinary: jest.fn(() =>
                Promise.resolve(options.binary ?? new Uint8Array([1, 2, 3]).buffer),
            ),
            getFileByPath: jest.fn((path: string) => files[path] ?? null),
        },
    } as unknown as App;
}

describe("intelligence source ingestion", () => {
    afterEach(() => {
        jest.restoreAllMocks();
        delete (globalThis as typeof globalThis & { TextDetector?: unknown }).TextDetector;
        delete (globalThis as typeof globalThis & { createImageBitmap?: unknown })
            .createImageBitmap;
    });

    test("reads plain text locally and applies a safe length limit", async () => {
        const source = file("Notes/large.md");
        const result = await extractIntelligenceSource(
            app({ text: { [source.path]: "x".repeat(90_000) } }),
            source,
        );
        expect(result.kind).toBe("text");
        expect(result.text).toHaveLength(80_000);
        expect(result.attachments).toEqual([]);
    });

    test("flattens Canvas text, labels, and linked local notes", async () => {
        const source = file("Maps/Knowledge.canvas");
        const linked = file("Notes/Concept.md");
        const canvas = JSON.stringify({
            nodes: [
                { type: "text", text: "Canvas claim" },
                { type: "file", file: linked.path, label: "Core concept" },
            ],
        });
        const result = await extractIntelligenceSource(
            app({
                files: { [linked.path]: linked },
                text: { [source.path]: canvas, [linked.path]: "Linked explanation" },
            }),
            source,
        );
        expect(result.kind).toBe("canvas");
        expect(result.text).toContain("Canvas claim");
        expect(result.text).toContain("Core concept");
        expect(result.text).toContain("Linked explanation");
    });

    test("extracts text from every PDF page", async () => {
        const getPage = jest.fn((page: number) =>
            Promise.resolve({
                getTextContent: jest.fn(() =>
                    Promise.resolve({ items: [{ str: `Page ${page}` }, { str: "fact" }] }),
                ),
            }),
        );
        jest.mocked(loadPdfJs).mockResolvedValue({
            getDocument: () => ({ promise: Promise.resolve({ numPages: 2, getPage }) }),
        });
        const result = await extractIntelligenceSource(app(), file("Sources/manual.pdf"));
        expect(result.kind).toBe("pdf");
        expect(result.text).toBe("Page 1 fact\n\nPage 2 fact");
        expect(getPage).toHaveBeenCalledTimes(2);
    });

    test("keeps images local, uses OCR when available, and closes the bitmap", async () => {
        const close = jest.fn();
        Object.assign(globalThis, {
            createImageBitmap: jest.fn(() => Promise.resolve({ close })),
            TextDetector: class {
                detect(): Promise<Array<{ rawValue: string }>> {
                    return Promise.resolve([{ rawValue: "Detected term" }, { rawValue: "42" }]);
                }
            },
        });
        const result = await extractIntelligenceSource(app(), file("Media/diagram.png"));
        expect(result.kind).toBe("image");
        expect(result.text).toBe("Detected term\n42");
        expect(result.attachments[0]).toMatchObject({
            kind: "image",
            mimeType: "image/png",
            vaultPath: "Media/diagram.png",
        });
        expect(result.attachments[0].dataUrl).toMatch(/^data:image\/png;base64,/);
        expect(result.warnings).toEqual([]);
        expect(close).toHaveBeenCalled();
    });

    test("degrades safely when optional image OCR fails", async () => {
        const close = jest.fn();
        Object.assign(globalThis, {
            createImageBitmap: jest.fn(() => Promise.resolve({ close })),
            TextDetector: class {
                detect(): Promise<never> {
                    return Promise.reject(new Error("ocr-unavailable"));
                }
            },
        });
        const result = await extractIntelligenceSource(app(), file("Media/photo.jpg"));
        expect(result.attachments).toHaveLength(1);
        expect(result.warnings[0]).toContain("Local OCR is unavailable");
        expect(close).toHaveBeenCalled();
    });

    test("reports optional-AI and size constraints for media", async () => {
        const audio = await extractIntelligenceSource(app(), file("Media/lecture.mp3"));
        expect(audio.kind).toBe("audio");
        expect(audio.attachments[0].kind).toBe("audio");
        expect(audio.warnings[0]).toContain("requires a connected AI provider");

        const oversized = await extractIntelligenceSource(
            app(),
            file("Media/scan.jpg", 13 * 1024 * 1024),
        );
        expect(oversized.attachments).toEqual([]);
        expect(oversized.warnings.join(" ")).toContain("12 MB");

        const oversizedAudio = await extractIntelligenceSource(
            app(),
            file("Media/lecture.flac", 13 * 1024 * 1024),
        );
        expect(oversizedAudio.attachments).toEqual([]);
        expect(oversizedAudio.warnings[0]).toContain("12 MB");
    });
});
