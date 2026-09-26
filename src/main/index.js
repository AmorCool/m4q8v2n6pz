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
const { PluginHost } = require("./plugin-host");
const { Aria2Engine } = require("./engine-aria2");

const APP_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Values taken from the shipped build
// ---------------------------------------------------------------------------

/*
 * Defaults for `GetInitUserLoginParam`.
 *
 * These are the values the shipped User plugin carries in its own source, so
 * a fresh checkout can complete an OAuth2 flow without being configured
 * first. They are tenant credentials rather than protocol constants, which
 * is why they are overridable through `config.loginParam` instead of being
 * frozen into the contract.
 */
const DEFAULT_PROJECT_ID = "2rvk4e3gkdnl7u1kl0k";
const DEFAULT_CLIENT_ID = "XXDfQA-ruQKfza9f";
const DEFAULT_CLIENT_SECRET = "jXD0dQ-nm_yybCfqj7EqUKQtp6sc5q1kzodIj96Gfq0";

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
        this.pluginHost = null;

        this.plugins = new Map();
        // Views a plugin asked for before a renderer existed to mount them.
        this.pendingWebviews = [];
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
        // The real download engine is used when a binary is configured. With
        // neither a path nor a working binary the stub takes over, so the app
        // still boots and its UI is reachable without aria2 present.
        const engine = this._createEngine();
        this.kernel = new ThunderKernel({
            log: createLogger("kernel"),
            engine: engine || undefined,
        });
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

        // 5. Plugin host ------------------------------------------------------
        // Built before plugins load so that a plugin's registration calls have
        // somewhere to land, but nothing is loaded yet: plugins expect a fully
        // wired context and the session may still be restoring.
        this.pluginHost = new PluginHost({
            mesh: this.mesh,
            log: (...a) => this.log.information(...a),
        });

        // 6. Restore the previous session -------------------------------------
        await this._restoreSession();

        // 7. Anonymous fallback -----------------------------------------------
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

        /*
         * Every plugin-side call arrives as (callerContext, selfContext, ...).
         * The shipped handlers are declared that way, so each of ours gets the
         * same two leading parameters stripped before it runs. Wrapping once
         * here is what keeps the individual handlers readable, and it means a
         * handler can never accidentally treat a context object as its first
         * real argument.
         */
        const fromPlugin = (handler) => async (...all) => handler(...all.slice(2));

        server.registerFunctions({
            [F.IS_LOGINED]: fromPlugin(async () => this.login.isLogined()),
            [F.GET_USER_ID]: fromPlugin(async () => this.login.userId || "0"),
            [F.GET_SESSION_ID]: fromPlugin(async () => this.login.sessionId || ""),
            [F.GET_PEER_ID]: fromPlugin(async () => this.getPeerId()),
            [F.GET_VIP_INFO]: fromPlugin(async () => this.login.vipInfo || { isVip: false }),
            [F.GET_ALL_USER_INFO]: fromPlugin(async () => this.login.userInfo),
            // The second argument selects a projection. VipDownload asks for
            // projection 2, which is the vip-shaped subset; other callers ask
            // for the full object. Both read it as JSON, hence the string.
            [F.GET_USER_INFO]: fromPlugin(async (projection) =>
                this.getUserInfoForPlugin(projection)),
            [F.GET_THUNDER_VERSION]: fromPlugin(async () => this.config.clientVersion),
            [F.GET_CONFIG_MODULES]: fromPlugin(async (module, key) =>
                this.getConfigModules(module, key)),

            // The OAuth2 client credentials.
            //
            // The User plugin asks for this before it can make any xbase
            // request, and it then does `param.userAgent = hackUA(param)`
            // without a null check -- so returning null here is not a safe
            // stub, it is a crash. It must return an object.
            //
            // apiOrigin follows the project id: https://<PROJECT_ID>.xbase.xyz.
            // The plugin's own source carries the same value for its internal
            // build, which is how the shape was confirmed.
            [F.GET_INIT_USER_LOGIN_PARAM]: fromPlugin(async () => this.getInitUserLoginParam()),

            // Credentials for the device signature inputs.
            [F.GET_DEVICE_ID]: fromPlugin(async () => this.login.deviceSign),
            [F.GET_LOGIN_DEVICE_ID]: fromPlugin(async () => this.login.deviceSign),

            // VIP / DCDN.
            //
            // Argument order is swapped here relative to the kernel: the
            // plugin RPC sends (taskId, cert, index) while the kernel wants
            // (taskId, index, cert). Doing it at this boundary keeps both
            // sides faithful to their own convention.
            [F.ENABLE_DCDN_WITH_VIP_CERT]: fromPlugin(async (taskId, cert, index) =>
                this.kernel.enableDcdnWithVipCert(taskId, index, cert)),
            [F.UPDATE_DCDN_WITH_VIP_CERT]: fromPlugin(async (taskId, cert, index) =>
                this.kernel.updateDcdnWithVipCert(taskId, index, cert)),
            [F.DISABLE_DCDN_WITH_VIP_CERT]: fromPlugin(async (taskId, index) =>
                this.kernel.disableDcdnWithVipCert(taskId, index)),

            // Plugins ask the renderer to mount a webview. The real work is a
            // `document.createElement("webview")` in a renderer, which does
            // not exist yet, so the request is recorded and answered with the
            // shape the caller destructures: [ok, message]. Claiming success
            // without mounting would be worse than this -- the caller would
            // believe a view exists -- so the record is what a future renderer
            // drains.
            [F.CREATE_WEBVIEW]: fromPlugin(async (viewId, params) =>
                this.createWebview(viewId, params)),

            [F.GET_DOWNLOADING_ACTIVE_TASK_ID]: fromPlugin(async () => this.getActiveTaskId()),
            [F.SELECT_CATEGORY_VIEW]: fromPlugin(async () => undefined),
            [F.SET_PLUGIN_STATUS]: fromPlugin(async () => undefined),
            [F.TRACK_EVENT]: fromPlugin(async () => undefined),
            [F.REGISTER_WEB_EXTERNAL]: fromPlugin(async () => undefined),
            [F.REGISTER_WEB_INTERNAL]: fromPlugin(async () => undefined),
            // ThunderPanPlugin asks for a peer id of its own; the sign-in one
            // is what the transport uses, so they are the same value.
            [F.GET_TP_PEER_ID]: fromPlugin(async () => this.getPeerId()),
        });
    }

    /**
     * Build the download engine, or return null to let the kernel use its
     * stub.
     *
     * aria2 is shipped alongside the app rather than found on PATH, because a
     * user-installed aria2 will not have the Turbo patches and would silently
     * clamp the connection count. So the search is: explicit config, then the
     * locations the packaging step uses, then PATH as a last resort.
     */
    _createEngine() {
        const configured = this.config.aria2Path;
        const name = process.platform === "win32" ? "aria2c.exe" : "aria2c";

        const candidates = [
            configured,
            path.join(APP_ROOT, "bin", name),
            path.join(APP_ROOT, "vendor", "aria2", name),
            path.join(process.resourcesPath || "", "bin", name),
        ].filter(Boolean);

        let binary = "";
        for (const candidate of candidates) {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                binary = candidate;
                break;
            } catch (err) {
                // Not there or not executable; try the next.
            }
        }

        if (!binary) {
            this.log.information("no aria2 binary found; downloads are stubbed");
            return null;
        }

        const engine = new Aria2Engine({
            binary,
            workDir: this.config.downloadDir || path.join(os.homedir(), "ThunderX"),
            log: (...a) => this.log.information("aria2", ...a),
        });

        // Boot the engine without making the app wait for it. aria2 takes a
        // moment to open its port, and a slow start should not block the UI
        // from appearing.
        engine.start().catch((err) => {
            this.log.warning("aria2 failed to start:", err.message);
            this.emit("engine-unavailable", err);
        });

        this.engine = engine;
        return engine;
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

    /**
     * The OAuth2 client credentials the User plugin builds every xbase
     * request from.
     *
     * Two things about this are load-bearing:
     *
     *   1. It must never return null. The plugin immediately writes to the
     *      result (`param.userAgent = hackUA(param)`) with no guard, so a
     *      null is a crash rather than a degraded start.
     *   2. `apiOrigin` is derived, not arbitrary: the shipped internal build
     *      uses `https://2rvk4e3gkdnl7u1kl0k.xbase.xyz`, and
     *      `2rvk4e3gkdnl7u1kl0k` is that plugin's PROJECT_ID. So the form is
     *      `https://<projectId>.xbase.xyz`.
     *
     * The credentials themselves are tenant data, so they come from config
     * and fall back to the values the shipped plugin carries.
     */
    getInitUserLoginParam() {
        const overrides = this.config.loginParam || {};
        const projectId = overrides.projectId || DEFAULT_PROJECT_ID;

        return {
            apiOrigin: overrides.apiOrigin || `https://${projectId}.xbase.xyz`,
            clientId: overrides.clientId || DEFAULT_CLIENT_ID,
            clientSecret: overrides.clientSecret || DEFAULT_CLIENT_SECRET,
            // Left empty on purpose: the plugin fills it from the client
            // build when it is absent, and it knows its own UA string better
            // than we do.
            userAgent: overrides.userAgent || "",
        };
    }

    /**
     * The user profile as a plugin consumes it.
     *
     * Callers parse the result as JSON, so a string is the correct type here
     * even though the underlying value is an object. Returning the object
     * directly makes `JSON.parse` throw inside the plugin.
     *
     * `projection` selects a subset. VipDownload passes 2 and then reads
     * `vasType` and `isVip` off the result; the rest of the client asks for
     * the whole profile. Both spellings of the vip flag are emitted because
     * the plugin compares `isVip` by string (`=== "1"`) while the parser
     * produces a boolean.
     */
    getUserInfoForPlugin(projection) {
        const info = this.login.userInfo || {};
        const vip = this.login.vipInfo || {};

        if (Number(projection) === 2) {
            return JSON.stringify({
                vasType: vip.vasType || 0,
                isVip: vip.isVip ? "1" : "0",
                vipLevel: vip.vipLevel || 0,
                vipType: vip.vipType || "",
                userId: this.login.userId || "0",
                nickName: info.nickName || info.usernick || "",
            });
        }

        return JSON.stringify(info);
    }

    /**
     * Record a plugin's request to mount a view.
     *
     * The original creates a real Electron <webview> here. That is a renderer
     * responsibility and this process has no DOM, so the request is queued and
     * acknowledged instead. A renderer that comes up later drains the queue.
     *
     * The reply shape is the important part: the caller destructures it as
     * `[ok, message]` and only proceeds with the rest of its start-up when
     * `ok` is truthy.
     */
    createWebview(viewId, params) {
        if (!params || !params.src) {
            return [false, "CreateWebview needs a src"];
        }

        this.pendingWebviews.push({
            id: viewId,
            src: params.src,
            nodeintegration: params.nodeintegration,
        });
        this.log.information("webview queued:", viewId, params.src);

        return [true, "success"];
    }

    // -----------------------------------------------------------------------
    // Plugin host
    // -----------------------------------------------------------------------

    /**
     * Load a plugin directory into the running application.
     *
     * The plugins are unmodified webpack bundles that read their wiring off
     * `global` and register themselves by side effect, so all the work is in
     * the host. Loading an unmodified plugin is the strongest available check
     * that the contract has been reproduced correctly.
     *
     * @param {string} pluginDir  directory containing config.json
     */
    async loadPlugin(pluginDir) {
        if (!this.pluginHost) {
            throw new Error("plugin host is not available; start() the application first");
        }
        const manifest = this.pluginHost.load(pluginDir);
        this.plugins.set(manifest.name, { manifest, dir: pluginDir });
        return manifest;
    }

    /**
     * Load every plugin under a directory.
     *
     * Failures are collected rather than thrown: a client should still start
     * with the plugins that do work.
     */
    async loadPlugins(pluginsRoot) {
        if (!this.pluginHost) {
            throw new Error("plugin host is not available; start() the application first");
        }
        const results = this.pluginHost.loadAll(pluginsRoot);
        for (const result of results) {
            if (result.manifest) {
                this.plugins.set(result.name, {
                    manifest: result.manifest,
                    dir: path.join(pluginsRoot, result.name),
                });
            }
        }
        return results;
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
