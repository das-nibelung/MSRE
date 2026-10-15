import { App, loadPdfJs, TFile } from "obsidian";

import { AiAttachment } from "src/intelligence/ai-types";

export interface IntelligenceSource {
    path: string;
    kind: "text" | "canvas" | "pdf" | "image" | "audio";
    text: string;
    attachments: AiAttachment[];
    warnings: string[];
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "webm"]);
const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_LENGTH = 80_000;

function mimeType(file: TFile): string {
    const extension = file.extension.toLocaleLowerCase();
    const types: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        bmp: "image/bmp",
        avif: "image/avif",
        mp3: "audio/mpeg",
        wav: "audio/wav",
        m4a: "audio/mp4",
        ogg: "audio/ogg",
        oga: "audio/ogg",
        flac: "audio/flac",
        aac: "audio/aac",
        webm: "audio/webm",
    };
    return types[extension] ?? "application/octet-stream";
}

async function dataUrl(data: ArrayBuffer, type: string): Promise<string> {
    return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
            typeof reader.result === "string"
                ? resolve(reader.result)
                : reject(new Error("attachment-read-failed"));
        reader.onerror = () => reject(reader.error ?? new Error("attachment-read-failed"));
        reader.readAsDataURL(new Blob([data], { type }));
    });
}

async function mediaAttachment(app: App, file: TFile): Promise<AiAttachment | null> {
    if (file.stat.size > MAX_ATTACHMENT_BYTES) return null;
    const type = mimeType(file);
    return {
        name: file.name,
        mimeType: type,
        kind: IMAGE_EXTENSIONS.has(file.extension.toLocaleLowerCase()) ? "image" : "audio",
        vaultPath: file.path,
        dataUrl: await dataUrl(await app.vault.readBinary(file), type),
    };
}

async function detectImageText(app: App, file: TFile): Promise<string> {
    const Detector = (
        globalThis as typeof globalThis & {
            TextDetector?: new () => {
                detect(image: ImageBitmap): Promise<Array<{ rawValue?: string }>>;
            };
        }
    ).TextDetector;
    if (!Detector || !globalThis.createImageBitmap) return "";
    const bitmap = await createImageBitmap(
        new Blob([await app.vault.readBinary(file)], { type: mimeType(file) }),
    );
    try {
        return (await new Detector().detect(bitmap))
            .map((item) => item.rawValue?.trim() ?? "")
            .filter(Boolean)
            .join("\n");
    } finally {
        bitmap.close();
    }
}

async function pdfText(app: App, file: TFile): Promise<string> {
    const pdfJs = (await loadPdfJs()) as {
        getDocument(input: { data: Uint8Array }): {
            promise: Promise<{
                numPages: number;
                getPage(index: number): Promise<{
                    getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
                }>;
            }>;
        };
    };
    const pdfDocument = await pdfJs.getDocument({
        data: new Uint8Array(await app.vault.readBinary(file)),
    }).promise;
    const pages: string[] = [];
    for (
        let page = 1;
        page <= pdfDocument.numPages && pages.join("\n").length < MAX_TEXT_LENGTH;
        page++
    ) {
        const content = await (await pdfDocument.getPage(page)).getTextContent();
        pages.push(content.items.map((item) => item.str ?? "").join(" "));
    }
    return pages.join("\n\n").slice(0, MAX_TEXT_LENGTH);
}

async function canvasText(app: App, file: TFile): Promise<string> {
    const raw = JSON.parse(await app.vault.read(file)) as {
        nodes?: Array<{ type?: string; text?: string; file?: string; label?: string }>;
    };
    const sections: string[] = [];
    for (const node of raw.nodes ?? []) {
        if (node.type === "text" && node.text?.trim()) sections.push(node.text.trim());
        if (node.label?.trim()) sections.push(node.label.trim());
        if (node.type === "file" && node.file) {
            const linked = app.vault.getFileByPath(node.file);
            if (linked instanceof TFile && ["md", "txt"].includes(linked.extension)) {
                sections.push(`Source: ${linked.path}\n${await app.vault.cachedRead(linked)}`);
            }
        }
        if (sections.join("\n").length >= MAX_TEXT_LENGTH) break;
    }
    return sections.join("\n\n").slice(0, MAX_TEXT_LENGTH);
}

export async function extractIntelligenceSource(
    app: App,
    file: TFile,
): Promise<IntelligenceSource> {
    const extension = file.extension.toLocaleLowerCase();
    if (extension === "canvas") {
        return {
            path: file.path,
            kind: "canvas",
            text: await canvasText(app, file),
            attachments: [],
            warnings: [],
        };
    }
    if (extension === "pdf") {
        return {
            path: file.path,
            kind: "pdf",
            text: await pdfText(app, file),
            attachments: [],
            warnings: [],
        };
    }
    if (IMAGE_EXTENSIONS.has(extension)) {
        const attachment = await mediaAttachment(app, file);
        let text = "";
        try {
            text = await detectImageText(app, file);
        } catch {
            // OCR is a progressive enhancement; the connected AI can still inspect the image.
        }
        return {
            path: file.path,
            kind: "image",
            text,
            attachments: attachment ? [attachment] : [],
            warnings: [
                ...(!text ? ["Local OCR is unavailable; connect AI to read the image."] : []),
                ...(!attachment ? ["The image is larger than the 12 MB AI limit."] : []),
            ],
        };
    }
    if (AUDIO_EXTENSIONS.has(extension)) {
        const attachment = await mediaAttachment(app, file);
        return {
            path: file.path,
            kind: "audio",
            text: "",
            attachments: attachment ? [attachment] : [],
            warnings: attachment
                ? ["Audio transcription requires a connected AI provider."]
                : ["The audio file is larger than the 12 MB AI limit."],
        };
    }
    return {
        path: file.path,
        kind: "text",
        text: (await app.vault.cachedRead(file)).slice(0, MAX_TEXT_LENGTH),
        attachments: [],
        warnings: [],
    };
}
