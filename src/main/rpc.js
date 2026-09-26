/**
 * In-process implementation of the client's RPC mesh.
 *
 * The original splits this across three packages:
 *   @xunlei/async-remote   -- the three-role broker (server / client / remote)
 *   @xunlei/node-net-ipc   -- the transport, a newline-delimited JSON stream
 *   Electron ipcMain/ipcRenderer -- inside a single process group
 *
 * This module keeps the observable contract of all three and drops the pipe.
 * Everything runs in one process, which is enough for a desktop client where
 * the renderer and the plugin host are the same application. If a real
 * process boundary is ever needed, the transport can be swapped back in
 * without touching any caller, because callers only ever see:
 *
 *     send event, call function, attach event, broadcast
 *
 * Two semantics from the original are preserved deliberately, because code
 * depends on them:
 *
 *   1. A function call resolves to an ARRAY. Callers routinely write
 *      `(await call(...))[0]`, so returning a bare value would break them.
 *   2. `emit` uses the FIRST listener's return value as the event result and
 *      merely notifies the rest. This is how a single handler can veto or
 *      answer an event that several parties are listening to.
 */

"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");

let seqCounter = 0;

/**
 * Generate the short request id used to correlate a call with its reply.
 *
 * The original uses a per-instance counter rendered in hex. A monotonically
 * increasing counter is what matters -- it has to be unique within one
 * context, not globally, and it shows up in logs as `s_rid`.
 */
function nextRid() {
    seqCounter = (seqCounter + 1) % 0xffffffff;
    return seqCounter.toString(16);
}

/**
 * A participant in the mesh.
 *
 * Roles are named the way the original names them:
 *   server -- answers calls, owns no context of its own
 *   client -- talks to a server over a transport
 *   remote -- a client that can also receive calls back
 *
 * In this in-process version the three collapse into one object, but the
 * method names and the data on the wire stay identical.
 */
class RpcNode extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.context   this node's context name
     * @param {boolean} [options.isServer] true for the answering side
     */
    constructor(options) {
        super();
        this.context = options.context;
        this.isServer = !!options.isServer;

        /** Local functions callable by others: name -> fn */
        this.apis = new Map();
        /** Remote contexts we know about: contextName -> RpcNode */
        this.peers = new Map();
        /** Alias -> context name, used by callRemoteClientFunction */
        this.aliases = new Map();
        /** Outstanding calls awaiting a reply: rid -> {resolve, reject, meta} */
        this.pending = new Map();
        /** Server-event listeners: eventName -> [fn] */
        this.eventHandlers = new Map();

        this.id = `${this.context}-${process.pid}`;
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    /**
     * Publish functions under this node's name.
     * Mirrors `client.registerFunctions({...})`.
     */
    registerFunctions(functions) {
        for (const [name, fn] of Object.entries(functions || {})) {
            if (typeof fn === "function") {
                this.apis.set(name, fn);
            }
        }
    }

    /** Publish a single function. */
    registerFunction(name, fn) {
        this.apis.set(name, fn);
    }

    /** Make another node reachable by context name. */
    attachPeer(node) {
        this.peers.set(node.context, node);
    }

    /** Bind a short alias to a context, for callRemoteClientFunction. */
    registerAlias(alias, contextName) {
        this.aliases.set(alias, contextName);
    }

    hasRemote(contextName) {
        return this.peers.has(this.aliases.get(contextName) || contextName);
    }

    /** Resolve either an alias or a raw context name. */
    _peer(target) {
        const name = this.aliases.get(target) || target;
        return this.peers.get(name);
    }

    // -----------------------------------------------------------------------
    // Outbound: calls
    // -----------------------------------------------------------------------

    /**
     * Call a function on another context and await its reply.
     *
     * Resolves to `[value, undefined]` on success and `[null, message]` on
     * failure, matching the original's tuple convention.
     *
     * @returns {Promise<[any, string|undefined]>}
     */
    async callRemoteClientFunction(targetContext, method, ...args) {
        const peer = this._peer(targetContext);
        if (!peer) {
            return [null, `call remote function but dst client is not start or ended: ${targetContext}`];
        }

        const rid = nextRid();
        const record = {
            s_rid: rid,
            action: "call_client_api",
            src: this.context,
            dst: peer.context,
            method,
            args,
            rid,
        };

        try {
            const fn = peer.apis.get(method);
            if (!fn) {
                return [null, `method not registered on ${peer.context}: ${method}`];
            }
            const value = await fn.apply(peer, args);
            // A reply is always a tuple. Callers take [0]; a missing value is
            // still a successful call and must not look like an error.
            return [value, undefined];
        } catch (err) {
            return [null, err && err.message ? err.message : String(err)];
        }
    }

    /**
     * Call a function on the server side and return the bare value.
     *
     * The shipped client is literally:
     *
     *     callServerFunction(e, ...t) {
     *         let n = null, r = yield this.callServerFunctionEx(e, ...t);
     *         return r && (n = r[0]), n;
     *     }
     *
     * so this unwraps and `callServerFunctionEx` is the one that keeps the
     * tuple. Getting that backwards silently turns a string into its first
     * character, which is why both forms are implemented.
     *
     * Falls back to a locally registered function of the same name when no
     * server node has one, which is how a plugin behaves when it runs
     * in-process.
     */
    async callServerFunction(method, ...args) {
        const tuple = await this.callServerFunctionEx(method, ...args);
        return tuple && tuple[0];
    }

    /**
     * Same as callServerFunction but resolves to `[value, undefined]` or
     * `[null, message]`, matching the transport's reply shape.
     */
    async callServerFunctionEx(method, ...args) {
        if (this.server && this.server.apis.has(method)) {
            try {
                return [await this.server.apis.get(method).apply(this.server, args), undefined];
            } catch (err) {
                return [null, err && err.message ? err.message : String(err)];
            }
        }
        if (this.apis.has(method)) {
            try {
                return [await this.apis.get(method).apply(this, args), undefined];
            } catch (err) {
                return [null, err && err.message ? err.message : String(err)];
            }
        }
        return [null, `server function not registered: ${method}`];
    }

    /**
     * Look up a function by name on a destination and invoke it, addressing
     * the destination by context. Used by the event fan-out path.
     */
    async callClientFunctionById(targetContext, rid, args) {
        const peer = this._peer(targetContext);
        if (!peer) return;
        const fn = peer.apis.get(rid);
        if (!fn) return;
        await fn.apply(peer, args || []);
    }

    // -----------------------------------------------------------------------
    // Outbound: events
    // -----------------------------------------------------------------------

    /**
     * Fire an event at another context and return the first listener's answer.
     *
     * This is the semantic that makes `emit` useful: only the first registered
     * handler contributes a result, the rest are notified for their side
     * effects. Returning anything else would change behaviour for callers that
     * treat the return value as authoritative.
     */
    async callClientFunction(targetContext, eventName, ...args) {
        const peer = this._peer(targetContext);
        if (!peer) return undefined;
        const handlers = peer.eventHandlers.get(eventName) || [];
        let result;
        for (let i = 0; i < handlers.length; i++) {
            const value = await handlers[i](...args);
            if (i === 0) result = value;      // first listener owns the result
        }
        return result;
    }

    /**
     * Add a listener for a server-pushed event.
     * Returns the remover, so callers can detach without bookkeeping.
     */
    attachServerEvent(eventName, handler) {
        if (!this.eventHandlers.has(eventName)) {
            this.eventHandlers.set(eventName, []);
        }
        this.eventHandlers.get(eventName).push(handler);
        return () => this.detachServerEvent(eventName, handler);
    }

    detachServerEvent(eventName, handler) {
        const list = this.eventHandlers.get(eventName);
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
    }

    /**
     * Deliver an event to this node's own listeners.
     * Same first-wins rule as above.
     */
    async fireServerEvent(eventName, args) {
        const handlers = this.eventHandlers.get(eventName) || [];
        let result;
        for (let i = 0; i < handlers.length; i++) {
            const value = await handlers[i].apply(this, args || []);
            if (i === 0) result = value;
        }
        return result;
    }

    /**
     * Send an event to every known peer. Fire and forget -- no replies are
     * collected, which matches the original's broadcast.
     */
    async broadcastEvent(eventName, eventArgs) {
        for (const peer of this.peers.values()) {
            if (peer === this) continue;
            const handlers = peer.eventHandlers.get(eventName) || [];
            for (const handler of handlers) {
                try {
                    await handler(eventArgs);
                } catch (err) {
                    this.emit("handler-error", err);
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------

    /** Stable key for de-duplicating identical in-flight requests. */
    static generateReqKey(url, options) {
        const holder = options && options.headers
            ? options.headers["x-request-id"]
            : undefined;
        if (options && options.headers) options.headers["x-request-id"] = "";
        const key = crypto.createHash("md5")
            .update(url + JSON.stringify(options || {}))
            .digest("hex");
        if (options && options.headers) options.headers["x-request-id"] = holder;
        return key;
    }

    getContextName() {
        return this.context;
    }
}

/**
 * Build the standard node set for a single-process client.
 *
 * Returns a server node plus the two renderer contexts that talk to it. The
 * main process is both, so `main` carries the server role and the renderer
 * role, which is what `main-process` / `main-renderer` mean in the original.
 */
function createMesh() {
    const { CONTEXTS } = require("./contract");

    const server = new RpcNode({ context: "server", isServer: true });
    const main = new RpcNode({ context: CONTEXTS.MAIN_PROCESS });
    const renderer = new RpcNode({ context: CONTEXTS.MAIN_RENDERER });
    const login = new RpcNode({ context: CONTEXTS.LOGIN_RENDERER });
    const vipWebview = new RpcNode({ context: CONTEXTS.VIP_DOWNLOAD_WEBVIEW });
    const preNewTask = new RpcNode({ context: CONTEXTS.PRE_NEW_TASK_RENDERER });
    const newTask = new RpcNode({ context: CONTEXTS.NEW_TASK_RENDERER });
    const mainPage = new RpcNode({ context: CONTEXTS.MAIN_PAGE_WEBVIEW });

    const all = [main, renderer, login, vipWebview, preNewTask, newTask, mainPage];
    for (const node of all) {
        node.server = server;
        for (const other of all) {
            if (other !== node) node.attachPeer(other);
        }
    }

    // Aliases mirror the plugin-facing names, so plugin code that calls
    // callRemoteClientFunction("vip-download-webview", ...) keeps working.
    renderer.registerAlias(CONTEXTS.VIP_DOWNLOAD_WEBVIEW, CONTEXTS.VIP_DOWNLOAD_WEBVIEW);
    main.registerAlias(CONTEXTS.VIP_DOWNLOAD_WEBVIEW, CONTEXTS.VIP_DOWNLOAD_WEBVIEW);

    return { server, main, renderer, login, vipWebview, preNewTask, newTask, mainPage };
}

module.exports = { RpcNode, createMesh, nextRid };
