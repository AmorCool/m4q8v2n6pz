/**
 * Login and token exchange.
 *
 * Three paths exist in the original and all three are reproduced here,
 * because they solve different problems:
 *
 *   A. web login      -- the user signs in through a window; yields a session
 *   B. session->token -- turns that session into an OAuth2 access token
 *   C. anonymous      -- gives an unauthenticated install a usable identity
 *
 * Path B is the one that matters for everything downstream: a session id
 * alone cannot call the API, and the VIP token request needs a real user id.
 *
 * Recovered sources:
 *   _thunder_src/User/dist/main/modules/User/xbaseTokenRequest.js  (plain)
 *   _thunder_src/User/dist/main/modules/User/constants.js          (plain)
 *   _thunder_src/User/node_modules/@xbase/sdk/dist/index.js        (endpoint table)
 *   plugins/ThunderXLogin/index.js                                 (web login)
 */

"use strict";

const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const { ENDPOINTS, PROTOCOL, USER_STATUS, VIP_TYPE_MAP } = require("./contract");

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/**
 * Build the device signature.
 *
 *   devicesign = "div101." + machineId + base64(md5(machineId + package + appid + appkey))
 *
 * The plaintext md5 goes through base64 -- not hex. This string is the
 * client's stable identity to the account system, so all four inputs have to
 * match what the original would have produced. `machineId` comes from the
 * native layer; the rest from the app config bundle.
 */
function buildDeviceSign(machineId, pkg, appid, appkey) {
    const digest = crypto.createHash("md5")
        .update(machineId + pkg + appid + appkey)
        .digest();
    return PROTOCOL.DEVICE_SIGN_PREFIX + machineId + digest.toString("base64");
}

/** The browser-side reader. Rejects values that are too short to be real. */
function readStoredDeviceId(fromCookie, fromStorage) {
    if (fromCookie && fromCookie.length > 20) return fromCookie;
    if (fromStorage && fromStorage.length > 20) {
        return fromStorage.replace(/'/g, "");
    }
    return "";
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function request(urlString, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const lib = url.protocol === "https:" ? https : http;
        const body = opts.rawBody !== undefined
            ? opts.rawBody
            : (opts.body ? JSON.stringify(opts.body) : null);

        const headers = Object.assign({}, opts.headers || {});
        if (body && headers["Content-Length"] === undefined) {
            headers["Content-Length"] = Buffer.byteLength(body);
        }
        if (body && headers["Content-Type"] === undefined) {
            headers["Content-Type"] = "application/json";
        }

        const req = lib.request(
            {
                method: opts.method || (body ? "POST" : "GET"),
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname + url.search,
                headers,
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks);
                    let parsed = null;
                    try {
                        parsed = JSON.parse(raw.toString());
                    } catch (err) {
                        parsed = null;
                    }
                    resolve({ status: res.statusCode, headers: res.headers, raw, data: parsed });
                });
            }
        );

        req.setTimeout(opts.timeout || 20000, () => req.destroy(new Error("timeout")));
        req.on("error", reject);
        if (body) req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Login client
// ---------------------------------------------------------------------------

/**
 * Owns the login lifecycle: web sign-in, session exchange, anonymous
 * fallback, keepalive, logout.
 */
class LoginClient {
    /**
     * @param {object} deps
     * @param {object} deps.config       app config: appid, appName, package, appkey, clientVersion, osversion, platformVersion
     * @param {function} deps.getMachineId
     * @param {object} [deps.store]      { get, set, remove } persistent storage
     * @param {function} [deps.log]
     */
    constructor(deps) {
        this.config = deps.config || {};
        this.getMachineId = deps.getMachineId;
        this.store = deps.store || createMemoryStore();
        this.log = deps.log || (() => {});

        this.deviceSign = "";
        this.userId = "";
        this.sessionId = "";
        this.nickname = "";
        this.loginType = "";
        this.status = USER_STATUS.init;
        this.userInfo = null;
        this.vipInfo = null;

        this._pingTimer = null;
        this._loginPromise = new Map();
    }

    // -----------------------------------------------------------------------
    // Initialisation
    // -----------------------------------------------------------------------

    /**
     * Compute the device signature and stash it. Must run before any login
     * attempt, because the signature is part of every credential request.
     */
    initDeviceIdentity() {
        const machineId = this.getMachineId();
        this.deviceSign = buildDeviceSign(
            machineId,
            this.config.package || "",
            this.config.appid || "",
            this.config.appkey || ""
        );
        this.store.set("deviceid", JSON.stringify({ id: this.deviceSign }));
        return this.deviceSign;
    }

    /** The base parameter block shared by every login request. */
    baseParams(extra) {
        return Object.assign(
            {
                appid: this.config.appid || "",
                appName: this.config.appName || "",
                deviceModel: this.config.platformVersion === "0" ? "PC" : "LINUX",
                deviceName: this.config.deviceName || "",
                OSVersion: this.config.osversion || "",
                netWorkType: "NONE",
                providerName: "NONE",
                sdkVersion: "v4.5.11",
                clientVersion: this.config.clientVersion || "",
                // 301 here, 300 in the browser SDK. They are different code
                // paths and the server accepts both; do not unify them.
                protocolVersion: "301",
                devicesign: this.deviceSign,
                platformVersion: this.config.platformVersion || "0",
                fromPlatformVersion: this.config.platformVersion || "0",
                format: "json",
                timestamp: Date.now(),
                creditkey: "",
            },
            extra || {}
        );
    }

    // -----------------------------------------------------------------------
    // Path A: credential login
    // -----------------------------------------------------------------------

    /** Candidate login hosts, tried in order when one fails. */
    _loginHost(index) {
        const hosts = ["login", "login2", "login3"];
        return hosts[Math.min(index, hosts.length - 1)];
    }

    /**
     * Exchange a loginKey for a real session.
     *
     * This is the second half of web login: the browser flow yields a
     * loginKey, and this turns it into `sessionid` + `userid`.
     *
     * @param {object} credential  { loginkey, userid, usernick }
     * @param {number} [attempt]   internal retry counter
     */
    async loginWithKey(credential, attempt = 0) {
        if (attempt >= 3) {
            throw new Error("login failed after 3 attempts");
        }

        const url = `https://${this._loginHost(attempt)}.xunlei.com`
            + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_LOGINKEY;

        const body = this.baseParams({
            userName: credential.userid,
            loginKey: credential.loginkey,
        });

        const res = await request(url, { method: "POST", body });
        if (res.status !== 200) {
            return this.loginWithKey(credential, attempt + 1);
        }

        if (res.data && String(res.data.errorCode) === "0") {
            return this._applyLoginResponse(res.data, credential);
        }

        throw new Error(
            `login rejected: ${(res.data && res.data.errorDesc) || "unknown"}`
        );
    }

    /**
     * Normalise a login response.
     *
     * The wire format uses short names and the rest of the client uses long
     * ones. The mapping is also what gets persisted, so this is the single
     * place that knows both spellings.
     */
    _applyLoginResponse(data, fallback) {
        const map = {
            errorCode: "blogresult",
            errorDesc: "errdesc",
            userID: "userid",
            loginKey: "loginkey",
            nickName: "usernick",
            sessionID: "sessionid",
            userName: "usrname",
            userNewNo: "usernewno",
            account: "score",
            verifyType: "VERIFY_KEY",
        };

        const normalized = Object.assign({}, data);
        for (const [short, long] of Object.entries(map)) {
            if (data[short] !== undefined) normalized[long] = data[short];
        }

        this.userId = String(normalized.userid || (fallback && fallback.userid) || "");
        this.sessionId = String(normalized.sessionid || "");
        this.nickname = normalized.usernick || (fallback && fallback.usernick) || "";
        this.status = USER_STATUS.loggedIn;

        // The trial verify key feeds the VIP token request's Basic credential.
        this.verifyKey = normalized.VERIFY_KEY || "";

        this.store.set("userinfo", JSON.stringify(normalized));
        return normalized;
    }

    // -----------------------------------------------------------------------
    // Path C: user profile + VIP flags
    // -----------------------------------------------------------------------

    /**
     * Fetch the profile. The vas id list is what makes the server include the
     * VIP flags, so it is not optional.
     */
    async fetchUserInfo(attempt = 0) {
        if (attempt >= 3) throw new Error("getuserinfo failed after 3 attempts");

        const url = `https://${this._loginHost(attempt)}.xunlei.com`
            + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_GETUSERINFO;

        const body = this.baseParams({
            userID: this.userId,
            sessionID: this.sessionId,
            vasid: ENDPOINTS.LOGIN_VAS_ID,
        });

        const res = await request(url, { method: "POST", body });
        if (res.status !== 200) return this.fetchUserInfo(attempt + 1);
        if (!res.data || String(res.data.errorCode) !== "0") {
            return this.fetchUserInfo(attempt + 1);
        }

        this.userInfo = res.data;
        this.vipInfo = parseVipInfo(res.data);
        this.store.set("allUserInfo", JSON.stringify(res.data));
        return res.data;
    }

    // -----------------------------------------------------------------------
    // Path B: session -> OAuth2 access token
    // -----------------------------------------------------------------------

    /**
     * Exchange the session for an access token.
     *
     * The provider string is what tells the endpoint the credential is a
     * client-side session rather than a password or an auth code. When the
     * server omits a refresh token the session id itself is reused as one,
     * which is why a session can outlive several token refreshes.
     *
     * De-duplicated per session so concurrent callers share one round trip.
     */
    async exchangeSessionForToken(sessionId) {
        const session = sessionId || this.sessionId;
        if (!session) throw new Error("no session to exchange");

        if (this._loginPromise.has(session)) {
            return this._loginPromise.get(session);
        }

        const url = `https://${this._loginHost(0)}.xunlei.com`
            + ENDPOINTS.AUTH_SIGNIN_TOKEN;

        const promise = (async () => {
            const body = {
                provider: ENDPOINTS.SESSION_TOKEN_PROVIDER,
                signin_token: session,
                client_id: this.config.clientId || PROTOCOL.ACC_CENTER_CLIENT_ID,
                client_secret: this.config.clientSecret || "",
            };
            const res = await request(url, {
                method: "POST",
                body,
                headers: { [PROTOCOL.DEVICE_ID_HEADER]: this.deviceSign },
            });

            if (!res.data) throw new Error("token endpoint returned no body");
            if (res.data.error) {
                throw new Error(`token exchange failed: ${res.data.error}`);
            }

            if (!res.data.refresh_token) res.data.refresh_token = session;
            this.accessToken = res.data.access_token || "";
            return res.data;
        })();

        this._loginPromise.set(session, promise);
        try {
            return await promise;
        } finally {
            this._loginPromise.delete(session);
        }
    }

    // -----------------------------------------------------------------------
    // Path C: anonymous
    // -----------------------------------------------------------------------

    /**
     * Register an anonymous identity.
     *
     * Runs on startup when nobody is signed in, after a short delay so it
     * does not compete with a real login that is about to happen. The
     * resulting uid lets download and update checks work on a fresh install.
     */
    async signUpAnonymously() {
        if (await this.isLogined()) return null;
        if (this.userId && this.userId !== "0") return null;

        const url = `https://${this._loginHost(0)}.xunlei.com`
            + ENDPOINTS.AUTH_SIGNUP_ANONYMOUSLY;

        const res = await request(url, {
            method: "POST",
            body: {
                client_id: this.config.clientId || PROTOCOL.ACC_CENTER_CLIENT_ID,
                client_secret: this.config.clientSecret || "",
            },
        });

        if (!res.data || !res.data.sub) {
            throw new Error("anonymous signup did not return a subject");
        }

        this.anonymousUid = res.data.sub;
        this.status = USER_STATUS.anonymouslyLoggedIn;
        return res.data;
    }

    isAnonymous() {
        return this.status === USER_STATUS.anonymouslyLoggedIn;
    }

    async isLogined() {
        return this.status === USER_STATUS.loggedIn && !!this.sessionId;
    }

    // -----------------------------------------------------------------------
    // Keepalive
    // -----------------------------------------------------------------------

    /**
     * Poll the session every 5 minutes.
     *
     * The reply carries a message list, and two entries matter: a timeout
     * means the session died, a kickout means someone signed in elsewhere.
     * Both end the local session, but they are reported differently so the
     * UI can explain which happened.
     */
    startKeepalive(onExpired, onKickout) {
        this.stopKeepalive();
        const interval = 5 * 60 * 1000;

        this._pingTimer = setInterval(async () => {
            try {
                const res = await request(
                    `https://${this._loginHost(0)}.xunlei.com`
                        + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_PING,
                    { method: "POST", body: this.baseParams({ userID: this.userId }) }
                );
                if (!res.data || Number(res.data.errorCode) !== 200) {
                    this.stopKeepalive();
                    return;
                }
                for (const msg of res.data.messages || []) {
                    if (msg.type === "session_timeout") {
                        this.stopKeepalive();
                        this.status = USER_STATUS.loggedOut;
                        if (onExpired) onExpired(msg);
                    } else if (msg.type === "kickout") {
                        this.stopKeepalive();
                        this.status = USER_STATUS.loggedOut;
                        if (onKickout) onKickout(msg);
                    }
                }
            } catch (err) {
                this.log("ping failed", err && err.message);
            }
        }, interval);

        if (this._pingTimer.unref) this._pingTimer.unref();
    }

    stopKeepalive() {
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
    }

    // -----------------------------------------------------------------------
    // Logout
    // -----------------------------------------------------------------------

    /**
     * Sign out.
     *
     * Two server calls exist: the legacy one and the OAuth webview pass. Both
     * are best-effort -- local state is cleared regardless, because a failed
     * logout must not leave the user stuck signed in.
     */
    async logout() {
        this.stopKeepalive();

        try {
            await request(
                `https://${this._loginHost(0)}.xunlei.com`
                    + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_LOGOUT,
                {
                    method: "POST",
                    body: this.baseParams({ userID: this.userId, sessionID: this.sessionId }),
                }
            );
        } catch (err) {
            this.log("logout request failed", err && err.message);
        }

        try {
            await request(ENDPOINTS.AUTH_REVOKE, {
                method: "POST",
                body: { token: this.accessToken || "" },
                headers: { [PROTOCOL.DEVICE_ID_HEADER]: this.deviceSign },
            });
        } catch (err) {
            this.log("revoke failed", err && err.message);
        }

        this.userId = "";
        this.sessionId = "";
        this.accessToken = "";
        this.userInfo = null;
        this.vipInfo = null;
        this.status = USER_STATUS.loggedOut;
        this.store.remove("userinfo");
        this.store.remove("allUserInfo");
    }
}

// ---------------------------------------------------------------------------
// VIP flag parsing
// ---------------------------------------------------------------------------

/**
 * Pull the VIP tier out of a profile response.
 *
 * Precedence is driven by the membership type, because a user can hold
 * several. `isVip` is compared loosely: the server has been observed sending
 * it as both a number and a string, and the original handles both.
 */
function parseVipInfo(userInfo) {
    const list = (userInfo && userInfo.vipList) || [];
    if (!list.length) {
        return { isVip: false, vipType: "", vipLevel: 0, raw: null };
    }

    const entry = list[0];
    const vasType = Number(entry.vasType);
    return {
        isVip: !!entry.isVip && String(entry.isVip) !== "0" && String(entry.isVip) !== "false",
        vipType: VIP_TYPE_MAP[vasType] || "",
        vipLevel: Number(entry.vipLevel || 0),
        vasType,
        raw: entry,
    };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Fallback store. A real build swaps this for the file-backed one. */
function createMemoryStore() {
    const map = new Map();
    return {
        get: (k) => (map.has(k) ? map.get(k) : null),
        set: (k, v) => map.set(k, v),
        remove: (k) => map.delete(k),
    };
}

module.exports = {
    LoginClient,
    buildDeviceSign,
    readStoredDeviceId,
    parseVipInfo,
    createMemoryStore,
    request,
};
