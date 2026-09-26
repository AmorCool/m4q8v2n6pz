/**
 * The settings window.
 *
 * The original mounts the settings centre as a Vue view inside the main
 * renderer (`setting-center-view`, renderer.js:36832-37100), but its own
 * comments and the recovered layout show it is a full-screen page with its own
 * left navigation -- and the spec's landing table asks for it as its own
 * window through the shared registry. This file is that window's life and
 * nothing else, exactly like `newtask.js` and `panwindow.js`.
 *
 * Size and frame come from the spec's landing table: 920x640, framed. It is
 * resizable because the form is long and a fixed frame would clip the last
 * category on a small screen; the original's own container is `overflow-y:auto`
 * for the same reason.
 *
 * No `electron` here, and no config store: the page reads and writes settings
 * over the transport, so this module stays loadable under plain node.
 */

"use strict";

const path = require("path");

/** Window name in the shared registry. */
const WINDOW_NAME = "settings";

const WINDOW_OPTIONS = Object.freeze({
    width: 920,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    title: "设置",
});

class SettingsWindowService {
    /**
     * @param {object} options
     * @param {object} options.windowManager  the shared registry
     * @param {function} [options.log]
     * @param {string} [options.page]         the page to load
     */
    constructor(options) {
        const opts = options || {};
        this.windowManager = opts.windowManager;
        this.log = opts.log || (() => {});
        this.page = opts.page || path.join(__dirname, "..", "windows", "settings", "index.html");
    }

    /**
     * Open the window, or focus the one already open.
     *
     * The page fetches its own schema and values once it is up, so nothing is
     * delivered at open time -- sending before the renderer exists would race
     * it, and there is nothing to send that the page cannot fetch.
     *
     * @returns {boolean} always true; the caller uses it as "handled"
     */
    open() {
        const win = this.windowManager.openWindow(WINDOW_NAME, WINDOW_OPTIONS);
        // Guarded on the window rather than a module flag: the registry returns
        // the same instance for a second call, and reloading would discard the
        // category the user is looking at.
        if (!win.__settingsLoading) {
            win.__settingsLoading = true;
            win.loadFile(this.page);
        }
        return true;
    }
}

module.exports = { SettingsWindowService, WINDOW_NAME, WINDOW_OPTIONS };
