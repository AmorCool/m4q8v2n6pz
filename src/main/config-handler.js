/**
 * ConfigHandler -- the settings that reach the download engine.
 *
 * The original's `ConfigHandler` (`main-renderer/renderer.js:72332-72810`) is
 * the one module that turns a stored setting into an engine action. Its table
 * (renderer.js:72337-72448) maps each config section to a handler:
 *
 *     ConfigNormalSession  -> DownloadDispatchNS.setStartTaskCount / setAutoTail
 *     TaskDefaultSettings  -> ThunderKernel.setGlobalConnectionLimit / default dir
 *     ConfigNet            -> DownloadModeNS full/limited, P2P channels
 *     ProxySetting         -> ThunderKernel.setProxy(...)
 *     DiskCache            -> DownloadKernelManager.setCacheSize(...)
 *     ConfigNormalSession.AutoRun -> registry Run key (handleAutoRun, :72716)
 *
 * This build's engine is aria2, so the right-hand column changes but the
 * left-hand column -- which setting means what -- is the same. The translation
 * is where the real work is, and it is the reason this file exists separately
 * from the store: the store must not know about aria2, and the engine must not
 * know about `TaskDefaultSettings-OrignHostThreads`.
 *
 * Only two settings are not engine work at all, and both are called out where
 * they are handled: 开机启动 (the registry in the original, now
 * `app.setLoginItemSettings`) and 完成后动作 (a UI concern).
 *
 * The file holds no `electron`: the one OS-level action is injected.
 */

"use strict";

/** aria2's unlimited sentinel for a numeric option; the original uses the same. */
const UNLIMITED = "4294967295";

/** aria2's default BT listen range when the port is left automatic. */
const BT_AUTO_PORT = "6881-6999";

class ConfigHandler {
    /**
     * @param {object} options
     * @param {object} options.config              a ConfigStore
     * @param {object} [options.engine]            the aria2 engine (or null)
     * @param {function} [options.setLoginItem]    (openAtLogin:boolean) -> void
     * @param {function} [options.log]
     */
    constructor(options) {
        const opts = options || {};
        this.config = opts.config;
        this.engine = opts.engine || null;
        this.setLoginItem = opts.setLoginItem || (() => {});
        this.log = opts.log || (() => {});

        /** The last action recorded for a finished task; read by the UI layer. */
        this.completion = { openFile: false };

        this._detach = null;
    }

    // -----------------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------------

    /** Subscribe to the store, then push the current values once. */
    attach() {
        if (!this.config) return this;
        this._detach = this.config.attachListener((section, key, value) => {
            this.handle(section, key, value);
        });
        return this;
    }

    detach() {
        if (this._detach) this._detach();
        this._detach = null;
    }

    /**
     * Push every engine-relevant setting.
     *
     * Called once at boot after the engine exists. It is not folded into
     * `attach` because the engine starts asynchronously and the options have to
     * wait for it -- `applyGlobalOptions` does that waiting.
     */
    async applyAll() {
        return this._applyGlobal(this.engineOptions());
    }

    // -----------------------------------------------------------------------
    // The mapping table
    // -----------------------------------------------------------------------

    /**
     * One change, dispatched to the section that owns it.
     *
     * Unknown sections are ignored on purpose: the schema has settings that
     * never touch the engine (提醒, 悬浮窗, 云盘), and a default branch that
     * pushed them to aria2 would be inventing behaviour.
     */
    handle(section, key, value) {
        switch (section) {
            case "ConfigNormalSession":
                return this.onConfigNormalSessionChanged(key, value);
            case "TaskDefaultSettings":
                return this.onTaskDefaultSettingsChanged(key, value);
            case "ConfigNet":
                return this.onConfigNetChanged(key, value);
            case "ProxySetting":
            case "ConnectType":
                return this.onProxySettingChanged(key, value);
            case "DiskCache":
                return this.onDiskCacheChanged(key, value);
            case "BtGenericSettings":
                return this.onBtGenericSettingsChanged(key, value);
            default:
                return undefined;
        }
    }

    /**
     * 任务管理 -- how many tasks run at once, and what happens to the rest.
     *
     * `ConfigNormal_MaxRunningTaskCount` is the original's
     * `DownloadDispatchNS.setStartTaskCount`; aria2's equivalent is
     * `max-concurrent-downloads`.
     */
    onConfigNormalSessionChanged(key, value) {
        if (key === "ConfigNormal_MaxRunningTaskCount") {
            return this._applyGlobal({ "max-concurrent-downloads": String(Number(value) || 5) });
        }
        if (key === "ConfigNormal_AutoRun") {
            // The original writes HKCU\...\Run\Thunder (renderer.js:72719).
            // Electron owns that key through setLoginItemSettings, which is
            // injected so this file stays free of `app`.
            this.setLoginItem(!!value);
            return undefined;
        }
        // AutoSlowTask2Tail / AutoDeleteNotExistFile / AutoStartUnFinishedTask
        // are task-list behaviours with no engine option behind them.
        return undefined;
    }

    /**
     * 下载设置 -- connections, the global resource cap, and the default folder.
     *
     * `OrignHostThreads` is "原始地址线程数" (1-10): the number of connections
     * to one origin, which is aria2's `max-connection-per-server`, with `split`
     * kept equal to it so a single file is actually cut into that many pieces
     * (aria2 clamps `split` to the connection count otherwise).
     */
    onTaskDefaultSettingsChanged(key, value) {
        if (key === "OrignHostThreads") {
            const threads = String(Math.max(1, Number(value) || 5));
            return this._applyGlobal({
                "max-connection-per-server": threads,
                split: threads,
            });
        }
        if (key === "MaxResourceLimit" || key === "MaxResourceCount") {
            return this._applyGlobal(this.connectionLimitOptions());
        }
        if (key === "OpenFile") {
            // Recorded rather than pushed: aria2 has no "open when done", and
            // the completion action belongs to whoever handles task-completed.
            this.completion.openFile = !!value;
            return undefined;
        }
        // DefaultPath / UseLastCatalog are read by the application as the
        // default save directory (see defaultDownloadDir); no engine option.
        return undefined;
    }

    /**
     * 下载模式 -- full speed or a ceiling.
     *
     * The original switches `DownloadModeNS` between 全速 and 限速. aria2's
     * equivalent is the two `max-overall-*-limit` options, expressed in KB/s
     * with a `K` suffix (`0` means unlimited, which is how 全速 is written).
     */
    onConfigNetChanged(key, value) {
        if (
            key === "ConfigNet_Type" ||
            key.indexOf("ConfigNet_Custom_") === 0 ||
            key.indexOf("ConfigNet_Open") === 0
        ) {
            if (key.indexOf("ConfigNet_Open") === 0) {
                // 镜像加速 / P2P 加速 are Thunder-side channels; aria2 has no
                // switch for either. Recorded in the log so the gap is visible
                // rather than silently ignored.
                this.log(`no aria2 equivalent for ${key}=${value}`);
                return undefined;
            }
            return this._applyGlobal(this.speedLimitOptions());
        }
        return undefined;
    }

    /**
     * 代理 -- `ProxySetting-ConfigProxy_Type` and the per-protocol rows.
     *
     * aria2 takes one `all-proxy` for every protocol, so the original's three
     * per-protocol selects collapse into one. The proxy address comes from
     * `ConnectType-ProxyName` (`host:port`), which is the only place this build
     * keeps it.
     */
    onProxySettingChanged() {
        return this._applyGlobal(this.proxyOptions());
    }

    /** 下载磁盘缓存 -- `DiskCacheSelect` is a size in MB. */
    onDiskCacheChanged(key, value) {
        if (key !== "DiskCacheSelect") return undefined;
        const mb = Number(value) || 256;
        return this._applyGlobal({ "disk-cache": `${mb}M` });
    }

    /**
     * BT -- the listen port. `SetPortType` 0 means automatic.
     *
     * `AutoBTNewTask` / `AssocTorrent` are shell-integration settings with no
     * engine option.
     */
    onBtGenericSettingsChanged(key, value) {
        if (key === "ConfigBt_SetPortType" || key === "ConfigBt_Manul_TcpPort") {
            return this._applyGlobal(this.btPortOptions());
        }
        return undefined;
    }

    // -----------------------------------------------------------------------
    // Option builders (pure, so they can be asserted without an engine)
    // -----------------------------------------------------------------------

    /** The full option set, composed from the builders below. */
    engineOptions() {
        return Object.assign(
            {},
            this.connectionOptions(),
            this.connectionLimitOptions(),
            this.speedLimitOptions(),
            this.proxyOptions(),
            this.diskCacheOptions(),
            this.btPortOptions()
        );
    }

    /** Per-origin connection count, from `OrignHostThreads`. */
    connectionOptions() {
        const threads = String(Math.max(1, Number(this._get("TaskDefaultSettings", "OrignHostThreads", "5")) || 5));
        return { "max-connection-per-server": threads, split: threads };
    }

    /**
     * The global simultaneous-download cap.
     *
     * Two settings feed it and they overlap: `MaxResourceLimit/Count`
     * ("限制全局最大同时下载资源数", the original's setGlobalConnectionLimit)
     * and `ConfigNormal_MaxRunningTaskCount` ("同时下载的最大任务数", the
     * original's setStartTaskCount). aria2 has one option for the pair, so the
     * more specific one wins when it is on, and turning it off restores the
     * task-count value rather than leaving the cap removed.
     */
    connectionLimitOptions() {
        if (this._get("TaskDefaultSettings", "MaxResourceLimit", false)) {
            const count = String(Math.max(1, Number(this._get("TaskDefaultSettings", "MaxResourceCount", "500")) || 500));
            return { "max-concurrent-downloads": count };
        }
        const tasks = String(Math.max(1, Number(this._get("ConfigNormalSession", "ConfigNormal_MaxRunningTaskCount", "5")) || 5));
        return { "max-concurrent-downloads": tasks };
    }

    /** Download/upload ceilings, or zero (unlimited) when 全速 is selected. */
    speedLimitOptions() {
        const limited = String(this._get("ConfigNet", "ConfigNet_Type", "1")) === "0";
        if (!limited) {
            return { "max-overall-download-limit": "0", "max-overall-upload-limit": "0" };
        }
        const download = this._get("ConfigNet", "ConfigNet_Custom_DownloadSpeedChk", true)
            ? `${Math.max(1, Number(this._get("ConfigNet", "ConfigNet_Custom_MaxDownloadSpeed", "1024")) || 1024)}K`
            : "0";
        const upload = this._get("ConfigNet", "ConfigNet_Custom_UploadSpeedChk", true)
            ? `${Math.max(1, Number(this._get("ConfigNet", "ConfigNet_Custom_MaxUploadSpeed", "1024")) || 1024)}K`
            : "0";
        return { "max-overall-download-limit": download, "max-overall-upload-limit": upload };
    }

    /**
     * The proxy string, or empty to clear it.
     *
     * Type 0 (不使用) clears. Type 2 (自定义) uses `ConnectType-ProxyName`.
     * Type 1 (IE 代理) has no aria2 equivalent -- aria2 does not read the
     * Windows proxy store -- so it is reported as a gap and treated as "no
     * proxy" rather than guessed at.
     */
    proxyOptions() {
        const type = String(this._get("ProxySetting", "ConfigProxy_Type", "0"));
        if (type === "1") {
            this.log("IE proxy is not readable by aria2; no proxy applied");
            return { "all-proxy": "" };
        }
        if (type !== "2") return { "all-proxy": "" };

        const name = String(this._get("ConnectType", "ProxyName", "") || "").trim();
        if (!name) return { "all-proxy": "" };
        // A bare host:port is what the schema asks for; aria2 wants a URL. The
        // scheme test has to allow digits -- `socks5://` is the common case and
        // a letters-only pattern would double-prefix it.
        return { "all-proxy": /^[a-z][a-z0-9+.-]*:\/\//i.test(name) ? name : `http://${name}` };
    }

    /** `disk-cache` in bytes, with the MB suffix aria2 parses. */
    diskCacheOptions() {
        const mb = Number(this._get("DiskCache", "DiskCacheSelect", "256")) || 256;
        return { "disk-cache": `${mb}M` };
    }

    /** BT listen port: automatic range, or the user's number. */
    btPortOptions() {
        const manual = String(this._get("BtGenericSettings", "ConfigBt_SetPortType", "0")) === "1";
        if (!manual) return { "listen-port": BT_AUTO_PORT };
        const port = Number(this._get("BtGenericSettings", "ConfigBt_Manul_TcpPort", "15000")) || 15000;
        return { "listen-port": String(port) };
    }

    // -----------------------------------------------------------------------
    // Values the rest of the application reads
    // -----------------------------------------------------------------------

    /**
     * The default save directory for a new task.
     *
     * `TaskDefaultSettings-DefaultPath` is the original's 下载目录. An empty
     * value means "unset", not "the current directory", so it is returned as an
     * empty string and the caller falls through to its own default.
     */
    defaultDownloadDir() {
        const value = this._get("TaskDefaultSettings", "DefaultPath", "");
        return value ? String(value) : "";
    }

    /** Whether a finished task should be opened. */
    openFileWhenDone() {
        return !!this._get("TaskDefaultSettings", "OpenFile", false);
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    _get(section, key, fallback) {
        return this.config ? this.config.getValue(section, key, fallback) : fallback;
    }

    /**
     * Hand a set of aria2 global options to the engine.
     *
     * The engine call is optional: with no aria2 binary the kernel runs a stub
     * that has no `applyGlobalOptions`, and a settings change must still be
     * stored (and must not throw) in that case.
     */
    _applyGlobal(options) {
        if (!options || !Object.keys(options).length) return undefined;
        if (!this.engine || typeof this.engine.applyGlobalOptions !== "function") {
            this.log("engine cannot apply global options (stub engine)", options);
            return undefined;
        }
        return this.engine.applyGlobalOptions(options).catch((err) => {
            this.log("applyGlobalOptions failed:", err.message, options);
            return undefined;
        });
    }
}

module.exports = { ConfigHandler, UNLIMITED, BT_AUTO_PORT };
