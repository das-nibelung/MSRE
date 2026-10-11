export type OcclusionShape = "rectangle" | "ellipse" | "polygon";

export interface OcclusionPoint {
    x: number;
    y: number;
}

export interface OcclusionMask {
    id: string;
    shape?: OcclusionShape;
    x: number;
    y: number;
    width: number;
    height: number;
    points?: OcclusionPoint[];
    label: string;
    acceptedLabels?: string[];
    concepts?: string[];
    groupId?: string | null;
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
    maskIds: string[];
    question: ArrayBuffer;
    answer: ArrayBuffer;
}

export interface OcclusionCardGroup {
    id: string;
    masks: OcclusionMask[];
}

function clamp(value: number): number {
    return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function cleanStrings(values: string[] | undefined): string[] {
    return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

export function normalizeOcclusionMask(mask: Partial<OcclusionMask>, index = 0): OcclusionMask {
    const points = (mask.points ?? []).map((point) => ({
        x: clamp(point.x),
        y: clamp(point.y),
    }));
    const shape: OcclusionShape =
        mask.shape === "ellipse" || mask.shape === "polygon" ? mask.shape : "rectangle";
    const pointXs = points.map((point) => point.x);
    const pointYs = points.map((point) => point.y);
    const fallbackX = pointXs.length ? Math.min(...pointXs) : 0;
    const fallbackY = pointYs.length ? Math.min(...pointYs) : 0;
    const x = clamp(mask.x ?? fallbackX);
    const y = clamp(mask.y ?? fallbackY);
    const width = Math.min(
        1 - x,
        Math.max(0, mask.width ?? (pointXs.length ? Math.max(...pointXs) - x : 0.1)),
    );
    const height = Math.min(
        1 - y,
        Math.max(0, mask.height ?? (pointYs.length ? Math.max(...pointYs) - y : 0.1)),
    );
    return {
        id: mask.id?.trim() || `mask-${index + 1}`,
        shape,
        x,
        y,
        width,
        height,
        points: shape === "polygon" ? points : [],
        label: mask.label?.trim() ?? "",
        acceptedLabels: cleanStrings(mask.acceptedLabels),
        concepts: cleanStrings(mask.concepts),
        groupId: mask.groupId?.trim() || null,
    };
}

export function cloneOcclusionMasks(masks: OcclusionMask[]): OcclusionMask[] {
    return masks.map((mask, index) =>
        normalizeOcclusionMask(JSON.parse(JSON.stringify(mask)), index),
    );
}

export function getOcclusionCardGroups(masks: OcclusionMask[]): OcclusionCardGroup[] {
    const groups = new Map<string, OcclusionMask[]>();
    for (const mask of masks) {
        const id = mask.groupId?.trim() || mask.id;
        groups.set(id, [...(groups.get(id) ?? []), mask]);
    }
    return [...groups].map(([id, groupedMasks]) => ({ id, masks: groupedMasks }));
}

export function pointInOcclusionMask(mask: OcclusionMask, point: OcclusionPoint): boolean {
    if (mask.shape === "polygon" && (mask.points?.length ?? 0) >= 3) {
        let inside = false;
        const points = mask.points ?? [];
        for (
            let current = 0, previous = points.length - 1;
            current < points.length;
            previous = current++
        ) {
            const left = points[current];
            const right = points[previous];
            const intersects =
                left.y > point.y !== right.y > point.y &&
                point.x <
                    ((right.x - left.x) * (point.y - left.y)) / (right.y - left.y || 1e-9) + left.x;
            if (intersects) inside = !inside;
        }
        return inside;
    }
    if (mask.shape === "ellipse") {
        if (mask.width <= 0 || mask.height <= 0) return false;
        const dx = (point.x - (mask.x + mask.width / 2)) / (mask.width / 2);
        const dy = (point.y - (mask.y + mask.height / 2)) / (mask.height / 2);
        return dx * dx + dy * dy <= 1;
    }
    return (
        point.x >= mask.x &&
        point.x <= mask.x + mask.width &&
        point.y >= mask.y &&
        point.y <= mask.y + mask.height
    );
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
    context.beginPath();
    if (mask.shape === "ellipse") {
        context.ellipse(
            x + maskWidth / 2,
            y + maskHeight / 2,
            maskWidth / 2,
            maskHeight / 2,
            0,
            0,
            Math.PI * 2,
        );
    } else if (mask.shape === "polygon" && (mask.points?.length ?? 0) >= 3) {
        const points = mask.points ?? [];
        context.moveTo(points[0].x * width, points[0].y * height);
        for (const point of points.slice(1)) context.lineTo(point.x * width, point.y * height);
        context.closePath();
    } else {
        context.rect(x, y, maskWidth, maskHeight);
    }
    if (style === "answer") {
        context.fillStyle = "rgba(255, 69, 58, 0.16)";
    } else {
        context.fillStyle = style === "target" ? "#7c3aed" : "rgba(28, 28, 30, 0.96)";
    }
    context.fill();
    context.stroke();
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

    const normalizedMasks = masks.map(normalizeOcclusionMask);
    const groups = getOcclusionCardGroups(normalizedMasks);
    const result: RenderedOcclusionAsset[] = [];
    for (const group of groups) {
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const questionMasks = mode === "hide-one" ? group.masks : normalizedMasks;
        for (const candidate of questionMasks) {
            drawMask(
                context,
                candidate,
                width,
                height,
                group.masks.some((mask) => mask.id === candidate.id) ? "target" : "hidden",
            );
        }
        const question = await canvasToArrayBuffer(canvas);

        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        for (const mask of group.masks) drawMask(context, mask, width, height, "answer");
        const answer = await canvasToArrayBuffer(canvas);
        result.push({
            maskId: group.id,
            maskIds: group.masks.map((mask) => mask.id),
            question,
            answer,
        });
    }
    return result;
}
