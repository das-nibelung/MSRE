import { setIcon, Setting, SettingGroup } from "obsidian";

import { DataManager } from "src/data/data-manager";
import { DebugLoggerInstance } from "src/data/debug-logger";
import { SettingsManager } from "src/data/settings-manager";
import { t, tHTML } from "src/lang/helpers";
import { LocaleManagerInstance } from "src/lang/locale-manager";
import SRPlugin from "src/main";
import { setDebugParser } from "src/parser";
import { SettingsPage } from "src/ui/obsidian-ui-components/content-container/settings-page/settings-page";
import {
    getPageIcon,
    getPageName,
    SettingsPageType,
    SettingsPageTypesArray,
} from "src/ui/obsidian-ui-components/content-container/settings-page/settings-page-manager";

/**
 * Represents the main settings page, from which all other settings pages are accessed.
 *
 * @class MainPage
 * @extends {SettingsPage}
 */
export class MainPage extends SettingsPage {
    constructor(
        pageContainerEl: HTMLElement,
        plugin: SRPlugin,
        settingsManager: SettingsManager,
        dataManager: DataManager,
        pageType: SettingsPageType,
        display: () => void,
        openPage: (pageType: SettingsPageType) => void,
        scrollListener: (scrollPosition: number) => void,
    ) {
        super(
            pageContainerEl,
            plugin,
            settingsManager,
            dataManager,
            pageType,
            () => {},
            display,
            openPage,
            scrollListener,
        );

        this.containerEl.addClass("sr-main-page");

        this.containerEl.createEl("h2", {
            cls: "sr-settings-main-title",
            text: t("SETTINGS_TAB_HEADING"),
        });
        const searchShell = this.containerEl.createDiv("sr-settings-search");
        const searchIcon = searchShell.createSpan("sr-settings-search-icon");
        searchIcon.setAttribute("aria-hidden", "true");
        setIcon(searchIcon, "search");
        const searchInput = searchShell.createEl("input", {
            attr: {
                type: "search",
                name: "settings-search",
                placeholder: `${t("SEARCH")}…`,
                autocomplete: "off",
                "aria-label": t("SEARCH"),
            },
        });

        const navigation = this.containerEl.createDiv("sr-settings-navigation");
        const navigationButtons: Array<{ button: HTMLButtonElement; label: string }> = [];
        SettingsPageTypesArray.forEach((pageType) => {
            if (pageType === "main-page") return;
            const label = getPageName(pageType);
            const button = navigation.createEl("button", {
                cls: "sr-settings-navigation-item",
                attr: { type: "button", "aria-label": label },
            });
            const iconEl = button.createSpan("sr-settings-page-title-icon");
            iconEl.setAttribute("aria-hidden", "true");
            setIcon(iconEl, getPageIcon(pageType));
            button.createSpan({ cls: "sr-settings-navigation-label", text: label });
            const chevron = button.createSpan("sr-settings-navigation-chevron");
            chevron.setAttribute("aria-hidden", "true");
            setIcon(chevron, "chevron-right");
            button.addEventListener("click", () => this.openPage(pageType));
            navigationButtons.push({ button, label: label.toLocaleLowerCase() });
        });
        searchInput.addEventListener("input", () => {
            const query = searchInput.value.trim().toLocaleLowerCase();
            for (const entry of navigationButtons) {
                entry.button.hidden = Boolean(query) && !entry.label.includes(query);
            }
        });

        new SettingGroup(this.containerEl).addSetting((setting: Setting) => {
            setting
                .setName(t("LANGUAGE_SETTINGS"))
                .setDesc(t("LANGUAGE_SETTINGS_DESC"))
                .addDropdown((dropdown) => {
                    dropdown.addOption("-", t("DEFAULT_LOCALE_NAME"));

                    LocaleManagerInstance.getInstance()
                        .getLocaleOptionsList()
                        .forEach((option) => {
                            dropdown.addOption(option.language, option.languageName);
                        });

                    dropdown.setValue(this.settingsManager.settings.preferredLocale);

                    dropdown.onChange(async (value) => {
                        if (value === "-") {
                            const loadedLocale: string =
                                LocaleManagerInstance.getInstance().loadedLocale;
                            LocaleManagerInstance.getInstance().currentLocale = loadedLocale;
                        } else {
                            LocaleManagerInstance.getInstance().currentLocale = value;
                        }
                        this.settingsManager.settings.preferredLocale = value;
                        await this.plugin.dataManager.savePluginData();
                        this.display();
                    });
                });
        });

        new SettingGroup(this.containerEl)
            .setHeading(t("INFO"))
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("CHECK_WIKI", {
                    wikiUrl: "https://stephenmwangi.com/obsidian-spaced-repetition/",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            })
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("CHECK_ROADMAP", {
                    roadMapUrl: "https://github.com/users/st3v3nmw/projects/6",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            })
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("CHECK_DEV_NEWS", {
                    devNewsUrl:
                        "https://github.com/st3v3nmw/obsidian-spaced-repetition/discussions/categories/development-news",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            });

        new SettingGroup(this.containerEl)
            .setHeading(t("HELP") + " & " + t("GROUP_CONTRIBUTING"))
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("GITHUB_DISCUSSIONS", {
                    discussionsUrl:
                        "https://github.com/st3v3nmw/obsidian-spaced-repetition/discussions/",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            })
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("GITHUB_ISSUES", {
                    issuesUrl: "https://github.com/st3v3nmw/obsidian-spaced-repetition/issues/",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            })
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("GITHUB_SOURCE_CODE", {
                    githubProjectUrl: "https://github.com/st3v3nmw/obsidian-spaced-repetition",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            })
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("CODE_CONTRIBUTION_INFO", {
                    codeContributionUrl:
                        "https://stephenmwangi.com/obsidian-spaced-repetition/contributing/#code",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            })
            .addSetting((setting: Setting) => {
                const elements: (HTMLElement | Text)[] = tHTML("TRANSLATION_CONTRIBUTION_INFO", {
                    translationContributionUrl:
                        "https://stephenmwangi.com/obsidian-spaced-repetition/contributing/#translating",
                });

                setting.infoEl.empty();

                for (let i = 0; i < elements.length; i++) {
                    setting.infoEl.append(elements[i]);
                }
            });

        new SettingGroup(this.containerEl)
            .setHeading(t("LOGGING"))
            .addSetting((setting: Setting) => {
                setting.setName(t("DISPLAY_SCHEDULING_DEBUG_INFO")).addToggle((toggle) =>
                    toggle
                        .setValue(this.settingsManager.settings.showSchedulingDebugMessages)
                        .onChange(async (value) => {
                            this.settingsManager.settings.showSchedulingDebugMessages = value;
                            await this.settingsManager.save();
                        }),
                );
            })
            .addSetting((setting: Setting) => {
                setting.setName(t("DISPLAY_PARSER_DEBUG_INFO")).addToggle((toggle) =>
                    toggle
                        .setValue(this.settingsManager.settings.showParserDebugMessages)
                        .onChange(async (value) => {
                            this.settingsManager.settings.showParserDebugMessages = value;
                            setDebugParser(this.settingsManager.settings.showParserDebugMessages);
                            await this.settingsManager.save();
                        }),
                );
            })
            .addSetting((setting: Setting) => {
                setting
                    .setName(t("DEBUG_LOG"))
                    .addTextArea((text) =>
                        text.setValue(DebugLoggerInstance.getInstance().getLog("info")),
                    )
                    .addExtraButton((button) => {
                        button
                            .setIcon("copy")
                            .setTooltip(t("COPY"))
                            .onClick(async () => {
                                await navigator.clipboard.writeText(
                                    DebugLoggerInstance.getInstance().getLog("info"),
                                );
                            });
                    });
            });
    }
}
