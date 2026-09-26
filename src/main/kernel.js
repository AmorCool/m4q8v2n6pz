/**
 * Download kernel facade.
 *
 * The original ships this as `bin/ThunderKernel.node`, a native addon with
 * roughly a hundred exported members, sitting on top of `DownloadSDK.dll` and
 * a separate `DownloadSDKServer.exe` process.
 *
 * This module defines the same surface and routes it to a pluggable engine.
 * Keeping the surface fixed is what makes the replacement possible: every
 * caller in the UI and in the plugins already speaks this interface, so as
 * long as the names and shapes hold, the engine behind it can be anything.
 *
 * The engine contract is small on purpose:
 *
 *     engine.addTask(spec)        -> taskId
 *     engine.removeTask(taskId)   -> void
 *     engine.resumeTask(taskId)   -> void
 *     engine.pause(taskId)        -> void
 *     engine.setUserInfo(userId, token)
 *     engine.setGlobalExtInfo(str, bool)
 *     engine.enableDcdn(taskId, fileIndex, cert)
 *     engine.updateDcdn(taskId, fileIndex, cert)
 *     engine.disableDcdn(taskId, fileIndex)
 *
 * Plus the lifecycle pair the application drives rather than the kernel:
 *
 *     engine.start()              -> Promise
 *     engine.shutdown()           -> Promise
 *
 * The per-task resume is `resumeTask` and not `start` so that it cannot
 * collide with the lifecycle `start` in a class that implements both. That
 * collision is not hypothetical: it was live, and it is written up in
 * engine-aria2.js.
 *
 * Events come back through the `on` channel using the exact event names the
 * original uses, because the UI subscribes by string.
 */

"use strict";

const { EventEmitter } = require("events");
const { KERNEL_EVENTS } = require("./contract");

/**
 * Task states as reported to the UI.
 * The numeric values matter: the renderer maps them directly to icons.
 */
const TASK_STATUS = Object.freeze({
    QUEUED: 0,
    DOWNLOADING: 1,
    PAUSED: 2,
    COMPLETED: 3,
    FAILED: 4,
});

/**
 * Wraps an engine and exposes the kernel interface.
 */
class ThunderKernel extends EventEmitter {
    /**
     * @param {object} [options]
     * @param {object} [options.engine]  concrete engine; a stub is used if omitted
     * @param {function} [options.log]
     */
    constructor(options) {
        super();
        const opts = options || {};
        this.log = opts.log || (() => {});
        this.engine = opts.engine || createNullEngine();

        /** taskId -> task record, kept here so the UI can read synchronously */
        this.tasks = new Map();

        this.userId = "";
        this.userToken = "";
        this.globalExtInfo = "";

        this._wireEngineEvents();
    }

    /**
     * Bridge engine events onto the kernel's own emitter under the original
     * names. Every one of these is a string the UI compares against.
     */
    _wireEngineEvents() {
        const forward = (engineEvent, kernelEvent) => {
            if (typeof this.engine.on !== "function") return;
            this.engine.on(engineEvent, (payload) => {
                this._syncTaskFromEngine(payload);
                this.emit(kernelEvent, payload);
            });
        };

        forward("task-inserted", KERNEL_EVENTS.TASK_INSERTED);
        forward("task-completed", KERNEL_EVENTS.TASK_COMPLETED);
        forward("task-removed", KERNEL_EVENTS.TASK_REMOVED);
        forward("task-status-changed", KERNEL_EVENTS.TASK_STATUS_CHANGED);
        forward("task-detail-changed", KERNEL_EVENTS.TASK_DETAIL_CHANGED);
        forward("task-dcdn-status-changed", KERNEL_EVENTS.TASK_DCDN_STATUS_CHANGED);
        forward("bt-subfile-dcdn-status-changed", KERNEL_EVENTS.BT_SUB_FILE_DCDN_STATUS_CHANGED);
        forward("bt-subfile-detail-changed", KERNEL_EVENTS.BT_SUB_FILE_DETAIL_CHANGED);
        forward("bt-subfile-forbidden", KERNEL_EVENTS.BT_SUB_FILE_FORBIDDEN);
    }

    _syncTaskFromEngine(payload) {
        if (payload && payload.taskId !== undefined) {
            const existing = this.tasks.get(payload.taskId) || {};
            this.tasks.set(payload.taskId, Object.assign(existing, payload));
        }
    }

    // -----------------------------------------------------------------------
    // Identity
    // -----------------------------------------------------------------------

    /**
     * Give the kernel the current account identity.
     *
     * Called on every login change. An empty token means "signed out", which
     * the kernel treats as a request to drop any accelerated sessions.
     */
    setUserInfo(userId, token) {
        this.userId = userId || "";
        this.userToken = token || "";
        if (typeof this.engine.setUserInfo === "function") {
            this.engine.setUserInfo(this.userId, this.userToken);
        }
    }

    /**
     * Push the membership flags into the kernel.
     *
     * The string format is fixed and parsed by the kernel:
     *     isvip=1,viptype=platinum,viplevel=1,userchannel=...
     * The boolean is passed through unchanged; it is not a persistence flag.
     */
    setGlobalExtInfo(info, flag) {
        this.globalExtInfo = info || "";
        if (typeof this.engine.setGlobalExtInfo === "function") {
            this.engine.setGlobalExtInfo(this.globalExtInfo, flag);
        }
    }

    /** Convenience: build the ext info string from a parsed VIP record. */
    applyVipInfo(vipInfo, userChannel) {
        const isVip = vipInfo && vipInfo.isVip ? 1 : 0;
        const vipType = (vipInfo && vipInfo.vipType) || "";
        const vipLevel = (vipInfo && vipInfo.vipLevel) || 0;
        this.setGlobalExtInfo(
            `isvip=${isVip},viptype=${vipType},viplevel=${vipLevel},userchannel=${userChannel || ""}`,
            false
        );
    }

    // -----------------------------------------------------------------------
    // Tasks
    // -----------------------------------------------------------------------

    /**
     * Create a task.
     *
     * @param {object} spec
     * @param {string} spec.url
     * @param {number} [spec.taskType]  2 for BT
     * @param {string} [spec.infoId]    infohash
     * @param {string} [spec.btTitle]
     * @param {string} [spec.savePath]
     */
    addTask(spec) {
        const taskId = typeof this.engine.addTask === "function"
            ? this.engine.addTask(spec)
            : String(Date.now());
        this.tasks.set(taskId, {
            taskId,
            url: spec.url,
            taskType: spec.taskType,
            infoId: spec.infoId,
            btTitle: spec.btTitle,
            savePath: spec.savePath,
            status: TASK_STATUS.QUEUED,
            bAcclerating: false,
            vipSpeed: 0,
            vipSizeList: [],
            dcdnFileIndex: -1,
            serverResourceInfos: new Map(),
        });
        return taskId;
    }

    removeTask(taskId) {
        this.tasks.delete(taskId);
        if (typeof this.engine.removeTask === "function") this.engine.removeTask(taskId);
    }

    startTask(taskId) {
        return this.engine.resumeTask ? this.engine.resumeTask(taskId) : undefined;
    }

    pauseTask(taskId) {
        return this.engine.pause ? this.engine.pause(taskId) : undefined;
    }

    getTask(taskId) {
        return this.tasks.get(taskId) || null;
    }

    getAllTasks() {
        return Array.from(this.tasks.values());
    }

    // -----------------------------------------------------------------------
    // VIP / DCDN
    // -----------------------------------------------------------------------

    /**
     * Open an accelerated channel for one file of a task.
     *
     * Note the argument order: the kernel takes (taskId, fileIndex, cert),
     * while the RPC layer that reaches it takes (taskId, cert, fileIndex).
     * The swap happens in the server function wrapper, not here.
     */
    enableDcdnWithVipCert(taskId, fileIndex, vipCert) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.bAcclerating = true;
            task.dcdnFileIndex = fileIndex;
        }
        if (typeof this.engine.enableDcdn === "function") {
            this.engine.enableDcdn(taskId, fileIndex, vipCert);
        }
    }

    updateDcdnWithVipCert(taskId, fileIndex, vipCert) {
        if (typeof this.engine.updateDcdn === "function") {
            this.engine.updateDcdn(taskId, fileIndex, vipCert);
        }
    }

    disableDcdnWithVipCert(taskId, fileIndex) {
        const task = this.tasks.get(taskId);
        if (task) {
            task.bAcclerating = false;
            task.dcdnFileIndex = -1;
        }
        if (typeof this.engine.disableDcdn === "function") {
            this.engine.disableDcdn(taskId, fileIndex);
        }
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async shutdown() {
        if (typeof this.engine.shutdown === "function") {
            await this.engine.shutdown();
        }
    }
}

// ---------------------------------------------------------------------------
// Null engine
// ---------------------------------------------------------------------------

/**
 * Placeholder engine.
 *
 * It accepts everything and does nothing, which lets the shell boot and be
 * exercised before a real engine exists.
 *
 * Two details are load bearing rather than decorative:
 *
 *   - `addTask` returns a valid id. Callers store it and would misbehave on
 *     undefined.
 *   - `addTask` emits `task-inserted`. Without the event the kernel never
 *     learns the task exists outside its own map, and a UI receives nothing at
 *     all -- which looks like a broken event pipeline rather than like a
 *     missing engine. A stub that is silent is worse than no stub, because it
 *     hides the difference.
 */
function createNullEngine() {
    const emitter = new EventEmitter();
    let counter = 0;

    return Object.assign(emitter, {
        addTask(spec) {
            counter += 1;
            const taskId = `stub-${counter}`;
            // Emitted on the next tick for the same reason a real engine would:
            // the caller has not received its task id yet on this tick, and a
            // synchronous event would reach listeners that cannot key it.
            setImmediate(() => {
                emitter.emit("task-inserted", {
                    taskId,
                    status: TASK_STATUS.QUEUED,
                    url: (spec && spec.url) || "",
                    taskType: spec && spec.torrentPath ? 2 : 1,
                    totalSize: 0,
                    completedSize: 0,
                    progress: 0,
                    downloadSpeed: 0,
                    bAcclerating: false,
                    dcdnFileIndex: -1,
                });
            });
            return taskId;
        },
        removeTask(taskId) {
            setImmediate(() => emitter.emit("task-removed", { taskId }));
        },
        // The lifecycle and the per-task calls are separate names here for the
        // same reason they are separate in the real engine, and the stub is
        // where getting that wrong stays invisible.
        //
        // This used to be a single `start() {}`. Being empty and argument-less
        // it answered to both meanings, so the kernel's per-task resume worked
        // and the application's engine boot worked, and a real engine that had
        // only one of them could not be told apart from a working one. A stub
        // is worth having only if it fails where the real thing would.
        async start() {
            return this;
        },
        resumeTask() {},
        pause() {},
        setUserInfo() {},
        setGlobalExtInfo() {},
        enableDcdn() {},
        updateDcdn() {},
        disableDcdn() {},
        async shutdown() {},
    });
}

module.exports = {
    ThunderKernel,
    TASK_STATUS,
    createNullEngine,
};
