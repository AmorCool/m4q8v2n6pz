/**
 * Priority message queue.
 *
 * Port of the original's `msg-queue` module (`main-renderer/renderer.js:13501-13545`).
 * Its job is to serialise messages that come from unrelated sources -- the
 * community feed, two kinds of advertising, precise delivery, the VIP centre,
 * and downloads -- so two popups cannot appear at the same time. Downloads
 * have the highest priority, which is why they are dequeued first.
 *
 * The ordering rule is the one part that is easy to get backwards, so it is
 * spelled out here: `enQueue` inserts in DESCENDING priority order, which
 * leaves the LOWEST priority at the head and the HIGHEST at the tail;
 * `deQueue` pops from the TAIL. A queue that popped from the head would
 * deliver advertisements before download notices. Messages of equal priority
 * keep their arrival order in the array, so the last one enqueued at a given
 * priority is the first one out -- the same as the original's splice.
 *
 * Dual-mode on purpose (the same trick `settings-schema.js` uses): the main
 * process and the test suite `require` it, the renderer loads it as a plain
 * script and reads `window.MsgQueue`. Neither side keeps a copy.
 *
 * The body is wrapped in one IIFE because this file and its two siblings
 * (`pop-mutual.js`, `toast.js`) are all loaded as CLASSIC scripts into the
 * same global scope. A top-level `const api` in each of them is a
 * redeclaration, and the second file's would throw a SyntaxError that takes
 * the whole page down -- which is exactly what happened before the wrapper was
 * added. A function scope keeps the three from seeing each other at all.
 */

"use strict";

(function (root) {
    /**
     * The six priorities, verbatim from the original
     * (`MsgPriority: Community=0, AdvertisementMarket=1, AdvertisementFunctional=2,
     * PreciseDelivery=3, CenterVip=4, Download=5`).
     * Higher number = more important.
     */
    const MSG_PRIORITY = Object.freeze({
        Community: 0,
        AdvertisementMarket: 1,
        AdvertisementFunctional: 2,
        PreciseDelivery: 3,
        CenterVip: 4,
        Download: 5,
    });

    class MsgQueue {
        constructor() {
            /** Ascending by priority: index 0 is the least important. */
            this.queue = [];
        }

        /**
         * Insert one message, keeping the queue ascending by priority.
         *
         * @param {object} msg  `{ name, priority, callback, ... }`
         * @returns {MsgQueue} this, so calls can be chained
         */
        enQueue(msg) {
            const item = msg || {};
            const priority = Number(item.priority) || 0;
            // Insert before the first entry that outranks it; equal priorities
            // keep arrival order (a stable queue), which is what the original's
            // array splice produces.
            let at = this.queue.length;
            for (let i = 0; i < this.queue.length; i += 1) {
                if (this.queue[i].priority > priority) {
                    at = i;
                    break;
                }
            }
            this.queue.splice(at, 0, Object.assign({}, item, { priority }));
            return this;
        }

        /**
         * Take the highest-priority message and run its callback.
         *
         * @returns {object|null} the message that was run, or null when empty
         */
        deQueue() {
            const item = this.queue.pop();
            if (!item) return null;
            if (typeof item.callback === "function") item.callback(item);
            return item;
        }

        /** Drop every queued message whose `name` matches. */
        clearQueuesByName(name) {
            this.queue = this.queue.filter((item) => item.name !== name);
            return this;
        }

        /** Drop everything. */
        clear() {
            this.queue = [];
            return this;
        }

        isEmpty() {
            return this.queue.length === 0;
        }

        /**
         * The message `deQueue` would take next, without removing it.
         *
         * The original's `getCurrentProperty` answers "what is on screen now";
         * with a queue and no in-flight message, the tail is that answer.
         */
        getCurrentProperty() {
            return this.queue.length ? this.queue[this.queue.length - 1] : null;
        }

        /** Queue length, for the panel's own diagnostics. */
        get length() {
            return this.queue.length;
        }
    }

    const api = { MsgQueue, MSG_PRIORITY };

    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.MsgQueue = api;
})(typeof window !== "undefined" ? window : null);
