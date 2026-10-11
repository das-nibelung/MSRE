import { DEFAULT_DATA, PluginData } from "src/data/plugin-data";
import { DEFAULT_SETTINGS, SRSettings, upgradeSettings } from "src/data/settings";
import SRPlugin from "src/main";
import { setDebugParser } from "src/parser";

/**
 * Custom error class for plugin data errors.
 */
export class PluginDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PluginDataError";
    }
}

/**
 * Manages the plugin data.
 */
export class PluginDataManager {
    private plugin: SRPlugin;
    private _pluginData: PluginData | null = null;

    constructor(plugin: SRPlugin) {
        this.plugin = plugin;
    }

    get isLoaded(): boolean {
        return this.pluginData !== null;
    }

    get pluginData(): PluginData {
        if (this._pluginData === null)
            throw new PluginDataError(
                "Cant access the plugin data, as the plugin data is not yet loaded!!",
            );
        return this._pluginData;
    }

    set pluginData(pluginData: PluginData) {
        this._pluginData = pluginData;
    }

    /**
     * Loads the plugin data from the data.json from the plugin's folder.
     */
    async loadData(): Promise<void> {
        const loadedData: PluginData = (await this.plugin.loadData()) as PluginData;
        if (loadedData?.settings) upgradeSettings(loadedData.settings);
        this._pluginData = Object.assign({}, DEFAULT_DATA, loadedData);
        this._pluginData.settings = Object.assign({}, DEFAULT_SETTINGS, this._pluginData.settings);
        this._pluginData.managedDecks = Array.isArray(this._pluginData.managedDecks)
            ? [...new Set(this._pluginData.managedDecks.filter((path) => typeof path === "string"))]
            : [];
        this._pluginData.knowledgeAreas = Array.isArray(this._pluginData.knowledgeAreas)
            ? this._pluginData.knowledgeAreas
                  .filter(
                      (area) =>
                          area !== null &&
                          typeof area === "object" &&
                          typeof area.id === "string" &&
                          typeof area.name === "string",
                  )
                  .map((area) => ({
                      id: area.id,
                      name: area.name.trim(),
                      deckPaths: Array.isArray(area.deckPaths)
                          ? [
                                ...new Set(
                                    area.deckPaths.filter(
                                        (path): path is string => typeof path === "string",
                                    ),
                                ),
                            ]
                          : [],
                      pinned: area.pinned === true,
                      scheduling:
                          area.scheduling && typeof area.scheduling === "object"
                              ? {
                                    ...area.scheduling,
                                    desiredRetention:
                                        typeof area.scheduling.desiredRetention === "number"
                                            ? Math.max(
                                                  0.7,
                                                  Math.min(0.99, area.scheduling.desiredRetention),
                                              )
                                            : undefined,
                                    learningSteps: Array.isArray(area.scheduling.learningSteps)
                                        ? area.scheduling.learningSteps
                                              .map(Number)
                                              .filter((value) => value > 0)
                                        : undefined,
                                    relearningSteps: Array.isArray(area.scheduling.relearningSteps)
                                        ? area.scheduling.relearningSteps
                                              .map(Number)
                                              .filter((value) => value > 0)
                                        : undefined,
                                }
                              : undefined,
                  }))
                  .filter((area) => area.name.length > 0)
            : [];
        this._pluginData.savedCardQueries = Array.isArray(this._pluginData.savedCardQueries)
            ? this._pluginData.savedCardQueries
                  .filter(
                      (query) =>
                          query !== null &&
                          typeof query === "object" &&
                          typeof query.id === "string" &&
                          typeof query.name === "string" &&
                          typeof query.query === "string",
                  )
                  .map((query) => ({
                      id: query.id,
                      name: query.name.trim(),
                      query: query.query.trim(),
                      dynamic: query.dynamic === true,
                      createdAt: Number(query.createdAt) || Date.now(),
                      updatedAt: Number(query.updatedAt) || Date.now(),
                  }))
                  .filter((query) => query.name.length > 0 && query.query.length > 0)
            : [];
        const allowedBrowserColumns = new Set([
            "question",
            "answer",
            "deck",
            "area",
            "type",
            "state",
            "due",
            "interval",
            "ease",
            "reps",
            "lapses",
            "retention",
            "note",
            "tags",
            "last-review",
        ]);
        this._pluginData.cardBrowserColumns = Array.isArray(this._pluginData.cardBrowserColumns)
            ? [
                  ...new Set(
                      this._pluginData.cardBrowserColumns.filter(
                          (column): column is string =>
                              typeof column === "string" && allowedBrowserColumns.has(column),
                      ),
                  ),
              ]
            : [];
        if (this._pluginData.cardBrowserColumns.length === 0) {
            this._pluginData.cardBrowserColumns = [
                "question",
                "answer",
                "deck",
                "state",
                "due",
                "interval",
            ];
        }

        setDebugParser(this._pluginData.settings.showParserDebugMessages);
    }

    /**
     * Saves the plugin data.
     *
     * @returns {Promise<void>} - A promise that resolves when the plugin data is saved.
     * @throws {Error} - Throws an error if the plugin data is not loaded.
     */
    async savePluginData(): Promise<void> {
        if (this.pluginData === null)
            throw new PluginDataError("Cant save plugin data, as the data is not yet loaded!!");
        await this.plugin.saveData(this.pluginData);
    }

    /**
     * Writes the settings to the plugin data.
     *
     * @param {SRSettings} settings - The settings to write.
     * @returns {Promise<void>} - A promise that resolves when the settings are written.
     * @throws {Error} - Throws an error if the plugin data is not loaded.
     */
    public async writeSettings(settings: SRSettings): Promise<void> {
        if (this.pluginData === null)
            throw new PluginDataError(
                "Cant write settings, as the plugin data is not yet loaded!!",
            );
        this.pluginData.settings = settings;
        await this.savePluginData();
    }
}
