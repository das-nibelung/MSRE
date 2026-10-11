import {
    cloneOcclusionMasks,
    getOcclusionCardGroups,
    normalizeOcclusionMask,
    pointInOcclusionMask,
} from "src/ui/native-creator/image-occlusion";

describe("image occlusion geometry", () => {
    it("migrates legacy rectangles and cleans answer metadata", () => {
        expect(
            normalizeOcclusionMask({
                id: "",
                x: -1,
                y: 0.2,
                width: 2,
                height: 0.4,
                label: " Heart ",
                acceptedLabels: [" myocardium ", "myocardium", ""],
                concepts: [" anatomy "],
            }),
        ).toEqual({
            id: "mask-1",
            shape: "rectangle",
            x: 0,
            y: 0.2,
            width: 1,
            height: 0.4,
            points: [],
            label: "Heart",
            acceptedLabels: ["myocardium"],
            concepts: ["anatomy"],
            groupId: null,
        });
    });

    it("derives polygon bounds and keeps its points normalized", () => {
        const mask = normalizeOcclusionMask({
            id: "triangle",
            shape: "polygon",
            points: [
                { x: 0.2, y: 0.2 },
                { x: 0.8, y: 0.2 },
                { x: 0.5, y: 0.9 },
            ],
            label: "Triangle",
        });
        expect(mask).toMatchObject({ x: 0.2, y: 0.2 });
        expect(mask.width).toBeCloseTo(0.6);
        expect(mask.height).toBeCloseTo(0.7);
        expect(pointInOcclusionMask(mask, { x: 0.5, y: 0.4 })).toBe(true);
        expect(pointInOcclusionMask(mask, { x: 0.1, y: 0.1 })).toBe(false);
    });

    it("uses the real ellipse boundary for hit testing", () => {
        const ellipse = normalizeOcclusionMask({
            id: "ellipse",
            shape: "ellipse",
            x: 0.2,
            y: 0.2,
            width: 0.4,
            height: 0.4,
            label: "",
        });
        expect(pointInOcclusionMask(ellipse, { x: 0.4, y: 0.4 })).toBe(true);
        expect(pointInOcclusionMask(ellipse, { x: 0.21, y: 0.21 })).toBe(false);
    });

    it("turns grouped masks into one stable card and leaves ungrouped masks separate", () => {
        const masks = [
            normalizeOcclusionMask({ id: "a", groupId: "heart", label: "A" }),
            normalizeOcclusionMask({ id: "b", groupId: "heart", label: "B" }),
            normalizeOcclusionMask({ id: "c", label: "C" }),
        ];
        expect(
            getOcclusionCardGroups(masks).map((group) => [group.id, group.masks.length]),
        ).toEqual([
            ["heart", 2],
            ["c", 1],
        ]);
    });

    it("deep-clones points and labels for undo history", () => {
        const original = [
            normalizeOcclusionMask({
                id: "a",
                shape: "polygon",
                points: [
                    { x: 0, y: 0 },
                    { x: 1, y: 0 },
                    { x: 0, y: 1 },
                ],
                label: "A",
                acceptedLabels: ["Alpha"],
            }),
        ];
        const copy = cloneOcclusionMasks(original);
        copy[0].points![0].x = 0.5;
        copy[0].acceptedLabels!.push("Aleph");
        expect(original[0].points![0].x).toBe(0);
        expect(original[0].acceptedLabels).toEqual(["Alpha"]);
    });
});
