/* eslint-disable no-undef */
/* eslint-disable getter-return */

class TFile {
    /** @param {string} path */
    constructor(path = "") {
        this.path = path;
        this.name = path.split("/").pop() ?? "";
        this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
        this.basename = this.extension
            ? this.name.slice(0, -(this.extension.length + 1))
            : this.name;
    }
}

module.exports = {
    moment: {
        locale: jest.fn(() => "en"),
    },
    PluginSettingTab: jest.fn().mockImplementation(),
    Platform: {
        get isMobile() {
            jest.fn(() => false);
        },
    },

    Notice: jest.fn().mockImplementation(),
    TFile,
    /** @param {string} path */
    normalizePath: (path) =>
        path
            .replace(/\\/g, "/")
            .replace(/\/{2,}/g, "/")
            .replace(/^\//, "")
            .replace(/\/$/, ""),
};
