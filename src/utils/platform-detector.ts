import { DEBUG_MODE_ENABLED } from "src/data/constants";

export interface EmulatedPlatform {
    isDesktop: boolean;
    isMobile: boolean;
    isPhone: boolean;
    isTablet: boolean;
    isEmulated: boolean;
}

/**
 * Detects the emulated platform (once debug mode is active) and returns a CustomPlatform object with boolean properties indicating whether the emulated platform is desktop, mobile, tablet, or phone.
 *
 * @returns {EmulatedPlatform} An object containing boolean properties for the emulated platform.
 */
export default function EmulatedPlatform(debugMode = DEBUG_MODE_ENABLED): EmulatedPlatform {
    const hasClass = (name: string) => activeDocument.body.classList.contains(name);
    return {
        isDesktop: debugMode && !hasClass("emulate-mobile"),
        isMobile: debugMode && hasClass("emulate-mobile"),
        isPhone: debugMode && hasClass("emulate-mobile") && hasClass("is-phone"),
        isTablet: debugMode && hasClass("emulate-mobile") && hasClass("is-tablet"),
        isEmulated: debugMode && hasClass("emulate-mobile"),
    };
}
