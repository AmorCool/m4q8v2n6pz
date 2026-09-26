/**
 * Plugin host.
 *
 * The shipped plugins are plain webpack bundles that expect a small set of
 * globals to exist before they run, and that start by calling
 * `client.start({name, version}, "thunder")`. They do not export a factory
 * and they do not take arguments -- they read their wiring off `global`.
 *
 * That shapes this file. The host has to provide those globals, in the same
 * order and with the same names, and then load the bundle for its side
 * effects. Anything else would require editing the plugins, which is exactly
 * what we are trying to avoid: an unmodified plugin is proof the contract is
 * right.
 *
 * Globals observed in the shipped bundles:
 *
 *   global.__rootDir              directory of the plugin's entry file
 *   global.__processName          "main" for the main-process side
 *   global.__xdasIPCServer        server-side RPC endpoint
 *   global.__xdasIPCClienInstance client-side RPC endpoint
 *   global.__xdasPluginConfig     the plugin's config.json
 *   global.__xdasObjectLiftMonitor  leak instrumentation, may be absent
 *   global.AsyncGetNativeCallModuleObj  callback-style native module getter
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Module = require("module");

const contract = require("./contract");

/**
 * Manages the globals a plugin bundle expects.
 *
 * The set is global, not per plugin, because that is how the original does
 * it: plugins overwrite each other's entries and rely on the value being
 * present at load time. Restoring the previous values afterwards keeps two
 * plugins from leaking their root directory into each other.
 */
class PluginEnvironment {
    constructor() {
        this._saved = null;
    }

    /**
     * Install the expected globals.
     *
     * @param {object} options
     * @param {string} options.rootDir     plugin directory
     * @param {string} options.pluginName
     * @param {object} options.ipcServer
     * @param {object} options.ipcClient
     * @param {object} options.pluginConfig
     */
    install(options) {
        if (this._saved) this.restore();

        const names = [
            "__rootDir",
            "__processName",
            "__xdasIPCServer",
            "__xdasIPCClienInstance",
            "__xdasPluginConfig",
            "__xdasObjectLiftMonitor",
            "AsyncGetNativeCallModuleObj",
            "AsyncGetNativeCallModuleObjSync",
        ];

        this._saved = new Map();
        for (const name of names) {
            this._saved.set(name, {
                existed: Object.prototype.hasOwnProperty.call(global, name),
                value: global[name],
            });
        }

        global.__rootDir = options.rootDir;
        // Plugins branch on this to decide whether they are the main-process
        // half or a renderer half. "main" is the correct choice here.
        global.__processName = "main";
        global.__xdasIPCServer = options.ipcServer;
        global.__xdasIPCClienInstance = options.ipcClient;
        global.__xdasPluginConfig = options.pluginConfig;

        if (global.__xdasObjectLiftMonitor === undefined) {
            global.__xdasObjectLiftMonitor = null;
        }

        const self = this;
        global.AsyncGetNativeCallModuleObj = function (callback) {
            // The original runs this asynchronously and hands the caller a
            // module bag. The plugins call it once at startup and capture the
            // result in a closure, so resolving on the next tick matches the
            // timing they were written against.
            setImmediate(() => callback(self.moduleBag(options)));
        };
        global.AsyncGetNativeCallModuleObjSync = function () {
            return self.moduleBag(options);
        };

        return this.moduleBag(options);
    }

    /**
     * The object handed to plugins through the native-module callback.
     *
     * Only `nativeCall` is used by the plugins looked at so far; it is where
     * they reach for native window operations and events.
     */
    moduleBag(options) {
        const bag = this._bag || (this._bag = {});
        bag.nativeCall = bag.nativeCall || createNativeCallFacade(options);
        return bag;
    }

    /** Put the globals back the way they were. */
    restore() {
        if (!this._saved) return;
        for (const [name, entry] of this._saved) {
            if (entry.existed) {
                global[name] = entry.value;
            } else {
                delete global[name];
            }
        }
        this._saved = null;
    }
}

/**
 * Stand-in for the native call surface.
 *
 * Every method is a no-op that still invokes its trailing callback, because
 * the plugins treat the callback as the completion signal rather than the
 * return value. Swallowing the callback would stall plugin startup, which is
 * a much louder failure than a missing side effect.
 */
function createNativeCallFacade(options) {
    const log = (options && options.log) || (() => {});

    /**
     * Find the last function in an argument list and call it.
     * Plugins put the callback in different positions per method, so the
     * only reliable rule is "the last function wins".
     */
    function complete(args, value) {
        for (let i = args.length - 1; i >= 0; i--) {
            if (typeof args[i] === "function") {
                args[i](null, value);
                return;
            }
        }
    }

    return new Proxy(
        {},
        {
            get(_target, prop) {
                if (prop === "then") return undefined;      // not a promise
                if (typeof prop === "symbol") return undefined;
                return function (...args) {
                    log("nativeCall." + String(prop), args.length);
                    complete(args, null);
                };
            },
        }
    );
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/**
 * Loads plugin bundles into the current process.
 *
 * Loading is done through a fresh `Module` instance rather than `require`,
 * so that the same path can be loaded twice (useful when iterating on a
 * plugin) and so that a plugin's own `require` calls resolve against its own
 * directory rather than this file's.
 */
class PluginHost {
    /**
     * @param {object} deps
     * @param {object} deps.mesh        the RPC mesh from createMesh()
     * @param {function} [deps.log]
     */
    constructor(deps) {
        this.mesh = deps.mesh;
        this.log = deps.log || (() => {});
        this.env = new PluginEnvironment();
        this.loaded = new Map();
    }

    /**
     * Load one plugin directory.
     *
     * @param {string} pluginDir  directory containing config.json
     * @returns {object} the parsed manifest
     */
    load(pluginDir) {
        const manifestPath = path.join(pluginDir, "config.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`no config.json in ${pluginDir}`);
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const entryPath = path.join(pluginDir, manifest.main || "index.js");

        if (!fs.existsSync(entryPath)) {
            throw new Error(`plugin entry not found: ${entryPath}`);
        }

        this.log("loading", manifest.name, manifest.version);

        // Each plugin runs with the globals pointed at its own directory.
        this.env.install({
            rootDir: pluginDir,
            pluginName: manifest.name,
            ipcServer: this._createIpcServer(manifest),
            ipcClient: this._createIpcClient(manifest),
            pluginConfig: manifest,
            log: (...a) => this.log(manifest.name, ...a),
        });

        const exported = this._requireFresh(entryPath);

        this.loaded.set(manifest.name, {
            manifest,
            dir: pluginDir,
            entry: entryPath,
            exported,
        });

        // The bundle is a webpack runtime that executes on load; whatever it
        // wanted to register has been registered by the time we get here.
        this.env.restore();
        return manifest;
    }

    /**
     * Load every plugin found under a directory tree.
     *
     * A plugin that throws is reported and skipped rather than aborting the
     * whole scan: one broken plugin should not stop the others from loading.
     */
    loadAll(pluginsRoot) {
        const results = [];
        if (!fs.existsSync(pluginsRoot)) return results;

        for (const name of fs.readdirSync(pluginsRoot)) {
            const dir = path.join(pluginsRoot, name);
            if (!fs.statSync(dir).isDirectory()) continue;

            // A plugin directory may hold several versions; pick the config
            // at the top level, which is what the original reads.
            try {
                results.push({ name, manifest: this.load(dir) });
            } catch (err) {
                results.push({ name, error: err.message });
                this.log("plugin failed:", name, err.message);
            }
        }
        return results;
    }

    /**
     * The server endpoint a plugin registers itself with.
     *
     * Plugins call `client.start({name, version}, "thunder")` and expect a
     * registration to happen. Reaching the real mesh here is what makes a
     * plugin's `registerFunctions` visible to the rest of the application.
     */
    _createIpcServer(manifest) {
        const mesh = this.mesh;
        return {
            getProductId: () => "thunder",
            getContext: () => ({ name: manifest.name }),
            registerFunctions: (fns) => {
                mesh.main.registerFunctions(fns);
                this.log(manifest.name, "registered", Object.keys(fns || {}).length, "functions");
            },
            callFunctionById: async () => undefined,
            sendAdapter: () => undefined,
            on: () => undefined,
            emit: () => undefined,
        };
    }

    /**
     * The client endpoint a plugin uses to call out.
     *
     * The method set is not guessed: it is the union of every `client.<x>()`
     * call found in the shipped plugins. `User` and `XmpPlugin` exercise the
     * widest surface, and a missing method shows up as a TypeError at plugin
     * start-up rather than as a missing feature, so anything with no
     * meaningful behaviour yet is still present as a no-op.
     *
     * Three of these are load bearing and must not be stubbed out:
     *
     *   - callServerFunction / callRemoteClientFunction: the actual traffic
     *   - attachServerEvent / detachServerEvent: detaching has to really
     *     remove the handler, otherwise a plugin that re-subscribes on every
     *     reconnect accumulates listeners until the process leaks
     *   - isInprocess: plugins branch on this to choose a code path
     *
     * Call arguments are prefixed with the calling context and this plugin's
     * own context object. The shipped handlers are written as
     * `CreateWebview(callerContext, selfContext, ...realArgs)` and read their
     * payload from the third argument onward, so an unprefixed call would
     * hand them `src` where they expect `callerContext`. Prefixing here keeps
     * every caller honest instead of relying on each plugin to remember.
     */
    _createIpcClient(manifest) {
        const mesh = this.mesh;
        const host = this;
        const selfContext = { name: manifest.name };
        const CALLER_CONTEXT = contract.CONTEXTS.MAIN_PROCESS;

        return {
            start: (info, productId) => {
                host.log(manifest.name, "client.start", info && info.name, productId);
                // A plugin may start more than once if it is reloaded; the
                // mesh tolerates re-registration, so no guard is needed here.
                return undefined;
            },
            getContext: () => selfContext,
            isInprocess: () => true,
            registerFunctions: (fns) => mesh.main.registerFunctions(fns),

            callServerFunction: (name, ...args) =>
                mesh.main.callServerFunction.call(
                    mesh.main,
                    name,
                    CALLER_CONTEXT,
                    selfContext,
                    ...args
                ),
            // The plugin-facing client exposes the tuple form too; XmpPlugin
            // uses it where it needs to distinguish a value from an error.
            callServerFunctionEx: (name, ...args) =>
                mesh.main.callServerFunctionEx.call(
                    mesh.main,
                    name,
                    CALLER_CONTEXT,
                    selfContext,
                    ...args
                ),
            callRemoteClientFunction: (context, method, ...args) =>
                mesh.main.callRemoteClientFunction(context, method, ...args),
            isRemoteClientExist: (context) => mesh.main.hasRemote(context),

            broadcastEvent: (name, payload) =>
                mesh.main.broadcastEvent(name, payload),
            attachServerEvent: (name, handler) =>
                mesh.main.attachServerEvent(name, handler),
            detachServerEvent: (name, handler) =>
                mesh.main.detachServerEvent(name, handler),
            emit: (name, payload) => mesh.main.fireServerEvent(name, [payload]),

            // --- message bus -------------------------------------------------
            // The sync module rides an MQTT client that is exposed through
            // this same object. Those calls have no transport here yet, so
            // they accept the call and report success without delivering
            // anything. A plugin that depends on delivery will simply see no
            // messages, which is the correct behaviour while the sync backend
            // is out of scope.
            publish: () => true,
            subscribe: () => true,
            unsubscribe: () => true,
            switchSub: () => true,
            request: () => undefined,
            getLastMessageId: () => 0,
            removeOutgoingMessage: () => undefined,
            setCredentials: () => undefined,
            end: (force, cb) => {
                // The original ends asynchronously and honours a callback,
                // because callers tear down in the callback.
                if (typeof force === "function") force();
                else if (typeof cb === "function") cb();
            },
            terminate: () => undefined,

            send: () => undefined,
            on: () => undefined,
        };
    }

    /**
     * Require a file without the module cache, resolving its own requires
     * relative to itself.
     *
     * `Module.prototype._compile` with an explicit filename is what makes
     * `__dirname` inside the plugin point at the plugin rather than at us --
     * several plugins build paths from it.
     */
    _requireFresh(filePath) {
        const resolved = require.resolve(filePath);
        delete require.cache[resolved];

        const mod = new Module(resolved, null);
        mod.filename = resolved;
        mod.paths = Module._nodeModulePaths(path.dirname(resolved));
        const source = fs.readFileSync(resolved, "utf8");
        mod._compile(source, resolved);
        return mod.exports;
    }

    get(name) {
        return this.loaded.get(name) || null;
    }

    list() {
        return Array.from(this.loaded.keys());
    }
}

module.exports = { PluginHost, PluginEnvironment, createNativeCallFacade };
