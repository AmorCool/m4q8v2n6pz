/**
 * Toast notification manager.
 *
 * Port of the original's `ToastNotifyManager` + `ToastNotifyItemType`
 * (`main-renderer/renderer.js:10676-10994`). The original's component lives in
 * the main renderer's Vue tree and draws `.xly-down-bar`
 * (renderer.js:45508-45542, CSS in `main-renderer/renderer.css`).
 *
 * The manager and the drawing are split on purpose: everything that decides
 * WHAT is on screen -- the 13 ids, the four types, the one-at-a-time rule, the
 * auto-close timer and its hover pause -- is in this file and needs no DOM, so
 * it can be asserted directly. The view adapter (supplied by the page) only
 * paints an item and clears it. That is also what keeps this file loadable
 * under plain node for the test suite.
 *
 * Faithful details worth naming:
 *   - `getTopNotify` returns the STACK TOP, and the component shows only that.
 *     A new notification is pushed and immediately replaces what is on screen;
 *     the previous one stays queued below rather than being thrown away, which
 *     is how the original's `notifyList` behaves.
 *   - the default duration is 3000 ms; the scheduled-task notice uses 5000
 *     (renderer.js:10930 and the `notifyIdScheduleTaskComplete` row).
 *   - moving the mouse over the bar clears the timer and moving out restarts it
 *     (renderer.js:28005-28079). The remainder is kept here rather than the
 *     full duration, which is the same thing observed from the outside unless
 *     a user hovers repeatedly.
 *
 * Dual-mode, like `msg-queue.js`: the renderer reads `window.ToastNotify`, the
 * test suite `require`s it. The IIFE keeps this file's names out of the global
 * scope the three notification scripts share -- see the note in `msg-queue.js`.
 */

"use strict";

(function (root) {
    /** The four item kinds (renderer.js:10676). */
    const ToastNotifyItemType = Object.freeze({
        GreenNotify: 0,
        RedNotify: 1,
        RedCancelNotify: 2,
        Custom: 3,
    });

    /**
     * The 13 notify ids, verbatim (renderer.js:10922). They are strings because
     * they travel through events and are compared by value.
     */
    const NOTIFY_IDS = Object.freeze({
        notifyIdAutoDeleteNonExistTasks: "auto_delete_nonexsit_tasks",
        notifyIdScheduleTaskComplete: "schedule_task_complete",
        notifyIdTaskOperatorDestroyTask: "task_operator_destroy_task",
        notifyIdTaskOperatorCopyLink: "task_operator_copy_link",
        notifyIdTaskOperatorCopyMagnetLink: "task_operator_copy_magnet_link",
        notifyIdTaskOperatorSaveAsTorrent: "task_operator_save_as_torrent",
        notifyIdTaskOperatorRecoverTask: "task_operator_recover_task",
        notifyIdScheduleTaskDownloadMode: "schedule_task_download_mode",
        notifyIdTaskOperatorMoveTask: "task_operator_move_task",
        notifyIdTaskDispatchSmallFileAdvanced: "task_dispatch_small_file_advanced",
        notifyIdGetCoinPrize: "get_coin_prize",
        notifyIdTaskAdd2Cloud: "task_add_to_cloud_notify",
        notifyIdImportUnfinishedFail: "import_unfinished_fail",
    });

    const DEFAULT_DURATION_MS = 3000;
    /** 计划任务完成 uses 5000 in the original (spec section 3.3(1)). */
    const SCHEDULE_TASK_DURATION_MS = 5000;

    /** Coerce a caller's duration; a missing or non-positive one means the default. */
    function normalizeDuration(value) {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_DURATION_MS;
    }

    class ToastNotifyManager {
        /**
         * @param {object} [options]
         * @param {object} [options.view]  `{ show(item), hide() }`; optional
         * @param {function} [options.log]
         */
        constructor(options) {
            const opts = options || {};
            this.view = opts.view || null;
            this.log = opts.log || (() => {});

            /** Stack of items; the last one is the one on screen. */
            this.notifyList = [];

            this._timer = null;
            this._startedAt = 0;
            this._remaining = 0;
            this._shownId = null;
        }

        // -------------------------------------------------------------------
        // Raising
        // -------------------------------------------------------------------

        /**
         * Show a toast.
         *
         * @param {string} id        one of NOTIFY_IDS (or any string)
         * @param {number} type      ToastNotifyItemType
         * @param {string} message
         * @param {number} [duration] ms; default 3000
         * @param {object} [component] payload for a Custom item
         */
        showNotify(id, type, message, duration, component) {
            return this._push({
                id: id || "",
                type: Number(type) || ToastNotifyItemType.GreenNotify,
                message: String(message === undefined ? "" : message),
                duration: normalizeDuration(duration),
                component: component || null,
                cancel: false,
                viewOptions: null,
            });
        }

        /**
         * Show a toast that carries a "查看/取消" button.
         *
         * `viewOptions` is `{ viewVisible, viewText, onView, onClose }` in the
         * original; it is stored as given, and the view adapter decides what to
         * draw. A RedCancel item is the original's way of offering the cancel.
         */
        showNotifyEx(id, type, message, duration, viewOptions, component) {
            const options = viewOptions || {};
            return this._push({
                id: id || "",
                type: Number(type) || ToastNotifyItemType.GreenNotify,
                message: String(message === undefined ? "" : message),
                duration: normalizeDuration(duration),
                component: component || null,
                cancel: true,
                viewOptions: {
                    viewVisible: options.viewVisible !== false,
                    viewText: options.viewText || "查看",
                    onView: options.onView || null,
                    onClose: options.onClose || null,
                },
            });
        }

        /** Replace the message and/or duration of an item already on screen. */
        updateNotify(id, message, duration) {
            const item = this._find(id);
            if (!item) return null;
            if (message !== undefined && message !== null) item.message = String(message);
            if (duration !== undefined && duration !== null) item.duration = normalizeDuration(duration);
            if (this.getTopNotify() === item) this._present();
            return item;
        }

        /**
         * Close an item.
         *
         * With no id the top of the stack is closed, which is what the bar's own
         * ✕ does. The next item, if any, takes its place.
         */
        closeNotify(id) {
            if (this.notifyList.length === 0) return null;
            const index = id === undefined || id === null || id === ""
                ? this.notifyList.length - 1
                : this.notifyList.findIndex((item) => item.id === id);
            if (index < 0) return null;

            const removed = this.notifyList[index];
            // A close on a queued (not shown) item must not disturb the timer of
            // whatever is on screen, so the repaint is conditional on identity.
            const wasShown = this._shownIdItem() === removed;
            this.notifyList.splice(index, 1);
            if (wasShown) this._present();
            return removed;
        }

        /** The item the component is drawing, or null. */
        getTopNotify() {
            return this.notifyList.length ? this.notifyList[this.notifyList.length - 1] : null;
        }

        /** Whether anything is on screen. */
        get isShowing() {
            return this.getTopNotify() !== null;
        }

        // -------------------------------------------------------------------
        // Timer (hover pause / resume)
        // -------------------------------------------------------------------

        /** Freeze the auto-close countdown; called when the pointer enters the bar. */
        pause() {
            if (!this._timer) return;
            clearTimeout(this._timer);
            this._timer = null;
            this._remaining = Math.max(0, this._remaining - (Date.now() - this._startedAt));
        }

        /** Restart the countdown from what was left. */
        resume() {
            const top = this.getTopNotify();
            if (!top || this._timer) return;
            this._startTimer(top, this._remaining || top.duration);
        }

        /** Stop the timer and forget every queued item (shutdown). */
        dispose() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this.notifyList = [];
            this._shownId = null;
            this._clearView();
        }

        // -------------------------------------------------------------------
        // Internals
        // -------------------------------------------------------------------

        _find(id) {
            return this.notifyList.find((item) => item.id === id) || null;
        }

        /** The item object behind `_shownId`, used for identity checks. */
        _shownIdItem() {
            return this.notifyList.find((item) => item.id === this._shownId) || null;
        }

        _push(item) {
            // Same id updates in place rather than stacking: a progress-style
            // notice that fires repeatedly would otherwise fill the stack.
            const existing = this._find(item.id);
            if (existing) {
                Object.assign(existing, item);
                this._present();
                return existing;
            }
            this.notifyList.push(item);
            this._present();
            return item;
        }

        /** Paint the stack top, or hide the bar when there is none. */
        _present() {
            const top = this.getTopNotify();
            if (!top) {
                this._clear();
                return;
            }
            this._shownId = top.id;
            if (this.view && typeof this.view.show === "function") this.view.show(top);
            this._startTimer(top, top.duration);
        }

        _startTimer(item, duration) {
            if (this._timer) clearTimeout(this._timer);
            this._remaining = normalizeDuration(duration);
            this._startedAt = Date.now();
            this._timer = setTimeout(() => {
                this._timer = null;
                this.closeNotify(item.id);
            }, this._remaining);
            if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
        }

        _clear() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
            this._shownId = null;
            this._remaining = 0;
            this._clearView();
        }

        _clearView() {
            if (this.view && typeof this.view.hide === "function") this.view.hide();
        }
    }

    const api = {
        ToastNotifyManager,
        ToastNotifyItemType,
        NOTIFY_IDS,
        DEFAULT_DURATION_MS,
        SCHEDULE_TASK_DURATION_MS,
        normalizeDuration,
    };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.ToastNotify = api;
})(typeof window !== "undefined" ? window : null);
