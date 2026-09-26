/**
 * Application entry point.
 *
 * Boots the pieces in the order the original boots them, because the order
 * is load bearing:
 *
 *   1. app config is read, since the device signature needs appid/appkey
 *   2. the device signature is computed, since every credential uses it
 *   3. the kernel starts, so downloads can be accepted early
 *   4. login is restored, then the VIP flags are pushed to the kernel
 *   5. plugins load last, because they expect a fully wired context
 *
 * This file is deliberately the only place that knows about all the others.
 * Everything else receives what it needs by injection.
 */

"use strict";

const path = require("path");
const os = require("os");
const fs = require("fs");
const { EventEmitter } = require("events");

const contract = require("./contract");
const { createMesh } = require("./rpc");
const { ThunderKernel } = require("./kernel");
const { LoginClient, createMemoryStore, parseVipInfo } = require("./login");
const { VipTokenClient } = require("./vip-token");

const APP_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Minimal logger.
 *
 * Honours the same environment variables as the original so that a debug
 * session behaves the same way: TL_OUTPUT=console moves the stream to
 * stdout, TL_MODULE_FILTER narrows by module name.
 */
function createLogger(moduleName) {
    const toConsole = process.env[contract.ENV.OUTPUT] === "console";
    const filter = process.env[contract.ENV.MODULE_FILTER] || "";
    const enabled = !filter || moduleName.indexOf(filter) >= 0;

    const emit = (level, args) => {
        if (!enabled) return;
        const line = `[${new Date().toISOString()}] [${level}] [${moduleName}] `;
        if (toConsole) {
            const fn = level === "error" ? console.error : console.log;
            fn(line, ...args);
        }
    };

    return {
        information: (...a) => emit("info", a),
        warning: (...a) => emit("warn", a),
        error: (...a) => emit("error", a),
        debug: (...a) => emit("debug", a),
    };
}

// ---------------------------------------------------------------------------
// App config
// ---------------------------------------------------------------------------

/**
 * Load the application config that the device signature depends on.
 *
 * The original gets this from the native layer at startup. Here it comes from
 * a JSON file with environment overrides, so a build can be configured
 * without recompiling.
 */
function loadAppConfig() {
    const candidates = [
        path.join(APP_ROOT, "config", "app.json"),
        path.join(process.cwd(), "config", "app.json"),
    ];

    let config = {};
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) {
                config = JSON.parse(fs.readFileSync(candidate, "utf8"));
                break;
            }
        } catch (err) {
            // A malformed config is worth surfacing but not fatal: the
            // defaults below are enough to boot and diagnose.
            console.error(`[config] failed to read ${candidate}: ${err.message}`);
        }
    }

    return Object.assign(
        {
            appid: process.env.TL_APPID || "",
            appName: process.env.TL_APPNAME || "Thunder",
            package: process.env.TL_PACKAGE || "com.xunlei.thunder",
            appkey: process.env.TL_APPKEY || "",
            clientVersion: process.env.TL_CLIENT_VERSION || "12.1.2.2662",
            platformVersion: "0",
            osversion: os.release(),
            deviceName: os.hostname(),
        },
        config,
        // Environment wins over the file, so a CI run can override without
        // editing anything on disk.
        process.env.TL_APPID ? { appid: process.env.TL_APPID } : {},
        process.env.TL_APPKEY ? { appkey: process.env.TL_APPKEY } : {}
    );
}

/**
 * Machine id.
 *
 * The original asks the native layer. A stable id can be derived from the
 * hostname plus a persisted random value, which survives restarts and is
 * unique enough for a single machine.
 */
function createMachineIdProvider(store) {
    let cached = store.get("machine-id");
    if (cached) return () => cached;

    cached = `${os.hostname()}-${require("crypto").randomBytes(8).toString("hex")}`;
    store.set("machine-id", cached);
    return () => cached;
}

/**
 * Extract the numeric build number.
 *
 * Used as one of the four inputs to the VIP key derivation. The original
 * reads it from the executable's file version; here it comes from the config
 * version string, taking the last dotted component.
 */
function buildNumberOf(versionString) {
    const parts = String(versionString || "").split(".");
    return parts.length ? parts[parts.length - 1] : "";
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

class Application extends EventEmitter {
    constructor(options) {
        super();
        const opts = options || {};
        this.log = opts.log || createLogger("app");
        this.config = opts.config || loadAppConfig();
        this.store = opts.store || createMemoryStore();

        this.mesh = null;
        this.kernel = null;
        this.login = null;
        this.vipToken = null;

        this.plugins = new Map();
        this.started = false;
    }

    /**
     * Bring everything up.
     *
     * Failures in the optional stages are logged and tolerated: a client that
     * cannot reach the network should still show its window and its local
     * task list.
     */
    async start() {
        if (this.started) return this;
        this.started = true;

        this.log.information("starting, version", this.config.clientVersion);

        // 1. RPC mesh ---------------------------------------------------------
        this.mesh = createMesh();
        this._registerServerFunctions();

        // 2. Kernel -----------------------------------------------------------
        this.kernel = new ThunderKernel({ log: createLogger("kernel") });
        this._wireKernelEvents();

        // 3. Login ------------------------------------------------------------
        const machineId = createMachineIdProvider(this.store);
        this.login = new LoginClient({
            config: this.config,
            getMachineId: machineId,
            store: this.store,
            log: (...a) => this.log.information(...a),
        });
        this.login.initDeviceIdentity();
        this.log.information("device sign computed");

        // 4. VIP token client -------------------------------------------------
        this.vipToken = new VipTokenClient({
            callServerFunction: (name, ...args) =>
                this.mesh.main.callServerFunction(name, ...args),
            getBuildNo: () => buildNumberOf(this.config.clientVersion),
        });

        // 5. Restore the previous session -------------------------------------
        await this._restoreSession();

        // 6. Anonymous fallback -----------------------------------------------
        // Delayed so it does not race a real login that is about to complete.
        this._anonymousTimer = setTimeout(() => {
            this.login.signUpAnonymously().catch((err) => {
                this.log.warning("anonymous signup failed:", err.message);
            });
        }, 3000);
        if (this._anonymousTimer.unref) this._anonymousTimer.unref();

        this.log.information("started");
        this.emit("started");
        return this;
    }

    /**
     * Publish the server functions every renderer and plugin expects.
     *
     * The names come from the contract so a caller can never disagree with
     * the implementation about spelling.
     */
    _registerServerFunctions() {
        const F = contract.SERVER_FUNCTIONS;
        const server = this.mesh.server;

        server.registerFunctions({
            [F.IS_LOGINED]: async () => this.login.isLogined(),
            [F.GET_USER_ID]: async () => this.login.userId || "0",
            [F.GET_SESSION_ID]: async () => this.login.sessionId || "",
            [F.GET_PEER_ID]: async () => this.getPeerId(),
            [F.GET_VIP_INFO]: async () => this.login.vipInfo || { isVip: false },
            [F.GET_ALL_USER_INFO]: async () => this.login.userInfo,
            [F.GET_USER_INFO]: async () => this.login.userInfo,
            [F.GET_THUNDER_VERSION]: async () => this.config.clientVersion,
            [F.GET_CONFIG_MODULES]: async (module, key) => this.getConfigModules(module, key),

            // Credentials for the device signature inputs.
            [F.GET_DEVICE_ID]: async () => this.login.deviceSign,
            [F.GET_LOGIN_DEVICE_ID]: async () => this.login.deviceSign,

            // VIP / DCDN.
            //
            // Argument order is swapped here relative to the kernel: the
            // plugin RPC sends (taskId, cert, index) while the kernel wants
            // (taskId, index, cert). Doing it at this boundary keeps both
            // sides faithful to their own convention.
            [F.ENABLE_DCDN_WITH_VIP_CERT]: async (taskId, cert, index) =>
                this.kernel.enableDcdnWithVipCert(taskId, index, cert),
            [F.UPDATE_DCDN_WITH_VIP_CERT]: async (taskId, cert, index) =>
                this.kernel.updateDcdnWithVipCert(taskId, index, cert),
            [F.DISABLE_DCDN_WITH_VIP_CERT]: async (taskId, index) =>
                this.kernel.disableDcdnWithVipCert(taskId, index),

            [F.GET_DOWNLOADING_ACTIVE_TASK_ID]: async () => this.getActiveTaskId(),
            [F.SELECT_CATEGORY_VIEW]: async () => undefined,
            [F.SET_PLUGIN_STATUS]: async () => undefined,
            [F.TRACK_EVENT]: async () => undefined,
            [F.REGISTER_WEB_EXTERNAL]: async () => undefined,
            [F.REGISTER_WEB_INTERNAL]: async () => undefined,
        });
    }

    /** Re-emit kernel events into the mesh so renderers receive them. */
    _wireKernelEvents() {
        for (const eventName of Object.values(contract.KERNEL_EVENTS)) {
            this.kernel.on(eventName, (payload) => {
                this.mesh.renderer
                    .fireServerEvent(eventName, [payload])
                    .catch((err) => this.log.warning("event forward failed:", err.message));
            });
        }
    }

    /**
     * Restore a session saved by a previous run.
     *
     * The saved blob only proves we logged in once; it does not prove the
     * session is still alive. So the profile is re-fetched, and a rejection
     * is treated as "signed out" rather than an error worth showing.
     */
    async _restoreSession() {
        const raw = this.store.get("userinfo");
        if (!raw) return;

        let saved;
        try {
            saved = JSON.parse(raw);
        } catch (err) {
            this.store.remove("userinfo");
            return;
        }

        if (!saved || !saved.sessionid) return;

        this.login.userId = String(saved.userid || "");
        this.login.sessionId = String(saved.sessionid);
        this.login.nickname = saved.usernick || "";
        this.login.verifyKey = saved.VERIFY_KEY || "";
        this.login.status = contract.USER_STATUS.loggedIn;

        try {
            await this.login.fetchUserInfo();
            this._pushVipToKernel();
            this.login.startKeepalive(
                () => this.emit("session-expired"),
                (msg) => this.emit("session-kickout", msg)
            );
            this.log.information("session restored for user", this.login.userId);
        } catch (err) {
            // The stored session is no longer valid. Clearing it silently is
            // correct: the user did not do anything wrong and there is no
            // useful action for them to take.
            this.log.information("stored session rejected, signing out");
            await this.login.logout();
        }
    }

    /**
     * Push the membership flags to the kernel after a login or a profile
     * refresh. Both the identity and the flags have to move together, or the
     * kernel ends up accelerating for the wrong account.
     */
    _pushVipToKernel() {
        this.kernel.setUserInfo(this.login.userId, this.login.accessToken || "");
        this.kernel.applyVipInfo(this.login.vipInfo, this.getUserChannel());
    }

    // -----------------------------------------------------------------------
    // Accessors used by server functions and plugins
    // -----------------------------------------------------------------------

    /** Stable peer id for this install, persisted across runs. */
    getPeerId() {
        let peerId = this.store.get("peer-id");
        if (!peerId) {
            peerId = require("crypto").randomBytes(20).toString("hex").toUpperCase();
            this.store.set("peer-id", peerId);
        }
        return peerId;
    }

    getUserChannel() {
        return this.store.get("user-channel") || "";
    }

    getActiveTaskId() {
        for (const task of this.kernel.getAllTasks()) {
            if (task.bAcclerating) return task.taskId;
        }
        return "";
    }

    /**
     * Plugin configuration lookup.
     *
     * Plugins ask for settings by (module, key) and expect an array. The
     * defaults below are the ones the shipped plugins fall back to.
     */
    getConfigModules(moduleName, key) {
        const defaults = {
            HDVideo: { domains: ["hd.xunlei.com"] },
            VipDownload: { WDYXDomains: ["lx.patch1.9you.com"] },
        };
        const mod = defaults[moduleName];
        if (!mod || mod[key] === undefined) return [];
        return mod[key];
    }

    // -----------------------------------------------------------------------
    // Plugin host
    // -----------------------------------------------------------------------

    /**
     * Load a plugin into the mesh.
     *
     * A plugin is a function that receives the wiring it needs and returns
     * its registered functions. This mirrors how the shipped plugins call
     * `AsyncGetNativeCallModuleObj` to obtain their context.
     */
    async loadPlugin(pluginPath) {
        const manifest = require(path.join(pluginPath, "config.json"));
        const entry = require(path.join(pluginPath, manifest.main));

        const context = {
            contract,
            log: createLogger(manifest.name),
            client: this.mesh.main,
            registerFunctions: (fns) => this.mesh.main.registerFunctions(fns),
            callServerFunction: (name, ...args) =>
                this.mesh.main.callServerFunction(name, ...args),
        };

        const registered = await entry(context);
        this.plugins.set(manifest.name, { manifest, registered });
        this.log.information("plugin loaded:", manifest.name, manifest.version);
        return manifest;
    }

    // -----------------------------------------------------------------------
    // Session transitions
    // -----------------------------------------------------------------------

    /** Called after a successful interactive login. */
    async onLoginSucceeded() {
        await this.login.fetchUserInfo();
        this._pushVipToKernel();
        this.login.startKeepalive(
            () => this.emit("session-expired"),
            (msg) => this.emit("session-kickout", msg)
        );
        this.mesh.main.fireServerEvent(contract.NATIVE_EVENTS.ON_LOGIN_SUC, [
            this.login.userId,
            this.login.sessionId,
        ]);
    }

    async onLogout() {
        await this.login.logout();
        // An empty identity tells the kernel to stop using the old account's
        // acceleration immediately, before any new login arrives.
        this.kernel.setUserInfo("", "");
        this.kernel.setGlobalExtInfo("isvip=0,viptype=,viplevel=0", false);
        this.mesh.main.fireServerEvent(contract.NATIVE_EVENTS.ON_LOGOUT, [""]);
    }

    async stop() {
        if (this._anonymousTimer) clearTimeout(this._anonymousTimer);
        this.login?.stopKeepalive();
        await this.kernel?.shutdown();
        this.emit("stopped");
    }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/** Build and start an application. Exported for tests and for electron main. */
async function createApplication(options) {
    const app = new Application(options);
    await app.start();
    return app;
}

if (require.main === module) {
    createApplication()
        .then((app) => {
            console.log("[thunderx] booted");
            console.log("[thunderx] device sign:", app.login.deviceSign);
            console.log("[thunderx] peer id    :", app.getPeerId());
            process.on("SIGINT", async () => {
                await app.stop();
                process.exit(0);
            });
        })
        .catch((err) => {
            console.error("[thunderx] boot failed:", err);
            process.exit(1);
        });
}

module.exports = {
    Application,
    createApplication,
    createLogger,
    loadAppConfig,
    createMachineIdProvider,
    buildNumberOf,
};
