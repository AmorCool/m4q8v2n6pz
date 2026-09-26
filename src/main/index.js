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
const qrcode = require("./qrcode");
const { PanClient, PAN_ERROR } = require("./pan");
const { VipTokenClient } = require("./vip-token");
const { PluginHost } = require("./plugin-host");
const { Aria2Engine } = require("./engine-aria2");
const { ConfigStore } = require("./config");
const { ConfigHandler } = require("./config-handler");
const settingsSchema = require("../renderer/settings-schema");

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

/*
 * Magnet pre-parse timing.
 *
 * A magnet link carries an infohash and nothing else, so the file list only
 * exists once aria2 has met a peer and pulled the info dictionary down. DHT
 * lookup plus the first peer handshake is routinely several seconds and can be
 * much longer on a cold table, which is why the window shows an indeterminate
 * bar rather than a percentage.
 *
 * 30 seconds is the ceiling before the window offers the degraded path
 * ("create without choosing files"). The limit is not about how long a
 * resolution may take -- it may take longer and still succeed -- it is about
 * how long a person will look at a spinner before deciding the window is
 * broken.
 */
const PREPARSE_TIMEOUT_MS = 30000;
const PREPARSE_POLL_MS = 500;

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

/*
 * Whether a path is worth trying to execute.
 *
 * `fs.constants.X_OK` is checked but is not the whole story: Windows has no
 * executable bit, so the call degenerates to an existence test there and would
 * happily accept a directory. The stat is what rules that out.
 */
function isRunnableFile(candidate) {
    if (!candidate) return false;
    try {
        if (!fs.statSync(candidate).isFile()) return false;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch (err) {
        return false;
    }
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
        this.pan = null;
        this.vipToken = null;
        this.pluginHost = null;
        /*
         * The settings store and the bridge from it to the engine.
         *
         * The store's path is injected rather than resolved here: a packaged
         * app must write under `app.getPath("userData")` and this file has no
         * `electron`. A null path keeps the store in memory, which is what a
         * test boot and a headless run want -- nothing is written unless a
         * caller asked for a file.
         */
        this.configPath = opts.configPath || null;
        this.setLoginItem = opts.setLoginItem || (() => {});
        this.configStore = null;
        this.configHandler = null;

        this.plugins = new Map();
        // Views a plugin asked for before a renderer existed to mount them.
        this.pendingWebviews = [];
        /*
         * The files a "take back to local" request is holding.
         *
         * The original keeps this on the drive store (`state.drive.toFetchBackList`)
         * and reads it back from the take-back popup through
         * `GetFetchBackFiles` (app.js@2118077). This build has no separate
         * popup, but the names are the contract's, so the list lives here and
         * the two server functions read and drain it.
         */
        this.fetchBackList = [];
        /*
         * The save directory the user last committed a task to.
         *
         * Held in memory only, like the task table and for the same reason:
         * this build has no persistence layer. The effect is that the dialog
         * remembers the folder for the rest of the session, which is the part
         * of "remember my last folder" a user actually notices.
         */
        this.lastDownloadDir = "";
        /** The magnet pre-parse in flight, if any: { url, startedAt }. */
        this._preparse = null;
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

        // 1b. Settings store --------------------------------------------------
        // Before the engine, because the engine's working directory and the
        // default save folder are both settings, and reading them after the
        // engine exists would mean starting with the wrong one.
        this._createConfigStore();

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

        // 2b. Settings -> engine ----------------------------------------------
        // After the kernel, because the handler pushes options into the engine
        // and the engine is what the kernel holds.
        this._createConfigHandler(engine);

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

        // 4. Cloud-drive client ------------------------------------------------
        // Built after login because it reads its identity from it, and kept in
        // the main process because that is where the session material lives.
        // The drive's own calls are made from here rather than from the page,
        // so a renderer never has to be handed a cookie.
        this.pan = new PanClient({
            getSession: () => this.panSession(),
            log: (...a) => this.log.information("pan", ...a),
        });

        // 5. VIP token client -------------------------------------------------
        this.vipToken = new VipTokenClient({
            callServerFunction: (name, ...args) =>
                this.mesh.main.callServerFunction(name, ...args),
            getBuildNo: () => buildNumberOf(this.config.clientVersion),
        });

        // 6. Plugin host ------------------------------------------------------
        // Built before plugins load so that a plugin's registration calls have
        // somewhere to land, but nothing is loaded yet: plugins expect a fully
        // wired context and the session may still be restoring.
        this.pluginHost = new PluginHost({
            mesh: this.mesh,
            log: (...a) => this.log.information(...a),
        });

        // 7. Restore the previous session -------------------------------------
        await this._restoreSession();

        // 8. Anonymous fallback -----------------------------------------------
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

            /*
             * Login actions, called by the login screen.
             *
             * These are thin on purpose. Every one of them hands off to a
             * method that already existed on the login client -- the UI is a
             * new caller, not a new implementation. The four that have no
             * recovered protocol answer with the gap rather than a plausible
             * looking stub, because a stub here would sign a user in to
             * nothing.
             */
            [F.LOGIN_WITH_KEY]: fromPlugin(async (credential) =>
                this.loginWithCredential(credential)),
            [F.REFRESH_USER_INFO]: fromPlugin(async () => this.refreshUserInfo()),
            [F.LOGOUT]: fromPlugin(async () => this.onLogout()),
            [F.GET_LOGIN_QRCODE]: fromPlugin(async () => this.getLoginQRCode()),
            [F.CHECK_LOGIN_QRCODE]: fromPlugin(async (id) => this.checkLoginQRCode(id)),
            [F.SEND_PHONE_CODE]: fromPlugin(async (phone, verifyCode) =>
                this.sendPhoneCode(phone, verifyCode)),
            [F.LOGIN_WITH_PHONE]: fromPlugin(async (credential) =>
                this.loginWithPhone(credential)),

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

            /*
             * Task mutations.
             *
             * The renderer arrives through the same transport as a plugin, so
             * these carry the same two leading context arguments and are
             * wrapped the same way. Nothing is projected on the way out: the
             * kernel's task objects are plain data, and a copy would stop the
             * renderer's own merging from lining up with the events, which
             * carry the kernel's fields verbatim.
             */
            [F.CREATE_NEW_TASK]: fromPlugin(async (spec) => this.kernel.addTask(spec || {})),
            [F.PAUSE_TASK]: fromPlugin(async (taskId) => this.kernel.pauseTask(taskId)),
            [F.RESUME_TASK]: fromPlugin(async (taskId) => this.kernel.startTask(taskId)),
            [F.DELETE_TASK]: fromPlugin(async (taskId) => this.kernel.removeTask(taskId)),
            [F.GET_TASK_BASE_INFO]: fromPlugin(async (taskId) => this.kernel.getTask(taskId)),
            [F.GET_ALL_TASK_BASE_INFO]: fromPlugin(async () => this.kernel.getAllTasks()),

            /*
             * The new-task window's two engine-facing calls.
             *
             * `PreDownload` is not a download: it is the metadata step, which
             * only a magnet link needs. `CreateNewTaskEx` is the create that
             * can carry a file selection. Both are registered here rather than
             * beside the window because they are engine work, and the window
             * is a caller like any other.
             */
            [F.PRE_DOWNLOAD]: fromPlugin(async (spec, dir) => this.preDownload(spec, dir)),
            [F.PRE_DOWNLOADING]: fromPlugin(async () => this.isPreDownloading()),
            [F.CREATE_NEW_TASK_EX]: fromPlugin(async (spec, indices) =>
                this.createTaskEx(spec, indices)),

            /*
             * Cloud drive.
             *
             * The first two are the window's calls: list a folder, and take
             * one file back to local. Both return a plain result object rather
             * than throwing, because the drive's 401 has two meanings
             * (`not_logged_in` and `session_expired`) and a thrown error loses
             * the code on the way through the transport. The window branches
             * on `ok` and reads `code` for the wording.
             *
             * The rest are the original's own names (contract section "pan").
             * `ExternalFetchBack` is the web/clipboard entry point: it queues
             * the files and opens the browser; `GetFetchBackFiles` hands the
             * queue to whoever asks; `IpcStartRetrieval` drains it into real
             * downloads. `IpcSetRecentFolder` records the save directory.
             */
            [F.PAN_LIST_FILES]: fromPlugin(async (options) => this.panListFiles(options)),
            [F.PAN_DOWNLOAD_FILE]: fromPlugin(async (spec) => this.panDownloadFile(spec)),
            [F.GET_FETCH_BACK_FILES]: fromPlugin(async () => this.fetchBackList.slice()),
            [F.IPC_START_RETRIEVAL]: fromPlugin(async (dir) => this.startRetrieval(dir)),
            [F.EXTERNAL_FETCH_BACK]: fromPlugin(async (data) => this.externalFetchBack(data)),
            [F.EXTERNAL_FETCH_BACK_BY_ID]: fromPlugin(async (fileId) =>
                this.panDownloadFile({ fileId })),
            [F.IPC_SET_RECENT_FOLDER]: fromPlugin(async (dir) => this.setRecentFolder(dir)),

            /*
             * Settings.
             *
             * The read/write pair is the original's `GetConfigValue` /
             * `SetConfigValue`. `GetConfigValue` with no arguments answers the
             * whole flat map, which is what the settings page needs to paint
             * itself in one round trip; with a section and key it answers one
             * value, which is the original's shape and what a plugin would
             * call.
             *
             * `SetConfigValue` returns whether anything changed rather than
             * the stored value: the store is the source of truth, and the
             * engine action (if any) is taken by `ConfigHandler`, which is
             * subscribed to the same store. The page therefore does not have
             * to know which settings touch aria2.
             */
            [F.GET_CONFIG_VALUE]: fromPlugin(async (section, key) =>
                this.getConfigValue(section, key)),
            [F.SET_CONFIG_VALUE]: fromPlugin(async (section, key, value) =>
                this.setConfigValue(section, key, value)),
            [F.SAVE_CONFIG]: fromPlugin(async () => this.saveConfig()),
            [F.GET_SETTINGS_SCHEMA]: fromPlugin(async () => this.getSettingsSchema()),
        });
    }

    /**
     * Build the settings store.
     *
     * Defaults come from the schema, so a fresh install has every key without
     * a file existing. With a path, the file is read and its values overlaid;
     * without one the store is memory-only.
     */
    _createConfigStore() {
        this.configStore = new ConfigStore({
            path: this.configPath,
            schema: settingsSchema.SETTINGS_SCHEMA,
            log: (...a) => this.log.information("config", ...a),
        });
        return this.configStore;
    }

    /**
     * Build the settings-to-engine bridge.
     *
     * Two listeners are attached and their order matters only in that both
     * must be present: the handler is what turns a change into an engine
     * action, and the second listener is what tells every window the value
     * moved. The notification goes through the mesh rather than through a
     * window, because the settings page may not be the only reader.
     */
    _createConfigHandler(engine) {
        this.configHandler = new ConfigHandler({
            config: this.configStore,
            engine: engine || null,
            setLoginItem: this.setLoginItem,
            log: (...a) => this.log.information("config-handler", ...a),
        });
        this.configHandler.attach();

        this.configStore.attachListener((section, key, value) => {
            this.mesh.renderer
                .fireServerEvent(contract.NATIVE_EVENTS.ON_CONFIG_VALUE_CHANGED, [
                    { section, key, value },
                ])
                .catch((err) => this.log.warning("config event forward failed:", err.message));
        });

        // The engine is already starting, and this waits for it rather than
        // assuming it is up; a failure is logged and the boot continues.
        Promise.resolve(this.configHandler.applyAll()).catch((err) => {
            this.log.warning("applying settings to the engine failed:", err.message);
        });
        return this.configHandler;
    }

    /**
     * Build the download engine, or return null to let the kernel use its
     * stub.
     *
     * aria2 is shipped alongside the app rather than found on PATH, because a
     * user-installed aria2 will not have the Turbo patches and would silently
     * clamp the connection count. So the search is: explicit config, then the
     * locations the packaging step uses.
     *
     * A configured path is the whole answer, and is not a first candidate.
     * Falling through to the bundled locations when it is missing turns a
     * configuration error into a silent switch of engine, and the two engines
     * differ in ways that matter -- the bundled one carries the Turbo patches,
     * and only one of them can actually boot. A caller who names a binary gets
     * that binary or gets the stub, which is visible, and never a third thing
     * they did not ask for.
     */
    _createEngine() {
        const configured = this.config.aria2Path;
        const name = process.platform === "win32" ? "aria2c.exe" : "aria2c";

        const candidates = configured
            ? [configured]
            : [
                  path.join(APP_ROOT, "bin", name),
                  path.join(APP_ROOT, "vendor", "aria2", name),
                  path.join(process.resourcesPath || "", "bin", name),
              ];

        let binary = "";
        for (const candidate of candidates) {
            if (isRunnableFile(candidate)) {
                binary = candidate;
                break;
            }
        }

        if (!binary) {
            if (configured) {
                this.log.warning(
                    `the configured aria2 path does not exist: ${configured}; ` +
                        `downloads are stubbed`
                );
            } else {
                this.log.information("no aria2 binary found; downloads are stubbed");
            }
            return null;
        }

        // The settings file's 下载目录 wins over the app config's, and both
        // fall back to ~/ThunderX: a user who picked a folder in the settings
        // window expects it to be where downloads land.
        const settingsDir = this.configStore
            ? this.configStore.getValue("TaskDefaultSettings", "DefaultPath", "")
            : "";

        const engine = new Aria2Engine({
            binary,
            workDir: settingsDir || this.config.downloadDir || path.join(os.homedir(), "ThunderX"),
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

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /**
     * Read one setting, or all of them.
     *
     * The no-argument form is the page's: it needs the whole map to draw the
     * form, and asking 75 times would be 75 round trips for one screen. The
     * (section, key) form is the original's `Config.getValue`.
     *
     * With no store -- which happens only when a caller built an Application
     * without a config path and asked anyway -- the answer is an empty map
     * rather than an error, because "nothing is configured" is the truthful
     * reading and a thrown error would read as a broken settings page.
     */
    getConfigValue(section, key) {
        if (!this.configStore) return section ? undefined : {};
        if (section === undefined || section === null || section === "") {
            return this.configStore.flat();
        }
        return this.configStore.getValue(section, key);
    }

    /** Store one setting. @returns {boolean} whether it changed. */
    setConfigValue(section, key, value) {
        if (!this.configStore) return false;
        return this.configStore.setValue(section, key, value);
    }

    /** Write the pending changes out now (the page's 保存 button). */
    saveConfig() {
        return this.configStore ? this.configStore.save() : false;
    }

    /**
     * The schema the settings page renders, with `section`/`key` filled in.
     *
     * Annotated here rather than in the page so the "split on the first
     * hyphen" rule has exactly one implementation.
     */
    getSettingsSchema() {
        return settingsSchema.annotate();
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

    /**
     * Complete an interactive login from a credential.
     *
     * Three credential shapes arrive here, one per login tab:
     *   - `{ userName, passWord }`  account + password (v3 `login`)
     *   - `{ loginkey, userid }`    a credential someone else obtained
     *   - anything else             rejected, rather than sent on half-formed
     *
     * The password shape is the one the original calls "account login": the
     * client posts the password, the server answers with a loginkey, and the
     * loginkey is then exchanged for a session. The recovered spec carries the
     * whole sequence (LOGIN_PROTOCOL_SPEC.md section 4), so there is no
     * missing asset here any more -- the earlier note claiming the step lived
     * in the qLogin bundle was wrong (spec section 5).
     *
     * Order matters and is enforced by `_completeInteractiveLogin`: the
     * session has to exist before the profile can be fetched, and the profile
     * before the kernel is told which membership to accelerate for.
     */
    async loginWithCredential(credential) {
        const cred = credential || {};
        const password = cred.passWord !== undefined ? cred.passWord : cred.password;

        if (password !== undefined && password !== null && password !== "") {
            await this.login.loginWithPassword({
                userName: String(cred.userName || cred.userid || ""),
                passWord: String(password),
                verifyCode: cred.verifyCode ? String(cred.verifyCode) : "",
            });
        } else if (cred.loginkey) {
            await this.login.loginWithKey({
                loginkey: String(cred.loginkey),
                userid: String(cred.userid || ""),
                usernick: String(cred.usernick || ""),
            });
        } else {
            throw new Error("请输入账号和密码");
        }

        return this._completeInteractiveLogin();
    }

    /**
     * The tail every interactive path shares: profile, kernel, keepalive,
     * token.
     *
     * The token exchange is best effort and deliberately after the login is
     * already live. A token the account center will not issue must not roll
     * back a session that is otherwise usable; the VIP paths report their own
     * failure.
     */
    async _completeInteractiveLogin() {
        await this.onLoginSucceeded();
        try {
            await this.login.exchangeSessionForToken();
        } catch (err) {
            this.log.warning("token exchange failed:", err.message);
        }
        return {
            ok: true,
            userId: this.login.userId,
            nickname: this.login.nickname,
        };
    }

    /*
     * The three interactive paths.
     *
     * All three are implemented against the recovered protocols
     * (LOGIN_PROTOCOL_SPEC.md sections 2A, 3 and 4); none of them is a stub.
     * They are thin because the work lives in the login client -- these
     * methods exist to own the ordering and to translate the client's shapes
     * into what the login screen renders.
     */

    /**
     * Mint a device code and render it as a QR image.
     *
     * The QR payload is a URL, so the image is produced here (the renderer's
     * CSP allows `data:` but not remote images, and the phone scans the
     * picture). A fresh code is minted on every call, which is also what the
     * refresh button needs.
     */
    async getLoginQRCode() {
        const session = await this.login.startScanLogin();
        const image = qrcode.renderDataUrl(session.url, { scale: 4, margin: 4 });
        return {
            id: "scan",
            image: image.dataUrl,
            url: session.url,
            interval: session.interval,
            expiresIn: session.expiresIn,
        };
    }

    /**
     * One poll of the scan. The renderer drives the interval so it can show
     * the intermediate states; see LoginClient.pollScanLogin.
     */
    async checkLoginQRCode() {
        const result = await this.login.pollScanLogin();
        if (result.state === "confirmed") {
            await this._completeInteractiveLogin();
        }
        return result;
    }

    /**
     * Send an SMS code. A captcha challenge comes back as
     * `{ captchaRequired: true }` rather than as a failure, because the UI has
     * to render an input and retry rather than show an error.
     */
    async sendPhoneCode(phone, verifyCode) {
        return this.login.sendSmsCode(String(phone || ""), verifyCode || "");
    }

    /** Verify the SMS code and finish the login. */
    async loginWithPhone(credential) {
        const cred = credential || {};
        await this.login.loginWithSmsCode({
            phone: String(cred.phone || ""),
            code: String(cred.code || ""),
            verifyCode: cred.verifyCode ? String(cred.verifyCode) : "",
        });
        return this._completeInteractiveLogin();
    }

    /**
     * Re-read the profile and report what the account area draws.
     *
     * A projection rather than the raw response: the renderer shows a nickname
     * and a tier, and handing it the whole profile would make it depend on the
     * account system's field names.
     */
    async refreshUserInfo() {
        if (!(await this.login.isLogined())) {
            return { ok: false, loggedIn: false };
        }
        await this.login.fetchUserInfo();
        this._pushVipToKernel();
        return this.userSummary();
    }

    /** The flat shape the account area renders. */
    userSummary() {
        const info = this.login.userInfo || {};
        const vip = this.login.vipInfo || {};
        return {
            ok: true,
            loggedIn: true,
            userId: this.login.userId || "",
            nickname: this.login.nickname || info.nickName || info.usernick || "",
            isVip: !!vip.isVip,
            vipType: vip.vipType || "",
            vipLevel: vip.vipLevel || 0,
        };
    }

    /** Called after a successful interactive login. */
    async onLoginSucceeded() {
        await this.login.fetchUserInfo();
        this._pushVipToKernel();
        this.login.startKeepalive(
            () => this.emit("session-expired"),
            (msg) => this.emit("session-kickout", msg)
        );
        this._fireLoginEvent(contract.NATIVE_EVENTS.ON_LOGIN_SUC, [
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
        this._fireLoginEvent(contract.NATIVE_EVENTS.ON_LOGOUT, [""]);
    }

    /**
     * Deliver a login event to both audiences.
     *
     * They listen on different nodes and neither one forwards to the other:
     * plugins attach to `main` (see plugin-host), and the window's renderer
     * attaches to `renderer` (see electron-main). Firing on `main` alone
     * reaches the plugins and leaves the account area showing a stale name,
     * which is exactly what it did before this was split out. Both have to be
     * addressed explicitly, so the pair lives in one place.
     */
    _fireLoginEvent(name, args) {
        this.mesh.main.fireServerEvent(name, args);
        this.mesh.renderer.fireServerEvent(name, args);
    }

    // -----------------------------------------------------------------------
    // Task creation for the new-task window
    // -----------------------------------------------------------------------

    /**
     * Resolve a magnet link's file list before the download is committed.
     *
     * A magnet link is an infohash, not a download: aria2 has no file names,
     * no sizes and no total length until it has fetched the info dictionary
     * from a peer. The user cannot choose files until that has happened, so
     * this waits for it and hands back the list.
     *
     * Two things about the shape are deliberate:
     *
     *   1. The task is created for real, through the kernel. The file list has
     *      to be read off an aria2 gid, and `select-file` later applies to
     *      that same gid -- there is no way to "look without creating". The
     *      cost is that cancelling the dialog leaves one paused task behind,
     *      which the user can delete; the alternative was a second copy of the
     *      download and a file selection that applied to neither.
     *
     *   2. It is added *active* and paused once the metadata lands, which is
     *      the opposite of what "pre-parse without downloading" suggests. A
     *      task added paused never contacts a peer, so its metadata never
     *      arrives and the wait could only ever time out. The window between
     *      the metadata arriving and the pause is one poll interval, which is
     *      the most that can be done without aria2's metadata-only mode.
     *
     * @param {object|string} spec `{ url }` for a magnet or a .torrent URL,
     *                             `{ torrentPath }` for a local .torrent file
     * @param {string} [dir]
     * @returns {Promise<object>} `{ ok, taskId, files, ... }`, or
     *          `{ ok: false, reason }` with `reason` one of
     *          "empty" / "engine-unavailable" / "timeout".
     */
    async preDownload(spec, dir) {
        // A bare string is accepted so the window can send the common case
        // without wrapping it, and so a caller reading the original's
        // `PreDownload(url)` signature is not surprised.
        const source = typeof spec === "string" ? { url: spec } : spec || {};
        const url = source.url || "";
        const torrentPath = source.torrentPath || "";
        if (!url && !torrentPath) return { ok: false, reason: "empty" };
        if (dir) this.lastDownloadDir = dir;

        const engine = this.kernel.engine;
        // Checked before the task exists: with the stub engine there is
        // nothing to ask, and creating a task that can never resolve would
        // leave the list showing a download nobody asked for.
        if (typeof engine.describe !== "function") {
            return { ok: false, reason: "engine-unavailable" };
        }

        this._preparse = { url: url || torrentPath, startedAt: Date.now() };
        /*
         * A local .torrent already carries the file list, so it can be added
         * paused -- nothing has to be fetched for the metadata to exist. A
         * magnet is the other way round and is added active for the reason
         * given above.
         */
        const taskId = this.kernel.addTask({
            url,
            torrentPath,
            dir,
            startNow: torrentPath ? false : true,
        });

        try {
            const deadline = Date.now() + PREPARSE_TIMEOUT_MS;
            for (;;) {
                const detail = await engine.describe(taskId).catch(() => null);
                if (detail && (detail.btTitle || detail.totalSize > 0)) {
                    // Hold it: nothing should be written while the user is
                    // choosing, and the selection only takes effect on a task
                    // that is not running.
                    if (typeof engine.pause === "function") {
                        await engine.pause(taskId);
                    }
                    return {
                        ok: true,
                        taskId,
                        title: detail.btTitle || "",
                        infoId: detail.infoId || "",
                        totalSize: detail.totalSize || 0,
                        files: detail.files || [],
                    };
                }
                if (Date.now() > deadline) {
                    this.log.warning("magnet pre-parse timed out");
                    // The task stays as it is -- active, with no metadata yet.
                    // Removing it would throw away a resolution that may still
                    // be about to succeed, and the window offers to keep it.
                    return { ok: false, reason: "timeout", taskId };
                }
                await new Promise((resolve) => setTimeout(resolve, PREPARSE_POLL_MS));
            }
        } finally {
            this._preparse = null;
        }
    }

    /**
     * Whether a magnet pre-parse is in flight.
     *
     * The recovered material lists `PreDownloading` next to `PreDownload`
     * without recording what it answers (IPC_CONTRACT.md:256), so this is the
     * reading that needs no invention: the question a caller can ask about a
     * running pre-parse is whether there is one. It exists so the name is live
     * rather than a string that resolves to null.
     */
    isPreDownloading() {
        return !!this._preparse;
    }

    /**
     * Create a task, optionally restricting a torrent to chosen files.
     *
     * Two cases, and the difference matters:
     *
     *   - The spec carries a `taskId` from a pre-parse. That task already
     *     exists and holds the metadata the user just looked at, so it is
     *     adopted rather than re-created. Creating a second one would leave
     *     the paused original in the list and apply the selection to neither.
     *
     *   - There is no `taskId`: a plain link, or a torrent that was not
     *     pre-parsed. When files were chosen it is created paused and resumed
     *     after the selection lands, because aria2 only honours `select-file`
     *     on a task that is not running.
     *
     * @param {object} spec     the engine's task spec, plus optional `taskId`
     * @param {number[]} [indices] aria2's 1-based `files[].index` values
     * @returns {Promise<string>} the task id
     */
    async createTaskEx(spec, indices) {
        const source = spec || {};
        if (source.dir) this.lastDownloadDir = source.dir;

        const engine = this.kernel.engine;
        const selection = Array.isArray(indices)
            ? indices.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
            : [];
        const wantsStart = source.startNow !== false;
        const canSelect = selection.length > 0 && typeof engine.selectFiles === "function";

        if (source.taskId && this.kernel.getTask(source.taskId)) {
            const taskId = source.taskId;
            if (canSelect) await engine.selectFiles(taskId, selection);
            if (wantsStart) this.kernel.startTask(taskId);
            else this.kernel.pauseTask(taskId);
            return taskId;
        }

        const taskId = this.kernel.addTask(
            Object.assign({}, source, { startNow: canSelect ? false : wantsStart })
        );
        if (canSelect) {
            await engine.selectFiles(taskId, selection);
            if (wantsStart) this.kernel.startTask(taskId);
        }
        return taskId;
    }

    // -----------------------------------------------------------------------
    // Cloud drive
    // -----------------------------------------------------------------------

    /**
     * The identity the drive client authenticates with.
     *
     * Read fresh on every call rather than captured once, because the drive
     * client is built at boot and the session arrives later. `deviceId` is the
     * device signature, which is the value the original's own
     * `GetDeviceIdOfWebSDKPlugin` hands the plugin; `numericVersion` is the
     * bare build number the header wants (`12.1.2.2662` -> `2662`).
     *
     * The cookie is written by the login client: every login call now runs
     * through a cookie jar, and the session cookie the account system sets is
     * handed over here under `pan-cookie` (LoginClient._persistPanCookie).
     * Before that the jar did not exist, nothing stored a cookie, and the
     * drive could only ever answer 401.
     */
    panSession() {
        const peerId = this.getPeerId();
        return {
            userId: this.login.userId || "",
            sessionId: this.login.sessionId || "",
            peerId,
            tpPeerId: peerId,
            deviceId: this.login.deviceSign || "",
            numericVersion: buildNumberOf(this.config.clientVersion),
            cookie: this.store.get("pan-cookie") || "",
        };
    }

    /** A failed drive call as the plain result object the window reads. */
    _panFailure(err) {
        return {
            ok: false,
            code: (err && err.code) || PAN_ERROR.NETWORK,
            message: (err && err.message) || "云盘请求失败",
        };
    }

    /**
     * List one folder of the drive.
     *
     * Returns `{ ok, files, nextPageToken }` or `{ ok: false, code, message }`.
     * The window draws one page and follows the token itself, which is why the
     * token is surfaced rather than looped over here.
     */
    async panListFiles(options) {
        const o = options || {};
        try {
            const page = await this.pan.listFiles({
                parentId: o.parentId || "",
                pageToken: o.pageToken || "",
                limit: o.limit || 100,
            });
            return { ok: true, files: page.files, nextPageToken: page.nextPageToken };
        } catch (err) {
            return this._panFailure(err);
        }
    }

    /**
     * Take one drive file back to local.
     *
     * This is the client half of the original's
     * `addOrRefreshServerAndToken` (app.js@204300): resolve the direct link,
     * then hand it to the kernel. The original creates a P2sp task with an
     * empty URL and back-fills it with `SetTaskUrl`; aria2 has no such split,
     * so the link goes in at creation.
     *
     * The result carries the link's `expire` and `token` even though the
     * engine ignores them today. They are what a link refresh would need (the
     * original re-fetches 300 seconds before `expire`, app.js@201577), and
     * dropping them here would leave a long download unrefreshable with
     * nothing to point at.
     *
     * @returns {Promise<object>} `{ ok, taskId, name, url, expire, token }`
     */
    async panDownloadFile(spec) {
        const s = spec || {};
        if (!s.fileId) {
            return { ok: false, code: PAN_ERROR.NOT_FOUND, message: "缺少 fileId" };
        }

        let link;
        try {
            link = await this.pan.resolveDirectLink({
                fileId: s.fileId,
                shareId: s.shareId || "",
                passCodeToken: s.passCodeToken || "",
                gcid: s.hash || "",
                fileName: s.name || "",
                mimeType: s.mimeType || "",
                isSuperMember:
                    !!(this.login.vipInfo && this.login.vipInfo.vipType === "super"),
            });
        } catch (err) {
            return this._panFailure(err);
        }

        // The drive's own name wins: it is the real file name, and a caller's
        // copy may be a display label. Path separators are stripped so a name
        // cannot point the engine outside the save directory.
        const name = String(link.name || s.name || "").replace(/[\\/]+/g, "_");
        const taskId = this.kernel.addTask({
            url: link.url,
            dir: s.dir || this.lastDownloadDir || undefined,
            out: name || undefined,
        });

        return { ok: true, taskId, name, url: link.url, expire: link.expire, token: link.token };
    }

    /**
     * Queue files for take-back (the original's `drive/fetchBackFiles`).
     *
     * The original pops a window here to pick a save directory. This build has
     * no such popup, so the files are queued and the browser window is asked
     * to open; the actual download happens in `startRetrieval`.
     */
    externalFetchBack(data) {
        const d = data || {};
        const files = Array.isArray(d.files) ? d.files : [];
        const shared = {
            shareId: d.shareId || "",
            passCodeToken: d.passCodeToken || "",
            userId: d.userId || "",
            shareUserId: d.shareUserId || "",
            from: d.from || "",
        };
        for (const file of files) {
            this.fetchBackList.push(
                Object.assign({}, shared, {
                    fileId: file.id || file.fileId || "",
                    name: file.name || "",
                    size: Number(file.size || 0),
                    hash: file.hash || file.gcid || "",
                    mimeType: file.mime_type || file.mimeType || "",
                })
            );
        }
        // The window is a main-process concern; the application only asks for
        // it. A listener in electron-main answers; with no listener the queue
        // still fills and `GetFetchBackFiles` still returns it.
        this.emit("open-pan-window");
        return { ok: true, count: this.fetchBackList.length };
    }

    /**
     * Drain the queue into real downloads (the original's
     * `retrieval-list/startRetrieval`). `dir` is the chosen save directory.
     */
    async startRetrieval(dir) {
        const files = this.fetchBackList.slice();
        this.fetchBackList = [];

        const results = [];
        for (const file of files) {
            results.push(await this.panDownloadFile(Object.assign({}, file, { dir })));
        }
        const added = results.filter((r) => r.ok).length;
        return { ok: added === results.length, added, failed: results.length - added, results };
    }

    /** Remember the last save directory the drive window used. */
    setRecentFolder(dir) {
        if (dir) this.lastDownloadDir = String(dir);
        return { ok: true, dir: this.lastDownloadDir };
    }

    async stop() {
        if (this._anonymousTimer) clearTimeout(this._anonymousTimer);
        // A pending settings edit is written before the process goes away; the
        // five-second delay is a write-coalescing policy, not a reason to lose
        // the last change on quit.
        if (this.configHandler) this.configHandler.detach();
        if (this.configStore) this.configStore.flush();
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
