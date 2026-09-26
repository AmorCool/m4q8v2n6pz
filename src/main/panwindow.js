/**
 * The cloud-drive browser window.
 *
 * The original draws this as the `ThunderPanPlugin` page inside a `<webview>`
 * mounted by the main renderer (app.js, page `pages/index.205c532.js`). This
 * rebuild has no webview host for a plugin page, so the same page is served
 * as its own window and reaches the drive through server functions instead of
 * calling the drive API from the page.
 *
 * The split mirrors `newtask.js` on purpose: this file owns the window's life
 * and nothing else. It holds no `electron`, no client and no kernel -- the
 * page fetches its own data over the same transport a plugin uses, so the
 * window can be exercised without an Electron process.
 *
 * Unlike the new-task dialog this one is a real, resizable window. A drive
 * browser is something a user keeps open and drags around; a modal-sized,
 * fixed frame would be the wrong shape for it. That is a choice, not a
 * recovered measurement -- the original's webview size is set by the host
 * layout, which does not exist here.
 */

"use strict";

const path = require("path");

/** Window name in the shared registry. */
const WINDOW_NAME = "pan";

const WINDOW_OPTIONS = Object.freeze({
    width: 920,
    height: 640,
    minWidth: 640,
    minHeight: 420,
    resizable: true,
    title: "云盘",
});

class PanWindowService {
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
        this.page = opts.page || path.join(__dirname, "..", "windows", "pan", "index.html");
    }

    /**
     * Open the drive browser, or focus the one already open.
     *
     * No prefill: the page asks for the root listing itself once it is up.
     * Sending anything at open time would race the renderer, and there is
     * nothing to send that the page cannot fetch.
     *
     * @returns {boolean} always true; the caller uses it as "handled"
     */
    open() {
        const win = this.windowManager.openWindow(WINDOW_NAME, WINDOW_OPTIONS);
        // Guarded by a flag on the window rather than by a module-level one:
        // the registry returns the same instance for a second call, and
        // re-loading a page the user is looking at would throw away the folder
        // they navigated into.
        if (!win.__panLoading) {
            win.__panLoading = true;
            win.loadFile(this.page);
        }
        return true;
    }
}

module.exports = { PanWindowService, WINDOW_NAME, WINDOW_OPTIONS };
