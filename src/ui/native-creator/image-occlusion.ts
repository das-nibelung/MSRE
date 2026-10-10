export interface OcclusionMask {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
}

export type OcclusionMode = "hide-one" | "hide-all";

export interface LoadedOcclusionImage {
    file: File;
    dataUrl: string;
    width: number;
    height: number;
}

export interface RenderedOcclusionAsset {
    maskId: string;
    question: ArrayBuffer;
    answer: ArrayBuffer;
}

function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") resolve(reader.result);
            else reject(new Error("image-read-failed"));
        });
        reader.addEventListener("error", () =>
            reject(reader.error ?? new Error("image-read-failed")),
        );
        reader.readAsDataURL(file);
    });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener("load", () => resolve(image));
        image.addEventListener("error", () => reject(new Error("image-decode-failed")));
        image.src = dataUrl;
    });
}

export async function loadOcclusionImage(file: File): Promise<LoadedOcclusionImage> {
    if (!file.type.startsWith("image/")) throw new Error("image-required");
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImage(dataUrl);
    return {
        file,
        dataUrl,
        width: image.naturalWidth,
        height: image.naturalHeight,
    };
}

function canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (!blob) {
                reject(new Error("image-export-failed"));
                return;
            }
            void blob.arrayBuffer().then(resolve, reject);
        }, "image/png");
    });
}

function drawMask(
    context: CanvasRenderingContext2D,
    mask: OcclusionMask,
    width: number,
    height: number,
    style: "hidden" | "target" | "answer",
): void {
    const x = mask.x * width;
    const y = mask.y * height;
    const maskWidth = mask.width * width;
    const maskHeight = mask.height * height;
    context.save();
    context.lineWidth = Math.max(3, Math.min(width, height) * 0.004);
    context.strokeStyle = style === "answer" ? "#ff453a" : "rgba(255, 255, 255, 0.92)";
    if (style === "answer") {
        context.fillStyle = "rgba(255, 69, 58, 0.16)";
        context.fillRect(x, y, maskWidth, maskHeight);
    } else {
        context.fillStyle = style === "target" ? "#7c3aed" : "rgba(28, 28, 30, 0.96)";
        context.fillRect(x, y, maskWidth, maskHeight);
    }
    context.strokeRect(x, y, maskWidth, maskHeight);
    context.restore();
}

export async function renderOcclusionAssets(
    source: LoadedOcclusionImage,
    masks: OcclusionMask[],
    mode: OcclusionMode = "hide-all",
): Promise<RenderedOcclusionAsset[]> {
    const image = await loadImage(source.dataUrl);
    const scale = Math.min(1, 2400 / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    const canvas = activeDocument.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas-unavailable");

    const result: RenderedOcclusionAsset[] = [];
    for (const mask of masks) {
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const questionMasks = mode === "hide-one" ? [mask] : masks;
        for (const candidate of questionMasks) {
            drawMask(
                context,
                candidate,
                width,
                height,
                candidate.id === mask.id ? "target" : "hidden",
            );
        }
        const question = await canvasToArrayBuffer(canvas);

        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        drawMask(context, mask, width, height, "answer");
        const answer = await canvasToArrayBuffer(canvas);
        result.push({ maskId: mask.id, question, answer });
    }
    return result;
}
