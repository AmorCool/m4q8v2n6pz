/**
 * The address-bar search dropdown.
 *
 * The original creates this as a separate borderless window managed by the main
 * process's `SearchWindows` (`main.js:5515-5595`, quoted in
 * SETTINGS_SEARCH_NOTIFY_SPEC.md section 2.3(1)): 460x246, no frame, not
 * resizable, positioned under the address bar in the main window's client area,
 * closed when either window loses focus.
 *
 * This file owns the window's life and the positioning; the searching itself
 * is done by the page (`src/windows/search/index.js`) through the `SearchTask`
 * and `SearchPanTask` server functions. That split is the same one the pan
 * window uses, and it keeps the drive session material in the main process.
 *
 * The one non-obvious choice is `focusable: false`. The original's address bar
 * lives in the main renderer and keeps the keyboard while the dropdown is up,
 * which is only possible if the dropdown never activates. With a focusable
 * panel, the first character typed over it would go to the panel instead of the
 * input, and the search would stop after one key.
 *
 * No `electron` here: the window comes from the shared registry and the main
 * window from the same registry, so this module loads under plain node.
 */

"use strict";

const path = require("path");

const { NATIVE_EVENTS } = require("./contract");

/** Window name in the shared registry. */
const WINDOW_NAME = "search";

/**
 * Size and frame from the spec's table (section 2.4): 460x246, borderless,
 * not resizable, white background (the original sets `backgroundColor: "#FFF"`).
 */
const WINDOW_OPTIONS = Object.freeze({
    width: 460,
    height: 246,
    resizable: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    inactive: true,
    title: "搜索栏",
    backgroundColor: "#ffffff",
});

class SearchWindowService {
    /**
     * @param {object} options
     * @param {object} options.windowManager  the shared registry
     * @param {function} [options.log]
     * @param {string} [options.page]
     */
    constructor(options) {
        const opts = options || {};
        this.windowManager = opts.windowManager;
        this.log = opts.log || (() => {});
        this.page = opts.page || path.join(__dirname, "..", "windows", "search", "index.html");

        /** The address bar's rect in the page, for positioning. */
        this.anchor = null;
        /** A message that arrived before the page was ready. */
        this.pending = null;
        this._wiredMain = false;
    }

    /** Whether the dropdown is open. */
    isOpen() {
        return !!this.windowManager.getWindow(WINDOW_NAME);
    }

    /**
     * Open the dropdown, or return the live one.
     *
     * The page is loaded once per window; a reused window keeps its results,
     * which is what makes a second keystroke cheap.
     */
    open() {
        const main = this._mainWindow();
        const win = this.windowManager.openWindow(
            WINDOW_NAME,
            Object.assign({}, WINDOW_OPTIONS, { parent: main || undefined })
        );

        if (!win.__searchLoading) {
            win.__searchLoading = true;
            win.webContents.once("did-finish-load", () => {
                win.__searchReady = true;
                if (this.pending) {
                    const queued = this.pending;
                    this.pending = null;
                    this._send(win, queued.name, queued.payload);
                }
            });
            win.loadFile(this.page);
        }

        this._wireMainWindow();
        return win;
    }

    /**
     * Move the dropdown under the address bar.
     *
     * `anchor` is the input's rect in the page's own coordinates; the window
     * position is the main window's CONTENT origin plus that rect. Using the
     * content bounds rather than the frame bounds is what makes the panel land
     * under the input instead of one title bar too high.
     */
    position(anchor) {
        if (anchor) this.anchor = anchor;
        const win = this.windowManager.getWindow(WINDOW_NAME);
        const main = this._mainWindow();
        if (!win || !main || !this.anchor) return false;

        const bounds = typeof main.getContentBounds === "function"
            ? main.getContentBounds()
            : typeof main.getBounds === "function" ? main.getBounds() : null;
        if (!bounds) return false;

        const x = Math.round(bounds.x + (Number(this.anchor.left) || 0));
        const y = Math.round(bounds.y + (Number(this.anchor.top) || 0));
        if (typeof win.setPosition === "function") {
            win.setPosition(x, y);
        } else if (typeof win.setBounds === "function") {
            win.setBounds({ x, y, width: WINDOW_OPTIONS.width, height: WINDOW_OPTIONS.height });
        }
        return true;
    }

    /**
     * The address bar changed.
     *
     * An empty keyword closes the panel; anything else opens it, positions it
     * and hands the keyword to the page. The page does the searching, so the
     * keystroke path stays one message wide.
     *
     * @returns {boolean} always true; the caller uses it as "handled"
     */
    input(keyword, anchor) {
        const text = String(keyword === undefined || keyword === null ? "" : keyword).trim();
        if (!text) {
            this.close();
            return true;
        }

        const win = this.open();
        this.position(anchor);
        if (typeof win.isVisible === "function" && !win.isVisible()) {
            if (typeof win.showInactive === "function") win.showInactive();
            else if (typeof win.show === "function") win.show();
        }
        this._send(win, NATIVE_EVENTS.ON_SEARCH_QUERY, { keyword: text });
        return true;
    }

    /** Forward a key from the address bar (ArrowUp / ArrowDown / Enter). */
    key(key) {
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (!win) return true;
        this._send(win, NATIVE_EVENTS.ON_SEARCH_KEY, { key: String(key || "") });
        return true;
    }

    /**
     * A result was picked in the panel.
     *
     * The panel cannot act on the main window, so the item travels to the main
     * renderer as a commit event, which is the one place that turns a pick into
     * an action (select the row, or take the cloud file back to local).
     */
    pick(item) {
        this.commit(item);
        this.close();
        return true;
    }

    /** Send a picked item to the main window. */
    commit(item) {
        const main = this._mainWindow();
        if (!main || main.isDestroyed()) return false;
        main.webContents.send("native-event", {
            name: NATIVE_EVENTS.ON_SEARCH_COMMIT,
            payload: item || null,
        });
        return true;
    }

    /** Close the dropdown. */
    close() {
        this.pending = null;
        this.windowManager.close(WINDOW_NAME);
        return true;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    _mainWindow() {
        return this.windowManager.getWindow("main");
    }

    /**
     * Follow the main window.
     *
     * A panel pinned to a window that has moved is worse than no panel, so it
     * is repositioned on `move`/`resize`. `blur` closes it, which is the
     * original's behaviour (main window blur -> close after 50 ms) and also the
     * only reliable close: the panel cannot see the input lose focus.
     */
    _wireMainWindow() {
        if (this._wiredMain) return;
        const main = this._mainWindow();
        if (!main || typeof main.on !== "function") return;
        this._wiredMain = true;

        main.on("move", () => {
            if (this.isOpen()) this.position(null);
        });
        main.on("resize", () => {
            if (this.isOpen()) this.position(null);
        });
        main.on("blur", () => this.close());
    }

    _send(win, name, payload) {
        if (!win || win.isDestroyed()) return;
        if (!win.__searchReady) {
            // The page is not up yet; the last message wins, which is what a
            // fast typist needs (only the current keyword matters).
            this.pending = { name, payload };
            return;
        }
        win.webContents.send("native-event", { name, payload });
    }
}

module.exports = { SearchWindowService, WINDOW_NAME, WINDOW_OPTIONS };
