/**
 * System notifications.
 *
 * The original draws its corner popup in a dedicated window
 * (`out/notification-renderer`, title 「提示框」) with five `TipsType` variants
 * (SETTINGS_SEARCH_NOTIFY_SPEC.md section 3.3(3)). This build uses the OS
 * notification instead of a self-drawn window, which is the trade the landing
 * table's 风险 section points at: the five variants' visuals live in a 454 KB
 * stylesheet plus a component tree, and reproducing them would cost more than
 * the feature is worth while a system notification is what a user actually
 * sees on the desktop.
 *
 * The five `TipsType` names are kept so a reader can line this up with the
 * original even though only two of them can be produced here (there is no IM
 * backend for the community tips and no activity feed for the rest).
 *
 * Two rules decide whether anything is shown, and both are the point of this
 * file:
 *   1. only when the main window is NOT focused -- when it is, the renderer
 *      draws the in-app toast instead, and showing both would double up;
 *   2. only when the matching 提醒 setting is on (`ConfigMsg_Finish` /
 *      `ConfigMsg_FailSuggest`, the original's own two switches).
 *
 * `electron` is injected (`createNotification`), so this file loads and is
 * testable under plain node.
 */

"use strict";

const { KERNEL_EVENTS } = require("./contract");

/** The original's `Notification.TipsType` (five variants). */
const TIPS_TYPE = Object.freeze({
    DownloadComplete: "DownloadComplete",
    DownloadFail: "DownloadFail",
    ConsumptionTips: "ConsumptionTips",
    CommunityTips: "CommunityTips",
    CommonPushTip: "CommonPushTip",
});

/** Titles taken from the notification window's own strings (spec 3.3(3)). */
const TITLE = Object.freeze({
    [TIPS_TYPE.DownloadComplete]: "迅雷 - 下载完成",
    [TIPS_TYPE.DownloadFail]: "迅雷 - 下载出错",
});

class NotificationService {
    /**
     * @param {object} options
     * @param {function} [options.createNotification] `{title, body}` -> notifier
     * @param {function} [options.getConfig]          (section, key, fallback)
     * @param {function} [options.isWindowFocused]    -> boolean
     * @param {function} [options.log]
     */
    constructor(options) {
        const opts = options || {};
        this.createNotification = opts.createNotification || (() => null);
        this.getConfig = opts.getConfig || (() => true);
        this.isWindowFocused = opts.isWindowFocused || (() => true);
        this.log = opts.log || (() => {});

        /*
         * The last status seen per task.
         *
         * A failed task keeps reporting status 4 while it sits in the list, and
         * without this the user would get a fresh "下载出错" every time the
         * engine repeated itself. Only the transition into 4 counts.
         */
        this._lastStatus = new Map();
    }

    /** Show one system notification. @returns {object|null} */
    notify(options) {
        const o = options || {};
        const title = o.title || TITLE[o.type] || "迅雷";
        const body = String(o.body || "");
        if (!title && !body) return null;
        const notifier = this.createNotification({ title, body, type: o.type || "" });
        if (notifier && typeof notifier.show === "function") {
            notifier.show();
        } else {
            // No `electron.Notification` (headless, or an unsupported platform)
            // is not a failure worth throwing over; the toast still happened.
            this.log("system notification unavailable:", title, body);
        }
        return notifier || null;
    }

    /**
     * React to one kernel event.
     *
     * @param {string} name  a `KERNEL_EVENTS` value
     * @param {object} task  the event payload (a task record)
     * @returns {object|null} the notification shown, if any
     */
    onKernelEvent(name, task) {
        const t = task || {};
        const taskId = t.taskId || "";

        if (name === KERNEL_EVENTS.TASK_REMOVED) {
            this._lastStatus.delete(taskId);
            return null;
        }

        // Remember the status even while focused, so that the first event seen
        // after the window loses focus is not misread as a transition.
        const previous = this._lastStatus.get(taskId);
        if (taskId) this._lastStatus.set(taskId, Number(t.status));

        if (this.isWindowFocused()) return null;

        if (name === KERNEL_EVENTS.TASK_COMPLETED) {
            if (!this._enabled("ConfigMsg_Finish")) return null;
            return this.notify({
                type: TIPS_TYPE.DownloadComplete,
                title: TITLE[TIPS_TYPE.DownloadComplete],
                body: t.name || t.url || taskId,
            });
        }

        if (name === KERNEL_EVENTS.TASK_STATUS_CHANGED && Number(t.status) === 4) {
            if (previous !== undefined && Number(previous) === 4) return null;
            if (!this._enabled("ConfigMsg_FailSuggest")) return null;
            return this.notify({
                type: TIPS_TYPE.DownloadFail,
                title: TITLE[TIPS_TYPE.DownloadFail],
                body: t.name || t.url || taskId,
            });
        }

        return null;
    }

    /** A 提醒 switch, defaulting to on (the schema's own defaults). */
    _enabled(key) {
        const value = this.getConfig("ConfigMsg", key, true);
        return !(value === false || value === "0" || value === 0);
    }
}

module.exports = { NotificationService, TIPS_TYPE, TITLE };
