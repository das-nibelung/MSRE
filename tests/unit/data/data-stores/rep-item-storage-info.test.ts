import { RepItemStorageInfo } from "src/data/data-store/base/rep-item-storage-info";

test("Just to make code coverage analysis happy", () => {
    expect(new RepItemStorageInfo("note.md", "hash", "^stable-id")).toEqual({
        notePath: "note.md",
        questionHash: "hash",
        questionId: "^stable-id",
    });
});
