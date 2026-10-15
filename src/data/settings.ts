import { StorageType } from "src/data/data-store/base/data-store";
import { t } from "src/lang/helpers";
import { SRAlgorithmType } from "src/scheduling/algorithms/base/isr-algorithm";
import { pathMatchesPattern } from "src/utils/fs";

export type ReviewReminderScope = "all" | "deck" | "area";
export type ReviewReminderSmartMode = "none" | "overload" | "forecast" | "deadline" | "weak";
export type ReviewReminderExternalProvider = "off" | "ntfy" | "gotify" | "home-assistant";

export interface ReviewReminderRule {
    id: string;
    name: string;
    enabled: boolean;
    scope: ReviewReminderScope;
    scopeValue: string;
    days: number[];
    times: string[];
    minimumCards: number;
    cooldownMinutes: number;
    smartMode: ReviewReminderSmartMode;
    message: string;
}

export interface SRSettings {
    // flashcards
    flashcardTags: string[];
    flashcardTagsToIgnore: string[];
    convertFoldersToDecks: boolean;
    burySiblingCards: boolean;
    /** Fine-grained sibling policy. The legacy boolean remains a compatibility alias. */
    burySiblingMode: "off" | "new" | "review" | "all";
    randomizeCardOrder: boolean | undefined;
    flashcardCardOrder: string;
    flashcardDeckOrder: string;
    convertClozePatternsToInputs: boolean;
    convertHighlightsToClozes: boolean;
    convertBoldTextToClozes: boolean;
    convertCurlyBracketsToClozes: boolean;
    clozePatterns: string[];
    singleLineCardSeparator: string;
    singleLineReversedCardSeparator: string;
    multilineCardSeparator: string;
    multilineReversedCardSeparator: string;
    multilineCardEndMarker: string;
    editLaterTag: string | undefined;
    // Review reminder policy, delivery channels, and scoped rules.
    enableReviewReminders: boolean;
    reviewReminderIntervalMinutes: number;
    reviewReminderCheckOnStartup: boolean;
    reviewReminderMessage: string;
    reviewReminderAutoOpen: boolean;
    reviewReminderShowNotice: boolean;
    reviewReminderPlaySound: boolean;
    reviewReminderBounceDock: boolean;
    reviewReminderDays: number[];
    reviewReminderTimes: string[];
    reviewReminderQuietHoursEnabled: boolean;
    reviewReminderQuietHoursStart: string;
    reviewReminderQuietHoursEnd: string;
    reviewReminderCooldownMinutes: number;
    reviewReminderMinimumCards: number;
    reviewReminderSmartEnabled: boolean;
    reviewReminderForecastDays: number;
    reviewReminderDailyCapacity: number;
    reviewReminderSystemNotification: boolean;
    reviewReminderExternalProvider: ReviewReminderExternalProvider;
    reviewReminderExternalEndpoint: string;
    reviewReminderExternalTopic: string;
    reviewReminderHistoryLimit: number;
    reviewReminderRules: ReviewReminderRule[];

    // notes
    enableNoteReviewPaneOnStartup: boolean;
    tagsToReview: string[];
    noteTagsToIgnore: string[];
    noteFoldersToIgnore: string[];
    openRandomNote: boolean;
    autoNextNote: boolean;
    disableFileMenuReviewOptions: boolean | undefined;
    showFileMenuReviewOptions: boolean;
    deleteTagsOnSchedulingDataDeletion: boolean;
    maxNDaysNotesReviewQueue: number;

    // UI preferences
    showRibbonIcon: undefined | boolean;
    showStatusBar: boolean;
    showCardStatusBarItem: boolean;
    showNoteStatusBarItem: boolean;
    showUpdateAvailableStatusBarItem: boolean;
    initiallyExpandAllSubdecksInTree: boolean;
    showContextInCards: boolean;
    showIntervalInReviewButtons: boolean;
    flashcardHeightPercentage: number;
    flashcardWidthPercentage: number;
    flashcardHeightPercentageMobile: number;
    flashcardWidthPercentageMobile: number;
    flashcardAgainText: string;
    flashcardEasyText: string;
    flashcardGoodText: string;
    flashcardHardText: string;
    reviewButtonDelay: number;
    openViewInNewTabMobile: boolean;
    showDeleteButtonInCardView: boolean;
    showDeleteButtonInFileMenu: boolean;
    openViewInNewTab: boolean;
    useCustomHotkeys: boolean;
    useCalloutsForSchedulingComments: boolean;
    reviewSessionMinutes: number;
    reviewUndoDepth: number;
    reviewAheadDays: number;
    intelligentBacklog: boolean;
    /** Promotes weak prerequisites before cards that depend on them. */
    dependencyAwareScheduling: boolean;
    /** Prerequisites below this predicted recall are considered weak. */
    dependencyRetentionThreshold: number;
    autoPlayCardMedia: boolean;
    accessibleReviewMode: boolean;
    reduceReviewMotion: boolean;
    reviewGestureLeft: ReviewGestureAction;
    reviewGestureRight: ReviewGestureAction;
    reviewGestureUp: ReviewGestureAction;
    reviewGestureDown: ReviewGestureAction;
    autoSuggestFsrsOptimization: boolean;

    // automation and public API
    automationEnabled: boolean;
    automationWriteAccess: boolean;
    automationQueueEnabled: boolean;
    automationAccessToken: string;
    automationAllowedDeckPaths: string[];
    automationMaxBatchSize: number;
    automationAuditRetention: number;

    // AI co-author. API secrets are intentionally device-local and are not stored here.
    aiPreferredProvider: string;
    aiApiEndpoint: string;
    aiApiModel: string;
    aiApiProtocol: "responses" | "chat-completions";
    aiMcpEnabled: boolean;
    aiMcpWaitSeconds: number;

    // algorithm
    algorithm: SRAlgorithmType;
    baseEase: number;
    lapsesIntervalChange: number;
    easyBonus: number;
    loadBalance: boolean;
    maximumInterval: number;
    maxLinkFactor: number;
    fsrsDesiredRetention: number;
    startOfDay: string;

    // storage
    dataStore: StorageType;
    cardCommentOnSameLine: boolean;
    scheduleDataVaultLocation: string;

    // logging
    showSchedulingDebugMessages: boolean;
    showParserDebugMessages: boolean;

    preferredDateFormatForNoteReviewQueue: string;
    preferredLocale: string;
}

export type ReviewGestureAction = "none" | "reveal" | "again" | "hard" | "good" | "easy";

export const DEFAULT_SETTINGS: SRSettings = {
    // flashcards
    flashcardTags: ["#flashcards"],
    flashcardTagsToIgnore: [],
    convertFoldersToDecks: false,
    burySiblingCards: false,
    burySiblingMode: "off",
    flashcardCardOrder: "DueFirstRandom",
    flashcardDeckOrder: "PrevDeckComplete_Sequential",
    convertClozePatternsToInputs: false,
    convertHighlightsToClozes: true,
    convertBoldTextToClozes: false,
    convertCurlyBracketsToClozes: false,
    clozePatterns: ["==[123;;]answer[;;hint]=="],
    singleLineCardSeparator: "::",
    singleLineReversedCardSeparator: ":::",
    multilineCardSeparator: "?",
    multilineReversedCardSeparator: "??",
    multilineCardEndMarker: "",
    editLaterTag: undefined,
    enableReviewReminders: false,
    reviewReminderIntervalMinutes: 5,
    reviewReminderCheckOnStartup: false,
    reviewReminderMessage: "",
    reviewReminderAutoOpen: true,
    reviewReminderShowNotice: true,
    reviewReminderPlaySound: true,
    reviewReminderBounceDock: true,
    reviewReminderDays: [0, 1, 2, 3, 4, 5, 6],
    reviewReminderTimes: [],
    reviewReminderQuietHoursEnabled: false,
    reviewReminderQuietHoursStart: "22:00",
    reviewReminderQuietHoursEnd: "08:00",
    reviewReminderCooldownMinutes: 120,
    reviewReminderMinimumCards: 1,
    reviewReminderSmartEnabled: true,
    reviewReminderForecastDays: 3,
    reviewReminderDailyCapacity: 50,
    reviewReminderSystemNotification: false,
    reviewReminderExternalProvider: "off",
    reviewReminderExternalEndpoint: "",
    reviewReminderExternalTopic: "",
    reviewReminderHistoryLimit: 100,
    reviewReminderRules: [],
    randomizeCardOrder: undefined,

    // notes
    enableNoteReviewPaneOnStartup: true,
    tagsToReview: ["#review"],
    noteTagsToIgnore: [],
    noteFoldersToIgnore: ["**/*.excalidraw.md"],
    openRandomNote: false,
    autoNextNote: false,
    disableFileMenuReviewOptions: undefined,
    showFileMenuReviewOptions: true,
    deleteTagsOnSchedulingDataDeletion: false,
    maxNDaysNotesReviewQueue: 365,

    // UI settings
    showRibbonIcon: undefined,
    showStatusBar: true,
    showCardStatusBarItem: true,
    showNoteStatusBarItem: true,
    showUpdateAvailableStatusBarItem: true,
    initiallyExpandAllSubdecksInTree: true,
    showContextInCards: true,
    showIntervalInReviewButtons: true,
    flashcardHeightPercentage: 60,
    flashcardWidthPercentage: 60,
    flashcardHeightPercentageMobile: 100,
    flashcardWidthPercentageMobile: 100,
    flashcardAgainText: t("AGAIN"),
    flashcardEasyText: t("EASY"),
    flashcardGoodText: t("GOOD"),
    flashcardHardText: t("HARD"),
    reviewButtonDelay: 0,
    showDeleteButtonInCardView: false,
    showDeleteButtonInFileMenu: false,
    openViewInNewTab: false,
    openViewInNewTabMobile: true,
    useCustomHotkeys: false,
    useCalloutsForSchedulingComments: false,
    reviewSessionMinutes: 0,
    reviewUndoDepth: 20,
    reviewAheadDays: 0,
    intelligentBacklog: true,
    dependencyAwareScheduling: true,
    dependencyRetentionThreshold: 0.88,
    autoPlayCardMedia: true,
    accessibleReviewMode: false,
    reduceReviewMotion: false,
    reviewGestureLeft: "again",
    reviewGestureRight: "easy",
    reviewGestureUp: "good",
    reviewGestureDown: "hard",
    autoSuggestFsrsOptimization: true,

    // automation and public API
    automationEnabled: false,
    automationWriteAccess: false,
    automationQueueEnabled: false,
    automationAccessToken: "",
    automationAllowedDeckPaths: [],
    automationMaxBatchSize: 100,
    automationAuditRetention: 1000,

    // AI co-author
    aiPreferredProvider: "direct-api",
    aiApiEndpoint: "https://api.openai.com/v1/responses",
    aiApiModel: "",
    aiApiProtocol: "responses",
    aiMcpEnabled: true,
    aiMcpWaitSeconds: 180,

    // algorithm
    algorithm: SRAlgorithmType.SM_2_OSR,
    baseEase: 250,
    lapsesIntervalChange: 0.5,
    easyBonus: 1.3,
    loadBalance: true,
    maximumInterval: 36525,
    maxLinkFactor: 1.0,
    fsrsDesiredRetention: 0.9,
    startOfDay: "00:00:00",

    // storage
    dataStore: StorageType.NOTES,
    cardCommentOnSameLine: false,
    scheduleDataVaultLocation: "Spaced Repetition",

    // logging
    showSchedulingDebugMessages: false,
    showParserDebugMessages: false,
    preferredDateFormatForNoteReviewQueue: "MMM DD YYYY",
    preferredLocale: "-",
};

export function upgradeSettings(settings: SRSettings) {
    if (!settings.burySiblingMode) {
        settings.burySiblingMode = settings.burySiblingCards ? "all" : "off";
    }
    if (settings.showRibbonIcon) {
        settings.showRibbonIcon = DEFAULT_SETTINGS.showRibbonIcon;
    }

    if (
        settings.randomizeCardOrder !== null &&
        settings.randomizeCardOrder !== undefined &&
        (settings.flashcardCardOrder === null || settings.flashcardCardOrder === undefined) &&
        (settings.flashcardDeckOrder === null || settings.flashcardDeckOrder === undefined)
    ) {
        settings.flashcardCardOrder = settings.randomizeCardOrder
            ? "DueFirstRandom"
            : "DueFirstSequential";
        settings.flashcardDeckOrder = "PrevDeckComplete_Sequential";

        // After the upgrade, we don't need the old attribute any more
        settings.randomizeCardOrder = undefined;
    }

    if (settings.clozePatterns === null || settings.clozePatterns === undefined) {
        settings.clozePatterns = [];

        if (settings.convertHighlightsToClozes)
            settings.clozePatterns.push("==[123;;]answer[;;hint]==");

        if (settings.convertBoldTextToClozes)
            settings.clozePatterns.push("**[123;;]answer[;;hint]**");

        if (settings.convertCurlyBracketsToClozes)
            settings.clozePatterns.push("{{[123;;]answer[;;hint]}}");
    }

    if (settings.disableFileMenuReviewOptions !== undefined) {
        settings.disableFileMenuReviewOptions = undefined;
    }

    if (settings.editLaterTag) {
        settings.editLaterTag = undefined;
    }

    if (
        settings.scheduleDataVaultLocation === null ||
        settings.scheduleDataVaultLocation === undefined ||
        settings.scheduleDataVaultLocation.trim() === ""
    ) {
        settings.scheduleDataVaultLocation = DEFAULT_SETTINGS.scheduleDataVaultLocation;
    }

    if (settings.fsrsDesiredRetention === null || settings.fsrsDesiredRetention === undefined) {
        settings.fsrsDesiredRetention = DEFAULT_SETTINGS.fsrsDesiredRetention;
    }

    settings.reviewSessionMinutes = Math.max(0, Number(settings.reviewSessionMinutes) || 0);
    settings.reviewUndoDepth = Math.max(1, Math.min(100, Number(settings.reviewUndoDepth) || 20));
    settings.reviewAheadDays = Math.max(0, Math.min(365, Number(settings.reviewAheadDays) || 0));
    settings.dependencyAwareScheduling = settings.dependencyAwareScheduling !== false;
    settings.dependencyRetentionThreshold = Math.max(
        0.7,
        Math.min(0.99, Number(settings.dependencyRetentionThreshold) || 0.88),
    );
    settings.automationEnabled = settings.automationEnabled === true;
    settings.automationWriteAccess = settings.automationWriteAccess === true;
    settings.automationQueueEnabled = settings.automationQueueEnabled === true;
    settings.automationAccessToken = String(settings.automationAccessToken ?? "");
    settings.automationAllowedDeckPaths = Array.isArray(settings.automationAllowedDeckPaths)
        ? settings.automationAllowedDeckPaths
              .map(String)
              .map((path) => path.trim())
              .filter(Boolean)
        : [];
    settings.automationMaxBatchSize = Math.max(
        1,
        Math.min(1000, Number(settings.automationMaxBatchSize) || 100),
    );
    settings.automationAuditRetention = Math.max(
        50,
        Math.min(10_000, Number(settings.automationAuditRetention) || 1000),
    );

    // Only published reminder settings are upgraded here. We deliberately do not preserve
    // unpublished draft field names from this feature branch, so the shipped schema stays clean.
    if (settings.enableReviewReminders === null || settings.enableReviewReminders === undefined) {
        settings.enableReviewReminders = DEFAULT_SETTINGS.enableReviewReminders;
    }

    if (
        settings.reviewReminderIntervalMinutes === null ||
        settings.reviewReminderIntervalMinutes === undefined ||
        settings.reviewReminderIntervalMinutes < 1
    ) {
        settings.reviewReminderIntervalMinutes = DEFAULT_SETTINGS.reviewReminderIntervalMinutes;
    }

    if (
        settings.reviewReminderCheckOnStartup === null ||
        settings.reviewReminderCheckOnStartup === undefined
    ) {
        settings.reviewReminderCheckOnStartup = DEFAULT_SETTINGS.reviewReminderCheckOnStartup;
    }

    if (settings.reviewReminderMessage === null || settings.reviewReminderMessage === undefined) {
        settings.reviewReminderMessage = DEFAULT_SETTINGS.reviewReminderMessage;
    }

    if (settings.reviewReminderAutoOpen === null || settings.reviewReminderAutoOpen === undefined) {
        settings.reviewReminderAutoOpen = DEFAULT_SETTINGS.reviewReminderAutoOpen;
    }

    if (
        settings.reviewReminderShowNotice === null ||
        settings.reviewReminderShowNotice === undefined
    ) {
        settings.reviewReminderShowNotice = DEFAULT_SETTINGS.reviewReminderShowNotice;
    }

    if (
        settings.reviewReminderPlaySound === null ||
        settings.reviewReminderPlaySound === undefined
    ) {
        settings.reviewReminderPlaySound = DEFAULT_SETTINGS.reviewReminderPlaySound;
    }

    if (
        settings.reviewReminderBounceDock === null ||
        settings.reviewReminderBounceDock === undefined
    ) {
        settings.reviewReminderBounceDock = DEFAULT_SETTINGS.reviewReminderBounceDock;
    }

    settings.reviewReminderDays = Array.isArray(settings.reviewReminderDays)
        ? [
              ...new Set(
                  settings.reviewReminderDays.map(Number).filter((day) => day >= 0 && day <= 6),
              ),
          ]
        : [...DEFAULT_SETTINGS.reviewReminderDays];
    settings.reviewReminderTimes = Array.isArray(settings.reviewReminderTimes)
        ? settings.reviewReminderTimes
              .map(String)
              .filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
        : [];
    settings.reviewReminderQuietHoursEnabled = settings.reviewReminderQuietHoursEnabled === true;
    settings.reviewReminderQuietHoursStart = /^([01]\d|2[0-3]):[0-5]\d$/.test(
        String(settings.reviewReminderQuietHoursStart ?? ""),
    )
        ? String(settings.reviewReminderQuietHoursStart)
        : DEFAULT_SETTINGS.reviewReminderQuietHoursStart;
    settings.reviewReminderQuietHoursEnd = /^([01]\d|2[0-3]):[0-5]\d$/.test(
        String(settings.reviewReminderQuietHoursEnd ?? ""),
    )
        ? String(settings.reviewReminderQuietHoursEnd)
        : DEFAULT_SETTINGS.reviewReminderQuietHoursEnd;
    settings.reviewReminderCooldownMinutes = Math.max(
        1,
        Math.min(10_080, Number(settings.reviewReminderCooldownMinutes) || 120),
    );
    settings.reviewReminderMinimumCards = Math.max(
        1,
        Math.min(100_000, Number(settings.reviewReminderMinimumCards) || 1),
    );
    settings.reviewReminderSmartEnabled = settings.reviewReminderSmartEnabled !== false;
    settings.reviewReminderForecastDays = Math.max(
        1,
        Math.min(30, Number(settings.reviewReminderForecastDays) || 3),
    );
    settings.reviewReminderDailyCapacity = Math.max(
        1,
        Math.min(10_000, Number(settings.reviewReminderDailyCapacity) || 50),
    );
    settings.reviewReminderSystemNotification = settings.reviewReminderSystemNotification === true;
    settings.reviewReminderExternalProvider = ["ntfy", "gotify", "home-assistant"].includes(
        String(settings.reviewReminderExternalProvider),
    )
        ? (settings.reviewReminderExternalProvider as ReviewReminderExternalProvider)
        : "off";
    settings.reviewReminderExternalEndpoint = String(settings.reviewReminderExternalEndpoint ?? "");
    settings.reviewReminderExternalTopic = String(settings.reviewReminderExternalTopic ?? "");
    settings.reviewReminderHistoryLimit = Math.max(
        20,
        Math.min(500, Number(settings.reviewReminderHistoryLimit) || 100),
    );
    settings.reviewReminderRules = Array.isArray(settings.reviewReminderRules)
        ? settings.reviewReminderRules
              .filter((rule) => rule && typeof rule === "object")
              .map((rule, index) => ({
                  id: String(rule.id || `reminder-rule-${index}`),
                  name: String(rule.name || "Reminder rule"),
                  enabled: rule.enabled !== false,
                  scope: (["deck", "area"].includes(rule.scope)
                      ? rule.scope
                      : "all") as ReviewReminderScope,
                  scopeValue: String(rule.scopeValue ?? ""),
                  days: Array.isArray(rule.days)
                      ? [...new Set(rule.days.map(Number).filter((day) => day >= 0 && day <= 6))]
                      : [...DEFAULT_SETTINGS.reviewReminderDays],
                  times: Array.isArray(rule.times)
                      ? rule.times
                            .map(String)
                            .filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
                      : [],
                  minimumCards: Math.max(1, Number(rule.minimumCards) || 1),
                  cooldownMinutes: Math.max(1, Number(rule.cooldownMinutes) || 120),
                  smartMode: (["overload", "forecast", "deadline", "weak"].includes(rule.smartMode)
                      ? rule.smartMode
                      : "none") as ReviewReminderSmartMode,
                  message: String(rule.message ?? ""),
              }))
        : [];
}

export class SettingsUtil {
    static isFlashcardTag(settings: SRSettings, tag: string): boolean {
        return SettingsUtil.isTagInList(settings.flashcardTags, tag);
    }

    static isPathInFoldersToIgnore(settings: SRSettings, path: string): boolean {
        return settings.noteFoldersToIgnore.some((folder) => pathMatchesPattern(path, folder));
    }

    static isAnyTagANoteReviewTag(settings: SRSettings, tags: string[]): boolean {
        for (const tag of tags) {
            if (
                settings.tagsToReview.some((tagToReview) =>
                    this.isSubTagContainedInTag(tagToReview, tag),
                )
            ) {
                return true;
            }
        }
        return false;
    }

    static isAnyTagIgnoredForFlashcards(settings: SRSettings, tags: string[]): boolean {
        return tags.some((tag) => SettingsUtil.isTagInList(settings.flashcardTagsToIgnore, tag));
    }

    static isAnyTagIgnoredForNotes(settings: SRSettings, tags: string[]): boolean {
        return tags.some((tag) => SettingsUtil.isTagInList(settings.noteTagsToIgnore, tag));
    }

    // Given a list of tags, return the subset that is in settings.tagsToReview
    static filterForNoteReviewTag(settings: SRSettings, tags: string[]): string[] {
        const result: string[] = [];
        for (const tagToReview of settings.tagsToReview) {
            if (tags.some((tag) => this.isSubTagContainedInTag(tagToReview, tag))) {
                result.push(tagToReview);
            }
        }
        return result;
    }

    /**
     * Checks if the tag is in the tagList.
     *
     * @param tagList - The list of tags to check.
     * @param tag - The tag to check.
     * @param exactMatch - Whether to match the tag exactly or if it should be a sub tag.
     * @returns true if the tag is in the tagList, false otherwise.
     */
    public static isTagInList(
        tagList: string[],
        tag: string,
        exactMatch: boolean = false,
    ): boolean {
        // This should be true, if the tag is fully contained in a tag from the list
        for (const tagFromList of tagList) {
            if (exactMatch) {
                if (tagFromList === tag) {
                    // The tag from the list is the same as the current tag, so it is contained in it
                    return true;
                }
            } else {
                // In this case we need to look more in detail to see if the tag is fully contained in the tag from the list
                if (this.isSubTagContainedInTag(tagFromList, tag)) {
                    // The tag from the list is contained in the current tag, so it is contained in it
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Checks if the subTag is contained in the tag.
     *
     * @param tag - The tag to check.
     * @param subTag - The subTag to check.
     * @returns true if the subTag is contained in the tag, false otherwise.
     */
    public static isSubTagContainedInTag(tag: string, subTag: string): boolean {
        if (tag === subTag || subTag.startsWith(tag + "/")) {
            // The tag is the same as the sub tag, or the sub tag is contained in the tag
            return true;
        }
        return false;
    }
}
