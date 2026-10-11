import EmulatedPlatform from "src/utils/platform-detector";

test("Emulation should be off", () => {
    expect(EmulatedPlatform().isEmulated).toEqual(false);
});

test("The emulated platform shouldn't be detected as desktop", () => {
    expect(EmulatedPlatform().isDesktop).toEqual(false);
});

test("The emulated platform shouldn't be detected as mobile", () => {
    expect(EmulatedPlatform().isMobile).toEqual(false);
});

test("The emulated platform shouldn't be detected as phone", () => {
    expect(EmulatedPlatform().isPhone).toEqual(false);
});

test("The emulated platform shouldn't be detected as tablet", () => {
    expect(EmulatedPlatform().isTablet).toEqual(false);
});

test("Debug emulation distinguishes desktop, phone, and tablet layouts", () => {
    const currentDocument = document;
    (globalThis as unknown as { activeDocument: Document }).activeDocument = currentDocument;
    currentDocument.body.className = "";
    expect(EmulatedPlatform(true)).toMatchObject({ isDesktop: true, isMobile: false });

    currentDocument.body.className = "emulate-mobile is-phone";
    expect(EmulatedPlatform(true)).toMatchObject({
        isDesktop: false,
        isMobile: true,
        isPhone: true,
        isTablet: false,
        isEmulated: true,
    });

    currentDocument.body.className = "emulate-mobile is-tablet";
    expect(EmulatedPlatform(true)).toMatchObject({ isPhone: false, isTablet: true });
    currentDocument.body.className = "";
});
