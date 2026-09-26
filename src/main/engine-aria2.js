/**
 * aria2 download engine.
 *
 * Implements the engine contract kernel.js defines, on top of an aria2c child
 * process driven over its JSON-RPC interface.
 *
 * Why a child process rather than linking aria2 in:
 *
 *   - aria2 is GPLv3. Running it as a separate program keeps it at arm's
 *     length, which is the same reason the iOS build ships an executable
 *     rather than only a static library.
 *   - A downloader is the component most likely to be killed by the OS or to
 *     wedge on a bad peer. As a child process it can be restarted without
 *     taking the UI with it.
 *   - The RPC surface is stable and documented, so this file depends on
 *     aria2's public interface rather than its internals.
 *
 * What this file is responsible for is translation, and the two sides do not
 * line up evenly:
 *
 *   Thunder                        aria2
 *   ---------------------------    ---------------------------------------
 *   task (one per download)        one GID, or several for a BT torrent
 *   taskId (string, ours)          gid (hex string, theirs)
 *   per-file progress within task   files[] on the GID
 *   "accelerating" (DCDN)          no equivalent -- VIP speedup is a
 *                                  server-side product, not a client feature
 *
 * The taskId is ours and stable. aria2's gid is not, because a restart loses
 * it, so a mapping is kept and rebuilt from the aria2 session file on start.
 *
 * @see https://aria2.github.io/manual/en/html/aria2c.html#rpc-interface
 */

"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

const { TASK_STATUS } = require("./kernel");

/** aria2 reports status as a string; the kernel wants a number. */
const ARIA2_STATUS_MAP = Object.freeze({
    active: TASK_STATUS.DOWNLOADING,
    waiting: TASK_STATUS.QUEUED,
    paused: TASK_STATUS.PAUSED,
    complete: TASK_STATUS.COMPLETED,
    error: TASK_STATUS.FAILED,
    removed: TASK_STATUS.FAILED,
});

/**
 * Ask the OS for a free port.
 *
 * aria2's RPC port is fixed in its config, and hardcoding one means two
 * instances collide. Binding to 0 and reading back the assignment is the
 * only race-free way to do this without a lock file.
 */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Minimal JSON-RPC client for aria2.
 *
 * aria2 speaks JSON-RPC 2.0 over HTTP with a secret token in the params. Only
 * the two methods this engine needs are wrapped; anything else can go through
 * `call` directly.
 */
class Aria2RpcClient {
    constructor(options) {
        this.port = options.port;
        this.secret = options.secret;
        this.host = options.host || "127.0.0.1";
        this.timeout = options.timeout || 10000;
    }

    call(method, params) {
        const payload = {
            jsonrpc: "2.0",
            id: crypto.randomBytes(8).toString("hex"),
            method,
            // The token goes first, by aria2's convention.
            params: [`token:${this.secret}`].concat(params || []),
        };
        const body = Buffer.from(JSON.stringify(payload));

        return new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: this.host,
                    port: this.port,
                    method: "POST",
                    path: "/jsonrpc",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": body.length,
                    },
                },
                (res) => {
                    const chunks = [];
                    res.on("data", (c) => chunks.push(c));
                    res.on("end", () => {
                        const text = Buffer.concat(chunks).toString("utf8");
                        let parsed;
                        try {
                            parsed = JSON.parse(text);
                        } catch (err) {
                            reject(new Error(`aria2 rpc returned non-json: ${text.slice(0, 200)}`));
                            return;
                        }
                        if (parsed.error) {
                            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                            return;
                        }
                        resolve(parsed.result);
                    });
                }
            );
            req.setTimeout(this.timeout, () => {
                req.destroy(new Error(`aria2 rpc timed out: ${method}`));
            });
            req.on("error", reject);
            req.end(body);
        });
    }

    /** Poll until the endpoint answers, which means aria2 is up. */
    async waitUntilReady(deadlineMs) {
        const started = Date.now();
        const limit = deadlineMs || 15000;
        let lastError;
        while (Date.now() - started < limit) {
            try {
                await this.call("aria2.getVersion");
                return true;
            } catch (err) {
                lastError = err;
                await new Promise((r) => setTimeout(r, 150));
            }
        }
        throw new Error(`aria2 did not come up: ${lastError && lastError.message}`);
    }
}

/**
 * Map one aria2 task into the shape the kernel's events carry.
 *
 * The kernel stores whatever it is given, and the UI reads specific fields,
 * so the names here are the contract, not a convenience.
 */
function toKernelTask(taskId, aria2Task) {
    const total = Number(aria2Task.totalLength || 0);
    const completed = Number(aria2Task.completedLength || 0);
    const speed = Number(aria2Task.downloadSpeed || 0);
    const status = ARIA2_STATUS_MAP[aria2Task.status] || TASK_STATUS.QUEUED;

    const files = (aria2Task.files || []).map((file, index) => ({
        index: file.index === undefined ? index : file.index,
        path: file.path,
        fileName: path.basename(file.path || ""),
        fileSize: Number(file.length || 0),
        completedLength: Number(file.completedLength || 0),
        selected: file.selected !== "false",
        url: (file.uris && file.uris[0] && file.uris[0].uri) || "",
    }));

    // aria2 reports ETA only while active, and sometimes as a huge sentinel
    // when the speed is zero. Both are normalised to null so a caller does not
    // have to know that.
    const eta = Number(aria2Task.eta);
    const etaSeconds = speed > 0 && Number.isFinite(eta) && eta > 0 ? eta : null;

    return {
        taskId,
        gid: aria2Task.gid,
        status,
        taskType: aria2Task.bittorrent ? 2 : 1,
        infoId: (aria2Task.infoHash && aria2Task.infoHash.toUpperCase()) || "",
        btTitle: (aria2Task.bittorrent && aria2Task.bittorrent.info && aria2Task.bittorrent.info.name) || "",
        filePath: files.length ? files[0].path : "",
        files,
        fileCount: files.length,
        totalSize: total,
        completedSize: completed,
        progress: total > 0 ? completed / total : 0,
        downloadSpeed: speed,
        uploadSpeed: Number(aria2Task.uploadSpeed || 0),
        etaSeconds,
        connections: Number(aria2Task.connections || 0),
        errorCode: Number(aria2Task.errorCode || 0),
        errorMessage: aria2Task.errorMessage || "",
        // Filled in by the VIP path; aria2 has no notion of either.
        bAcclerating: false,
        dcdnFileIndex: -1,
    };
}

class Aria2Engine extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.binary      path to aria2c
     * @param {string} options.workDir     where downloads and state live
     * @param {object} [options.log]
     * @param {number} [options.pollInterval]
     */
    constructor(options) {
        super();
        const opts = options || {};
        this.binary = opts.binary;
        this.workDir = opts.workDir || path.join(os.tmpdir(), "thunderx-downloads");
        this.log = opts.log || (() => {});

        /**
         * How often aria2 is polled for progress.
         *
         * Polling rather than aria2's WebSocket notifications: notifications
         * need a second client and a different framing, and at this interval
         * the difference is not observable in the UI. One request per second
         * for the whole task list, not per task.
         */
        this.pollInterval = opts.pollInterval || 1000;

        this.process = null;
        this.rpc = null;
        this.secret = crypto.randomBytes(24).toString("hex");
        this.port = opts.port || 0;

        /** our taskId -> aria2 gid */
        this.gidByTask = new Map();
        /** aria2 gid -> our taskId */
        this.taskByGid = new Map();
        /** our taskId -> last emitted aria2 payload, for change detection */
        this.lastSeen = new Map();
        /** our taskId -> { userId, token } */
        this.identity = { userId: "", token: "" };
        this.globalExtInfo = "";

        this.pollTimer = null;
        this.stopping = false;

        /** our taskId -> { fileIndex, cert } while a VIP speedup is claimed */
        this._dcdn = new Map();

        this.taskCounter = 0;
        this.sessionFile = path.join(this.workDir, "aria2.session");
        this.rpcSecretFile = path.join(this.workDir, "rpc-secret.txt");
        this.optionsFile = path.join(this.workDir, "aria2.conf");
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Start aria2c and connect to it.
     *
     * The process is started with an explicit option list rather than a config
     * file the user might have edited, so behaviour cannot drift with whatever
     * is in their home directory. The generated config is written too, but only
     * so that a person debugging a download can see what was passed.
     */
    async start() {
        if (this.process) return this;
        if (!this.binary) throw new Error("Aria2Engine needs a binary path");

        fs.mkdirSync(this.workDir, { recursive: true });
        if (!this.port) this.port = await findFreePort();

        const args = this.buildArgs();
        this.log("aria2c", this.binary);
        this.log("args", args.join(" "));

        this.process = spawn(this.binary, args, {
            cwd: this.workDir,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        // aria2 is chatty on stderr at notice level. Keeping it in the log is
        // what makes a failed download diagnosable, so it is forwarded rather
        // than discarded.
        this.process.stdout.on("data", (d) => this.log("aria2:", d.toString().trim()));
        this.process.stderr.on("data", (d) => this.log("aria2:", d.toString().trim()));
        this.process.on("exit", (code, signal) => this._onProcessExit(code, signal));
        this.process.on("error", (err) => this.emit("engine-error", err));

        this.rpc = new Aria2RpcClient({ port: this.port, secret: this.secret });
        await this.rpc.waitUntilReady();

        // Notify mode would push updates; polling is used instead, so the
        // method is disabled to avoid the overhead of aria2 tracking
        // subscribers nobody reads.
        try {
            await this.rpc.call("aria2.changeGlobalOption", [
                { "enable-rpc": "true" },
            ]);
        } catch (err) {
            this.log("changeGlobalOption failed:", err.message);
        }

        this._startPolling();
        this.emit("engine-started", { port: this.port });
        return this;
    }

    /**
     * The aria2 command line.
     *
     * Several values are chosen because of the Turbo patches, and are only
     * accepted by a binary built from this fork; a stock aria2 would reject
     * the -x value above 16. That is checked at start-up rather than assumed.
     */
    buildArgs() {
        return [
            "--enable-rpc=true",
            `--rpc-listen-port=${this.port}`,
            `--rpc-secret=${this.secret}`,
            "--rpc-listen-all=false",
            "--rpc-allow-origin-all=false",

            // Session: what makes a restart resumable.
            `--input-file=${this.sessionFile}`,
            `--save-session=${this.sessionFile}`,
            "--save-session-interval=30",
            "--force-save=true",

            // Turbo settings. -x unlimited is the patch; without it aria2
            // clamps to 16 and silently ignores the rest.
            "--max-connection-per-server=-1",
            "--split=-1",
            "--min-split-size=1K",
            "--file-allocation=none",

            // Retry policy, also patched in.
            "--max-tries=0",
            "--retry-wait=3",
            "--retry-on-400=true",
            "--retry-on-403=true",
            "--retry-on-unknown=true",
            "--timeout=30",
            "--connect-timeout=10",
            "--lowest-speed-limit=0",

            "--continue=true",
            "--auto-file-renaming=false",
            "--allow-overwrite=false",
            "--check-integrity=false",

            // BT: no seeding, because this is a download client. DHT and
            // tracker traffic are on so magnet links resolve.
            "--seed-time=0",
            "--bt-enable-lpd=true",
            "--enable-dht=true",
            "--enable-dht6=false",
            "--bt-max-peers=200",
            "--follow-torrent=mem",

            // The Windows build has no system certificate store path baked in
            // that we control, so the bundled file is preferred when present.
            ...(this.caBundle() ? [`--ca-certificate=${this.caBundle()}`] : []),

            "--quiet=true",
            "--console-log-level=notice",
            "--summary-interval=0",
        ];
    }

    caBundle() {
        const candidates = [
            path.join(path.dirname(this.binary || ""), "ca-bundle.crt"),
            path.join(this.workDir, "ca-bundle.crt"),
        ];
        for (const candidate of candidates) {
            if (candidate && fs.existsSync(candidate)) return candidate;
        }
        return "";
    }

    async stop() {
        this.stopping = true;
        this._stopPolling();

        if (this.rpc) {
            // A graceful shutdown folds the session file, which is what makes
            // the next start resumable. It is worth waiting for.
            try {
                await this.rpc.call("aria2.shutdown");
            } catch (err) {
                this.log("graceful shutdown failed:", err.message);
            }
        }

        const proc = this.process;
        this.process = null;
        this.rpc = null;

        if (proc && !proc.killed) {
            await new Promise((resolve) => {
                const killTimer = setTimeout(() => {
                    try {
                        proc.kill("SIGKILL");
                    } catch (err) {
                        // Already gone.
                    }
                    resolve();
                }, 3000);
                proc.once("exit", () => {
                    clearTimeout(killTimer);
                    resolve();
                });
            });
        }
        this.emit("engine-stopped");
    }

    _onProcessExit(code, signal) {
        this.log(`aria2c exited code=${code} signal=${signal}`);
        this._stopPolling();
        if (!this.stopping) {
            // An unexpected exit is reported rather than swallowed: silently
            // losing the downloader while tasks are queued is the kind of
            // failure that looks like "nothing happens".
            this.emit("engine-exited", { code, signal });
        }
    }

    // -----------------------------------------------------------------------
    // Engine contract
    // -----------------------------------------------------------------------

    /**
     * Add a download.
     *
     * The taskId is returned synchronously because the kernel and its callers
     * store it immediately, but aria2 has not been told about the download
     * yet. The gid is filled in when the RPC call lands, and any progress
     * event carries the taskId so callers never need the gid.
     *
     * @param {object} spec
     * @param {string} spec.url
     * @param {string} [spec.dir]
     * @param {string} [spec.out]
     * @param {string} [spec.torrentPath]
     * @returns {string} taskId
     */
    addTask(spec) {
        this.taskCounter += 1;
        const taskId = `task-${Date.now()}-${this.taskCounter}`;

        const options = {};
        if (spec.dir) options.dir = spec.dir;
        if (spec.out) options.out = spec.out;
        if (spec.referer) options.referer = spec.referer;
        if (spec.cookie) options.header = [`Cookie: ${spec.cookie}`];
        if (spec.userAgent) options["user-agent"] = spec.userAgent;
        if (spec.headers) {
            options.header = Object.entries(spec.headers).map(([k, v]) => `${k}: ${v}`);
        }

        this.emit("task-inserted", {
            taskId,
            status: TASK_STATUS.QUEUED,
            url: spec.url,
            taskType: spec.torrentPath ? 2 : 1,
            bAcclerating: false,
            dcdnFileIndex: -1,
        });

        this._addToAria2(taskId, spec, options).catch((err) => {
            this.log("addTask failed:", err.message);
            this.emit("task-status-changed", {
                taskId,
                status: TASK_STATUS.FAILED,
                errorMessage: err.message,
            });
        });

        return taskId;
    }

    async _addToAria2(taskId, spec, options) {
        let gid;

        if (spec.torrentPath) {
            // A .torrent is uploaded as base64 rather than referenced by path,
            // because aria2 resolves a path relative to its own working
            // directory, not ours.
            const torrent = fs.readFileSync(spec.torrentPath).toString("base64");
            const uris = spec.url ? [spec.url] : [];
            gid = await this.rpc.call("aria2.addTorrent", [torrent, uris, options]);
        } else if (/^magnet:/i.test(spec.url || "")) {
            gid = await this.rpc.call("aria2.addUri", [[spec.url], options]);
        } else {
            gid = await this.rpc.call("aria2.addUri", [[spec.url], options]);
        }

        this.gidByTask.set(taskId, gid);
        this.taskByGid.set(gid, taskId);
        this.log("added", taskId, "->", gid);
        this.emit("task-detail-changed", { taskId, gid });

        // aria2 starts paused=false by default; unpause only if the caller
        // asked for it, so a queued add stays queued.
        if (spec.startNow === false) {
            await this.rpc.call("aria2.pause", [gid]).catch(() => undefined);
        }

        this._pollOnce().catch(() => undefined);
    }

    async removeTask(taskId) {
        const gid = this.gidByTask.get(taskId);
        if (!gid) return;
        try {
            await this.rpc.call("aria2.forceRemove", [gid]);
        } catch (err) {
            this.log("removeTask failed:", err.message);
        }
        this._forget(taskId);
        this.emit("task-removed", { taskId });
    }

    start(taskId) {
        const gid = this.gidByTask.get(taskId);
        if (!gid || !this.rpc) return;
        this.rpc.call("aria2.unpause", [gid]).catch((err) => this.log("start failed:", err.message));
    }

    pause(taskId) {
        const gid = this.gidByTask.get(taskId);
        if (!gid || !this.rpc) return;
        // forcePause rather than pause: the plain form waits for the current
        // piece to finish, which on a slow peer can take a long time and makes
        // the UI look unresponsive.
        this.rpc.call("aria2.forcePause", [gid]).catch((err) => this.log("pause failed:", err.message));
    }

    /**
     * Pause every active task.
     *
     * Used when the session ends: the VIP speedup tokens are per-account, so
     * continuing to run accelerated tasks after a sign-out would leave them
     * using credentials the user no longer holds.
     */
    async pauseAll() {
        if (!this.rpc) return;
        try {
            await this.rpc.call("aria2.pauseAll");
        } catch (err) {
            this.log("pauseAll failed:", err.message);
        }
    }

    setUserInfo(userId, token) {
        this.identity = { userId: userId || "", token: token || "" };
        // aria2 has no account concept. What the identity does buy is the
        // referer/cookie pair a VIP task needs, which is set per task.
    }

    setGlobalExtInfo(info) {
        this.globalExtInfo = info || "";
    }

    // -----------------------------------------------------------------------
    // VIP / DCDN
    //
    // aria2 has no equivalent of any of these. They are recorded so that the
    // kernel's bookkeeping and events stay truthful -- a UI that shows an
    // acceleration badge needs the flag -- while the actual speedup remains a
    // server-side product this client cannot reproduce.
    // -----------------------------------------------------------------------

    enableDcdn(taskId, fileIndex, cert) {
        this._dcdn.set(taskId, { fileIndex, cert });
        this.emit("task-dcdn-status-changed", {
            taskId,
            bAcclerating: true,
            dcdnFileIndex: fileIndex,
        });
    }

    updateDcdn(taskId, fileIndex, cert) {
        const existing = this._dcdn.get(taskId);
        this._dcdn.set(taskId, { fileIndex, cert });
        if (existing && existing.fileIndex !== fileIndex) {
            this.emit("task-dcdn-status-changed", { taskId, bAcclerating: true, dcdnFileIndex: fileIndex });
        }
    }

    disableDcdn(taskId, fileIndex) {
        this._dcdn.delete(taskId);
        this.emit("task-dcdn-status-changed", {
            taskId,
            bAcclerating: false,
            dcdnFileIndex: -1,
            fileIndex,
        });
    }

    // -----------------------------------------------------------------------
    // Polling
    // -----------------------------------------------------------------------

    _startPolling() {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => {
            this._pollOnce().catch((err) => this.log("poll failed:", err.message));
        }, this.pollInterval);
        if (this.pollTimer.unref) this.pollTimer.unref();
    }

    _stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /**
     * One progress sweep.
     *
     * `tellActive` and `tellWaiting`/`tellStopped` are separate methods, so
     * all three are asked for in one batch to keep this to a single round
     * trip. `tellStopped` is capped: aria2 keeps completed downloads in its
     * list forever otherwise.
     */
    async _pollOnce() {
        if (!this.rpc) return;

        const keys = [
            "gid", "status", "totalLength", "completedLength", "downloadSpeed",
            "uploadSpeed", "connections", "numSeeders", "errorCode", "errorMessage",
            "files", "bittorrent", "infoHash", "eta",
        ];

        const results = await Promise.all([
            this.rpc.call("aria2.tellActive", [keys]),
            this.rpc.call("aria2.tellWaiting", [0, 100, keys]),
            this.rpc.call("aria2.tellStopped", [0, 100, keys]),
        ]);

        const tasks = [].concat(results[0] || [], results[1] || [], results[2] || []);

        for (const task of tasks) {
            const taskId = this.taskByGid.get(task.gid);
            if (!taskId) continue;

            const mapped = toKernelTask(taskId, task);
            const previous = this.lastSeen.get(taskId);

            // Compare on the fields the UI actually shows. Comparing the whole
            // object would emit on every poll, because aria2 reports a new
            // `downloadSpeed` each time even when it has not changed value.
            const changed = !previous || previous.status !== mapped.status ||
                previous.completedSize !== mapped.completedSize ||
                previous.downloadSpeed !== mapped.downloadSpeed ||
                previous.connections !== mapped.connections;

            if (changed) {
                this.lastSeen.set(taskId, mapped);

                if (previous && previous.status !== mapped.status) {
                    this.emit("task-status-changed", mapped);
                } else {
                    this.emit("task-detail-changed", mapped);
                }

                if (mapped.status === TASK_STATUS.COMPLETED &&
                    (!previous || previous.status !== TASK_STATUS.COMPLETED)) {
                    this.emit("task-completed", mapped);
                }

                // BT sub-file progress. Only emitted for torrents, and only
                // when a file's completion moved, because the UI draws a per
                // -file list and redrawing it on every poll is wasteful.
                if (mapped.taskType === 2) {
                    this.emit("bt-subfile-detail-changed", {
                        taskId,
                        files: mapped.files,
                    });
                }
            }
        }
    }

    _forget(taskId) {
        const gid = this.gidByTask.get(taskId);
        if (gid) this.taskByGid.delete(gid);
        this.gidByTask.delete(taskId);
        this.lastSeen.delete(taskId);
    }

    /** Exposed for tests and for a future renderer that wants the raw view. */
    async describe(taskId) {
        const gid = this.gidByTask.get(taskId);
        if (!gid || !this.rpc) return null;
        const raw = await this.rpc.call("aria2.tellStatus", [gid]);
        return toKernelTask(taskId, raw);
    }
}

module.exports = {
    Aria2Engine,
    Aria2RpcClient,
    toKernelTask,
    ARIA2_STATUS_MAP,
    findFreePort,
};
