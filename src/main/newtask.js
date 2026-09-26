/**
 * The new-task dialog.
 *
 * The original implements this as a native window (`ThunderNewTask`, four
 * exported members, ARCHITECTURE.md:117-124) plus two renderers. Its own
 * comment calls the native half "a window, not business logic", which is the
 * split kept here: this file owns the window's life, and every download action
 * goes back through a server function so nothing in it holds the kernel.
 *
 * It is deliberately free of `electron`. The window is created through the
 * shared registry and the dialogs are injected, so this module can be
 * exercised without an Electron process -- and so that "which file knows about
 * Electron" stays a single answer.
 *
 * The prefill is delivered as an event rather than as a page query because the
 * window is created before its renderer exists. Sending at open time would
 * reach a page that is not there yet; waiting for `did-finish-load` is the
 * only moment the destination is real.
 */

"use strict";

const path = require("path");

const { NATIVE_EVENTS } = require("./contract");

/** Window name in the shared registry. */
const WINDOW_NAME = "new-task";

/**
 * 560 x 620, not resizable, no frame.
 *
 * The original's dialog size is not recorded in the recovered material, so
 * this is a chosen size rather than a measured one: wide enough for a torrent
 * file list with a name, a size and a progress bar, tall enough for six lines
 * of links above it. Not resizable because the layout is fixed rows and the
 * only elastic part is the file list.
 *
 * `frame: false` because the page draws its own title bar -- the original's
 * dialog is a custom-drawn native window, and a dialog with both an OS title
 * bar and an in-page one would show the title twice. The page's close button
 * reaches the window through the `window:close` channel.
 */
const WINDOW_OPTIONS = Object.freeze({
    width: 560,
    height: 620,
    resizable: false,
    frame: false,
    title: "新建任务",
});

class NewTaskService {
    /**
     * @param {object} options
     * @param {object} options.windowManager          the shared registry
     * @param {function} [options.defaultDir]         -> the directory to offer
     * @param {function} [options.pickDirectory]      -> kind -> path, "" on cancel
     * @param {function} [options.log]
     * @param {string} [options.page]                 the page to load
     */
    constructor(options) {
        const opts = options || {};
        this.windowManager = opts.windowManager;
        this.defaultDir = opts.defaultDir || (() => "");
        this.pickDirectory = opts.pickDirectory || (async () => "");
        this.log = opts.log || (() => {});
        this.page = opts.page || path.join(__dirname, "..", "windows", "new-task", "index.html");
    }

    /**
     * Open the dialog, or focus the one already open and hand it the link.
     *
     * @param {object} [prefill] `{ url, torrentPath }` -- what the caller
     *                           already knows, so the user does not paste
     *                           twice.
     * @returns {boolean} always true; the caller uses it as "handled"
     */
    open(prefill) {
        const payload = Object.assign(
            {
                // The directory travels with the prefill because the window
                // needs it at first paint, and a second round trip for one
                // string would leave the field empty for a visible moment.
                dir: this.defaultDir(),
                startNow: true,
            },
            prefill || {}
        );

        const win = this.windowManager.openWindow(WINDOW_NAME, WINDOW_OPTIONS);

        if (win.__newTaskReady) {
            this._deliver(win, payload);
            return true;
        }

        const firstLoad = !win.__newTaskLoading;
        if (firstLoad) {
            win.__newTaskLoading = true;
            win.webContents.once("did-finish-load", () => {
                win.__newTaskReady = true;
            });
        }
        // Attached before the load is asked for. A cached page can finish
        // synchronously, and a listener added afterwards would miss it -- the
        // window would open with an empty link box and no error anywhere.
        win.webContents.once("did-finish-load", () => this._deliver(win, payload));
        if (firstLoad) win.loadFile(this.page);
        return true;
    }

    /**
     * Ask the user for a path.
     *
     * The dialog itself is injected: it is the one part of this that needs
     * `electron`, and keeping it out means this file can be loaded and driven
     * by the test suite. `kind` selects a torrent file rather than a folder.
     *
     * @param {string} [kind] "dir" (default) or "torrent"
     * @returns {Promise<string>} the chosen path, or "" when cancelled
     */
    async choosePath(kind) {
        return this.pickDirectory(kind === "torrent" ? "torrent" : "dir");
    }

    /** Send the prefill to the dialog that is about to show it. */
    _deliver(win, payload) {
        if (!win || win.isDestroyed()) return;
        // Addressed to this window rather than broadcast: the task list has no
        // use for a link that is still being edited.
        win.webContents.send("native-event", {
            name: NATIVE_EVENTS.ON_NEW_TASK_PREFILL,
            payload,
        });
    }
}

module.exports = { NewTaskService, WINDOW_NAME, WINDOW_OPTIONS };
