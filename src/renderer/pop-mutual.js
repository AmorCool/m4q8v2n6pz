/**
 * Popup mutual-exclusion scheduler.
 *
 * Port of the original's `pop-mutual` module (`main-renderer/renderer.js:21679-21800+`).
 * It is a second, independent mechanism from `msg-queue` and the two are easy
 * to confuse:
 *
 *   msg-queue  -- notification-class messages (community / ads / VIP / download)
 *   pop-mutual -- DIALOG-class popups (new task, login, sign-in, VIP guide)
 *
 * They are not interchangeable and the spec calls that out explicitly
 * (SETTINGS_SEARCH_NOTIFY_SPEC.md section 3.6 point 3), so this file implements
 * only the dialog scheduler.
 *
 * The original's shape:
 *   - a priority table mapping each `PopView` to a number (0 = most important)
 *   - four levels, `P0`..`P3` plus `UnKnown`, derived from that number
 *   - per-level pop limits `{ P1: 2, P2: 1, P3: 1 }`; `P0` is unlimited
 *   - a waiting queue, so a popup that cannot show yet is not dropped
 *   - `s = 3000` ms, the delay before the next popup is considered
 *
 * Dual-mode, like `msg-queue.js`: the renderer reads `window.PopMutual`, the
 * test suite `require`s it. The IIFE keeps this file's names out of the global
 * scope the three notification scripts share -- see the note in `msg-queue.js`.
 */

"use strict";

(function (root) {
    /** `s` in the original: the gap between two popups. */
    const POP_DELAY_MS = 3000;

    /**
     * `PopView` -> priority. Verbatim from the original's `d` table.
     * A lower number is more important.
     */
    const POP_VIEW_PRIORITY = Object.freeze({
        PRE_NEW_TASK: 0,
        BT_NEW_TASK: 0,
        NEW_TASK: 0,
        LOGIN: 1,
        BROWSER_GUIDE: 1,
        THUNDER_PAN_IMPORT: 1,
        SIGN: 2,
        VIP_RENEW: 3,
        LOGIN_NONE_VIP_ACTIVITY: 3,
        VIP_GUIDE: 10,
        KUAINIAO_AUTO: 10,
    });

    /** Per-level auto-pop ceilings. `P0` is absent, i.e. unlimited. */
    const POP_LIMITS = Object.freeze({ P1: 2, P2: 1, P3: 1 });

    /** Priority number -> level name. */
    function levelOf(priority) {
        switch (priority) {
            case 0: return "P0";
            case 1: return "P1";
            case 2: return "P2";
            case 3: return "P3";
            default: return "UnKnown";
        }
    }

    class PopMutual {
        /**
         * @param {object} [options]
         * @param {function} [options.log]
         * @param {number}   [options.delayMs] gap between popups; default 3000
         */
        constructor(options) {
            const opts = options || {};
            this.log = opts.log || (() => {});
            this.delayMs = opts.delayMs === undefined ? POP_DELAY_MS : opts.delayMs;

            /** The popup currently on screen, or null. */
            this.current = null;
            /** view -> how many times it has been auto-popped, per level. */
            this.eachPopCount = { P0: 0, P1: 0, P2: 0, P3: 0, UnKnown: 0 };
            /** `{ view, callback, from }`, most important first when popped. */
            this.waiting = [];
            this._timer = null;
        }

        /** The priority number for a view; an unknown view is least important. */
        priorityOf(view) {
            const value = POP_VIEW_PRIORITY[view];
            return value === undefined ? 10 : value;
        }

        /** The level name for a view. */
        levelFor(view) {
            return levelOf(this.priorityOf(view));
        }

        /**
         * Whether a view may pop right now.
         *
         * Two conditions, both required: nothing else is on screen (mutual
         * exclusion), and the view's level has not hit its ceiling.
         */
        canAutoPopNow(view) {
            if (this.current) return false;
            const level = this.levelFor(view);
            const limit = POP_LIMITS[level];
            if (limit === undefined) return true;
            return this.eachPopCount[level] < limit;
        }

        /**
         * Show a view now, and count it against its level.
         *
         * The callback is the caller's "draw it" routine; this module only
         * decides order and timing.
         */
        popNow(view, callback) {
            this.current = view;
            const level = this.levelFor(view);
            this.eachPopCount[level] = (this.eachPopCount[level] || 0) + 1;
            if (typeof callback === "function") callback();
            return view;
        }

        /**
         * Queue a popup, then try to show something.
         *
         * A view already waiting is not queued twice: a second request for the
         * same dialog would otherwise pop the same window twice.
         */
        enqueue(view, callback, from) {
            if (this.current === view) return this;
            if (!this.waiting.some((entry) => entry.view === view)) {
                this.waiting.push({ view, callback, from: from || "" });
            }
            return this.popNext();
        }

        /**
         * The current popup has finished; let the next one through after the
         * original's 3000 ms gap.
         */
        setFinish(view) {
            if (view !== undefined && view !== null && this.current !== view) return this;
            this.current = null;
            this._scheduleNext();
            return this;
        }

        /**
         * Pick the most important waiting view that is allowed to pop.
         *
         * Ties keep arrival order (the queue is scanned front to back and only
         * a strictly smaller priority replaces the candidate).
         */
        popNext() {
            if (this.current) return this;

            let picked = -1;
            let best = Infinity;
            for (let i = 0; i < this.waiting.length; i += 1) {
                const entry = this.waiting[i];
                const priority = this.priorityOf(entry.view);
                if (priority < best && this.canAutoPopNow(entry.view)) {
                    best = priority;
                    picked = i;
                }
            }
            if (picked < 0) return this;

            const [entry] = this.waiting.splice(picked, 1);
            this.popNow(entry.view, entry.callback);
            return this;
        }

        /** Cancel the pending "next popup" timer (shutdown, and tests). */
        dispose() {
            if (this._timer) {
                clearTimeout(this._timer);
                this._timer = null;
            }
        }

        _scheduleNext() {
            if (this._timer) clearTimeout(this._timer);
            this._timer = setTimeout(() => {
                this._timer = null;
                this.popNext();
            }, this.delayMs);
            // The timer must not be the reason the process stays alive.
            if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
        }
    }

    const api = {
        PopMutual,
        POP_VIEW_PRIORITY,
        POP_LIMITS,
        POP_DELAY_MS,
        levelOf,
    };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.PopMutual = api;
})(typeof window !== "undefined" ? window : null);
