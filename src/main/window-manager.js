/**
 * Window registry.
 *
 * The original opens a window per feature -- the main list, the new-task
 * dialog, the suspension ball, the login card -- and each one is created by
 * its own native module. This rebuild has one place that creates them
 * instead, for two reasons that are not stylistic:
 *
 *   1. The window settings that matter for safety are the same everywhere
 *      (`contextIsolation: true`, `nodeIntegration: false`, the shared
 *      preload). A window that spelled those out itself could get one wrong,
 *      and the mistake would only show up as a renderer that can reach node.
 *
 *   2. Kernel events used to be delivered to a single captured `win`, so a
 *      second window received nothing. `broadcast` is the fix, and it only
 *      works if every window is in one table.
 *
 * The table is keyed by name rather than held as a list because every caller
 * wants "the new-task window", not "window number three". Opening a name that
 * already exists focuses it and returns the same instance, which is what makes
 * a second click on "新建" behave like a user expects instead of stacking
 * identical dialogs.
 *
 * `createBrowserWindow` is injected rather than imported so that this file
 * stays loadable under plain node: `electron` only resolves inside an Electron
 * process, and the test suite runs without one. The default factory requires
 * it lazily, so the import happens at the one moment it is valid.
 */

"use strict";

const path = require("path");

/** Same value the main window uses; a flash of white on open reads as a bug. */
const BACKGROUND_COLOR = "#1b1b1f";

/**
 * The preload bridge every window shares.
 *
 * Resolved from this file rather than from a caller so that a window opened
 * from anywhere -- a plugin, a service, the main process -- gets the same
 * `window.thunderx` surface. A window without it would be a page that cannot
 * reach the application at all.
 */
const PRELOAD = path.join(__dirname, "..", "preload", "index.js");

class WindowManager {
    /**
     * @param {object} [options]
     * @param {function} [options.createBrowserWindow] factory for BrowserWindow
     */
    constructor(options) {
        const opts = options || {};
        /** name -> BrowserWindow */
        this.windows = new Map();
        this.createBrowserWindow = opts.createBrowserWindow || ((windowOptions) => {
            const { BrowserWindow } = require("electron");
            return new BrowserWindow(windowOptions);
        });
    }

    /**
     * Create a window, or return the live one already under that name.
     *
     * @param {string} name
     * @param {object} options
     * @param {number} [options.width]
     * @param {number} [options.height]
     * @param {number} [options.minWidth]
     * @param {number} [options.minHeight]
     * @param {boolean} [options.frame]         false for a chrome-less popup
     * @param {boolean} [options.resizable]
     * @param {boolean} [options.transparent]
     * @param {boolean} [options.alwaysOnTop]
     * @param {boolean} [options.skipTaskbar]
     * @param {boolean} [options.focusable]     false for a panel that must not
     *                                          steal the keyboard from the
     *                                          window it hangs off
     * @param {object}  [options.parent]        the BrowserWindow to hang off
     * @param {string}  [options.title]
     * @param {boolean} [options.inactive]      show without activating; the
     *                                          default for a non-focusable panel
     * @param {boolean} [options.autoShow]      show on ready-to-show; default true
     * @param {object}  [options.webPreferences] merged over the safe defaults
     * @returns {object} the window
     */
    openWindow(name, options) {
        const existing = this.windows.get(name);
        if (existing && !existing.isDestroyed()) {
            // Focusing rather than creating is deliberate: the new-task dialog
            // holds what the user has typed, and a second dialog would discard
            // it without asking.
            if (existing.isMinimized()) existing.restore();
            existing.focus();
            return existing;
        }

        const opts = options || {};
        const win = this.createBrowserWindow({
            width: opts.width,
            height: opts.height,
            minWidth: opts.minWidth,
            minHeight: opts.minHeight,
            title: opts.title,
            // `show: false` plus a ready-to-show handler is how the flash of
            // an unpainted page is avoided; the alternative is a white frame
            // that appears before the dark stylesheet is applied.
            show: false,
            backgroundColor: opts.backgroundColor || BACKGROUND_COLOR,
            frame: opts.frame === undefined ? true : opts.frame,
            resizable: opts.resizable === undefined ? true : opts.resizable,
            transparent: !!opts.transparent,
            alwaysOnTop: !!opts.alwaysOnTop,
            skipTaskbar: !!opts.skipTaskbar,
            // A panel that hangs off another window (the search dropdown) is
            // `focusable: false`: it must receive clicks without taking the
            // keyboard, or typing in the address bar would stop after the
            // first character the user types over the panel.
            focusable: opts.focusable === undefined ? true : !!opts.focusable,
            // `parent` is a live BrowserWindow, so it is passed through only
            // when given -- `parent: undefined` is a different call than a
            // missing key for Electron.
            ...(opts.parent ? { parent: opts.parent } : {}),
            webPreferences: Object.assign(
                {
                    preload: PRELOAD,
                    // A renderer that could reach node would have the same
                    // reach as the main process, which defeats the isolation.
                    contextIsolation: true,
                    nodeIntegration: false,
                },
                opts.webPreferences || {}
            ),
        });

        this.windows.set(name, win);
        win.once("closed", () => {
            // Guarded by identity: a window that was replaced under the same
            // name must not delete its successor's entry.
            if (this.windows.get(name) === win) this.windows.delete(name);
        });

        if (opts.autoShow !== false) {
            win.once("ready-to-show", () => {
                if (win.isDestroyed()) return;
                // `showInactive` for a panel: `show()` would activate it and
                // pull the keyboard out of the address bar.
                if (opts.inactive && typeof win.showInactive === "function") win.showInactive();
                else win.show();
            });
        }

        return win;
    }

    /** The window under a name, or null. */
    getWindow(name) {
        const win = this.windows.get(name);
        return win && !win.isDestroyed() ? win : null;
    }

    /**
     * Send a channel to every live window.
     *
     * This is the point of the registry: a kernel event belongs to whoever is
     * showing the kernel's state, and that is more than one window. A window
     * that is mid-close is skipped rather than guarded against at each call
     * site -- `send` on a destroyed webContents throws.
     */
    broadcast(channel, payload) {
        for (const win of this.windows.values()) {
            if (win.isDestroyed()) continue;
            win.webContents.send(channel, payload);
        }
    }

    /** Close one window, if it is open. */
    close(name) {
        const win = this.getWindow(name);
        if (win) win.close();
    }

    /** Close everything. The registry is emptied by the `closed` handlers. */
    closeAll() {
        for (const win of Array.from(this.windows.values())) {
            if (!win.isDestroyed()) win.close();
        }
    }

    /** Names of the windows currently open. */
    list() {
        const names = [];
        for (const [name, win] of this.windows) {
            if (!win.isDestroyed()) names.push(name);
        }
        return names;
    }
}

module.exports = { WindowManager, PRELOAD, BACKGROUND_COLOR };
