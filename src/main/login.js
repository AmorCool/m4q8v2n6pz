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

const { ENDPOINTS, PROTOCOL, LOGIN, USER_STATUS, VIP_TYPE_MAP } = require("./contract");

// ---------------------------------------------------------------------------
// Cookie jar
// ---------------------------------------------------------------------------

/**
 * A minimal RFC 6265 cookie store.
 *
 * Why this is here: the original's login page runs in a browser context and
 * every request rides on `withCredentials`, so cookies the server sets on one
 * call are replayed on the next. The two places that matter are
 * `/xluser.core.login/v3/loginkey`, which is how a loginKey becomes a real
 * session cookie, and the cloud drive, which authenticates with that same
 * session cookie (PAN_DIRECT_LINK_SPEC.md section 3.1 -- `withCredentials`).
 *
 * Raw `https.request` has no jar, so without this the client sends no Cookie
 * header and stores nothing from Set-Cookie. That is the direct cause of the
 * drive answering 401 after a successful-looking login.
 *
 * Scope is deliberately small: name, value, domain, path, expiry. No
 * SameSite/HttpOnly handling -- node is not a browser and neither changes what
 * goes on the wire here.
 */
class CookieJar {
    constructor() {
        /** @type {Array<{name:string,value:string,domain:string,path:string,expires:number}>} */
        this.cookies = [];
    }

    /**
     * Absorb the Set-Cookie header(s) of one response.
     *
     * @param {string|string[]} header the `set-cookie` response header
     * @param {string} requestHost     the host the response came from, used
     *                                 as the default domain
     */
    store(header, requestHost) {
        const list = Array.isArray(header) ? header : [header];
        for (const raw of list) {
            if (!raw) continue;
            const parts = String(raw).split(";");
            const pair = parts.shift();
            const eq = pair.indexOf("=");
            if (eq < 0) continue;

            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (!name) continue;

            let domain = String(requestHost || "").toLowerCase();
            let path = "/";
            let expires = Infinity;
            for (const attribute of parts) {
                const eqIndex = attribute.indexOf("=");
                const key = (eqIndex < 0 ? attribute : attribute.slice(0, eqIndex)).trim().toLowerCase();
                const val = eqIndex < 0 ? "" : attribute.slice(eqIndex + 1).trim();
                if (key === "domain" && val) {
                    domain = val.replace(/^\./, "").toLowerCase();
                } else if (key === "path" && val) {
                    path = val;
                } else if (key === "max-age" && val) {
                    const seconds = Number(val);
                    if (Number.isFinite(seconds)) expires = Date.now() + seconds * 1000;
                } else if (key === "expires" && val) {
                    const when = Date.parse(val);
                    if (!Number.isNaN(when)) expires = when;
                }
            }
            this._put({ name, value, domain, path, expires });
        }
    }

    /** Insert, replacing any cookie with the same name/domain/path. */
    _put(cookie) {
        this.cookies = this.cookies.filter((c) => !(
            c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path
        ));
        // An expired cookie is a deletion, not a value.
        if (cookie.expires <= Date.now()) return;
        this.cookies.push(cookie);
    }

    /** The cookies that apply to a request to `host` + `path`. */
    matching(host, path) {
        const hostname = String(host || "").toLowerCase();
        const target = path || "/";
        const now = Date.now();
        return this.cookies.filter((cookie) => {
            if (cookie.expires <= now) return false;
            const domain = cookie.domain;
            if (hostname !== domain && !hostname.endsWith("." + domain)) return false;
            const cookiePath = cookie.path || "/";
            if (!target.startsWith(cookiePath)) return false;
            // Path-match boundary: "/foo" must not match "/foobar".
            if (target.length > cookiePath.length && !cookiePath.endsWith("/")
                && target[cookiePath.length] !== "/") {
                return false;
            }
            return true;
        });
    }

    /** The `Cookie` header value for a request, or "" when nothing applies. */
    header(host, path) {
        const matched = this.matching(host, path);
        if (!matched.length) return "";
        // Longer paths first, the ordering RFC 6265 asks for.
        matched.sort((a, b) => b.path.length - a.path.length);
        return matched.map((c) => `${c.name}=${c.value}`).join("; ");
    }

    /** One cookie's value, or "" -- used for VERIFY_KEY. */
    value(name, host, path) {
        const match = this.matching(host, path).find((c) => c.name === name);
        return match ? match.value : "";
    }

    clear() {
        this.cookies = [];
    }
}

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

/**
 * One HTTP round trip.
 *
 * Three body flavours, because the original speaks three:
 *   - `rawBody`  a pre-serialised string
 *   - `form`     urlencoded -- the v3 login endpoints parse this and ignore a
 *                JSON body (verified against the live server: a JSON body
 *                comes back as `userinfo_expired`, a form body is understood)
 *   - `body`     JSON -- the account-centre OAuth2 endpoints
 *
 * When `jar` is given the matching cookies go out and any Set-Cookie comes
 * back in. Both are no-ops otherwise, so the older call sites are unchanged.
 */
function request(urlString, options) {
    const opts = options || {};
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const lib = url.protocol === "https:" ? https : http;
        let body = null;
        if (opts.rawBody !== undefined) body = opts.rawBody;
        else if (opts.form) body = new URLSearchParams(opts.form).toString();
        else if (opts.body) body = JSON.stringify(opts.body);

        const headers = Object.assign({}, opts.headers || {});
        const jar = opts.jar;
        if (jar && headers["Cookie"] === undefined) {
            const cookie = jar.header(url.hostname, url.pathname);
            if (cookie) headers["Cookie"] = cookie;
        }
        if (body && headers["Content-Length"] === undefined) {
            headers["Content-Length"] = Buffer.byteLength(body);
        }
        if (body && headers["Content-Type"] === undefined) {
            headers["Content-Type"] = opts.form
                ? "application/x-www-form-urlencoded"
                : "application/json";
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
                    if (jar && res.headers["set-cookie"]) {
                        jar.store(res.headers["set-cookie"], url.hostname);
                    }
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

        /** Cookies received from the account system; see CookieJar. */
        this.jar = deps.jar || new CookieJar();
        /** The device-code exchange in flight, if any. */
        this._deviceLogin = null;
        /** The token `sendsms` returned, needed by `smslogin`. */
        this._smsToken = "";

        this._pingTimer = null;
        this._loginPromise = new Map();
    }

    // -----------------------------------------------------------------------
    // Credentials
    //
    // Each of these prefers an explicit config value and falls back to the
    // value the shipped PC client is built with (contract.LOGIN, spec section
    // 9). The fallback is what makes a bare checkout behave like the original
    // without a config file.
    // -----------------------------------------------------------------------

    _appId() { return this.config.appid || LOGIN.APPID; }
    _appKey() { return this.config.appkey || LOGIN.APPKEY; }
    _appName() { return this.config.appName || LOGIN.APP_NAME; }
    _package() { return this.config.package || "com.xunlei.thunderx"; }
    _clientId() { return this.config.clientId || LOGIN.CLIENT_ID; }
    _clientSecret() { return this.config.clientSecret || LOGIN.CLIENT_SECRET; }
    _apiOrigin() { return this.config.apiOrigin || LOGIN.API_ORIGIN; }

    /** Run a request with this client's cookie jar attached. */
    _request(urlString, options) {
        return request(urlString, Object.assign({ jar: this.jar }, options || {}));
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
            this._package(),
            this._appId(),
            this._appKey()
        );
        this.store.set("deviceid", JSON.stringify({ id: this.deviceSign }));
        return this.deviceSign;
    }

    /**
     * The base parameter block shared by every login request.
     *
     * `protocolVersion` is "301" here and "300" in `baseParams2`. The original
     * really does carry both: its client bundle (`index.js`) sends 301 while
     * its browser login page sends 300 through `baseParams2`. The server
     * accepts either (verified against the live endpoint), so the two are kept
     * apart rather than unified -- a request has to match whichever code path
     * it belongs to.
     */
    baseParams(extra) {
        return Object.assign(this._baseParamFields(), { protocolVersion: "301" }, extra || {});
    }

    /**
     * The `baseParams2` block (LOGIN_PROTOCOL_SPEC.md section 6.3), used by
     * the three v3 login endpoints. Only the protocol version differs from
     * `baseParams`; everything else is the same shared block.
     */
    baseParams2(extra) {
        return Object.assign(this._baseParamFields(), { protocolVersion: "300" }, extra || {});
    }

    /** The fields both base blocks share. */
    _baseParamFields() {
        return {
            appid: this._appId(),
            appName: this._appName(),
            deviceModel: this.config.platformVersion === "0" ? "PC" : "LINUX",
            deviceName: this.config.deviceName || "",
            OSVersion: this.config.osversion || "",
            netWorkType: "NONE",
            providerName: "NONE",
            provideName: "NONE",
            sdkVersion: "v4.5.11",
            clientVersion: this.config.clientVersion || "",
            devicesign: this.deviceSign,
            platformVersion: this.config.platformVersion || "0",
            fromPlatformVersion: this.config.platformVersion || "0",
            format: "json",
            timestamp: Date.now(),
            creditkey: "",
        };
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

        // postLoginKey in the original (spec section 4.2) sends the same
        // baseParams2 block as the other v3 calls, urlencoded.
        const form = this.baseParams2({
            userName: credential.userid,
            loginKey: credential.loginkey,
        });

        const res = await this._request(url, { method: "POST", form });
        if (res.status !== 200) {
            return this.loginWithKey(credential, attempt + 1);
        }

        if (res.data && String(res.data.errorCode) === "0") {
            return this._applyLoginResponse(res.data, credential);
        }

        throw this._loginError(res.data, "登录失败");
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
        // The drive authenticates with the session cookie this exchange just
        // established, so it is handed over here -- the one place every login
        // path funnels through (see Application.panSession).
        this._persistPanCookie();
        return normalized;
    }

    /**
     * Hand the drive the cookie it authenticates with.
     *
     * The drive's host is what decides which cookies apply, so the lookup is
     * done for `api-pan.xunlei.com` rather than the login host. A cookie the
     * account system set for `.xunlei.com` matches both.
     */
    _persistPanCookie() {
        const cookie = this.jar.header("api-pan.xunlei.com", "/");
        if (cookie) this.store.set("pan-cookie", cookie);
        return cookie;
    }

    // -----------------------------------------------------------------------
    // Error mapping
    // -----------------------------------------------------------------------

    /**
     * Turn a v3 error response into an Error a user can read.
     *
     * The server's own `errorDesc` is preferred because it is the wording the
     * original shows; the table is only a fallback for the codes the spec
     * documents (LOGIN_PROTOCOL_SPEC.md section 7) when no description came
     * back. `code` and `captchaRequired` ride along on the error so callers
     * can branch without parsing the message.
     */
    _loginError(data, fallbackMessage) {
        const payload = data || {};
        const code = String(payload.errorCode || "");
        const table = {
            2: "账号或密码错误",
            3: "账号或密码错误",
            4: "账号或密码错误",
            1004: "账号或密码错误",
            6: "需要安全验证，请稍后重试",
            8: "账号已被冻结",
            9: "账号不存在",
            10: "需要输入图形验证码",
            11: "客户端应用信息不匹配",
            12: "登录信息已失效，请重新输入账号密码",
            13: "登录信息已失效，请重新输入账号密码",
            14: "登录信息已失效，请重新输入账号密码",
            15: "登录信息已失效，请重新输入账号密码",
            16: "账号已被冻结",
            17: "需要输入图形验证码",
            22: "登录环境异常，请 2 小时后再试",
            27: "该手机号已注册",
            39: "需要输入图形验证码",
            1007: "需要安全验证，请稍后重试",
        };
        const message = payload.errorDesc
            || payload.error_description
            || table[code]
            || fallbackMessage
            || "登录失败";
        const err = new Error(message);
        err.code = code;
        err.captchaRequired = code === "10" || code === "17" || code === "39"
            || Boolean(payload.verifyKey || payload.VERIFY_KEY);
        return err;
    }

    // -----------------------------------------------------------------------
    // Path A2: scan login (OAuth2 device code)
    //
    // LOGIN_PROTOCOL_SPEC.md section 2A. The QR payload is a URL, not an
    // image: the device-code response carries `verification_uri_complete`, it
    // is rewritten onto the QR host, and that URL is what the phone scans.
    // -----------------------------------------------------------------------

    /**
     * Ask for a device code and build the QR URL.
     *
     * @returns {Promise<{url:string, interval:number, expiresIn:number}>}
     */
    async startScanLogin() {
        const res = await this._request(this._apiOrigin() + ENDPOINTS.AUTH_DEVICE_CODE, {
            method: "POST",
            body: { client_id: this._clientId(), scope: "user" },
        });
        const data = res.data || {};
        if (!data.device_code) {
            throw this._loginError(data, "二维码获取失败，请检查网络");
        }

        // Step 2 of the spec: move the verification URI onto the scan host and
        // wrap it in the qrlogin redirect. The exact URL shape matters -- the
        // phone app parses it.
        const verification = data.verification_uri_complete || data.verification_url || "";
        if (!verification) {
            throw new Error("设备码响应缺少验证地址");
        }
        const target = new URL(verification);
        target.host = LOGIN.QRLOGIN_HOST;
        target.pathname = "auth-device/";

        const qrUrl = new URL(
            this._apiOrigin() + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_QRLOGIN
        );
        qrUrl.searchParams.set("redirect_uri", target.href);

        const interval = Number(data.interval) > 0 ? Number(data.interval) : 2;
        const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : 120;
        this._deviceLogin = {
            deviceCode: data.device_code,
            interval,
            expiresIn,
            expiresAt: Date.now() + expiresIn * 1000,
            url: qrUrl.href,
        };
        return { url: qrUrl.href, interval, expiresIn };
    }

    /**
     * Poll the device-code token endpoint once.
     *
     * The caller drives the interval, so this is a single attempt rather than
     * a loop -- the UI needs to show "scanned, waiting for confirmation"
     * between attempts, which a blocking loop could not do.
     *
     * @returns {Promise<{state:string, userId?:string, nickname?:string}>}
     *          state is one of pending | scanned | confirmed | expired |
     *          denied | error
     */
    async pollScanLogin() {
        const state = this._deviceLogin;
        if (!state) throw new Error("没有进行中的扫码登录");
        if (Date.now() > state.expiresAt) return { state: "expired" };

        const res = await this._request(this._apiOrigin() + ENDPOINTS.AUTH_TOKEN, {
            method: "POST",
            body: {
                client_id: this._clientId(),
                client_secret: this._clientSecret(),
                grant_type: PROTOCOL.DEVICE_CODE_GRANT,
                device_code: state.deviceCode,
            },
        });
        const data = res.data || {};

        if (data.access_token) {
            await this._registerDeviceSession(data.access_token);
            this._deviceLogin = null;
            return { state: "confirmed", userId: this.userId, nickname: this.nickname };
        }

        const error = String(data.error || "");
        if (error === "authorization_pending") {
            // A scanned-but-unconfirmed code reports WAITING_CONSENT; anything
            // else means the QR has not been read yet.
            const details = Array.isArray(data.details) ? data.details : [];
            const waiting = details.some((d) => d && d.state === "WAITING_CONSENT");
            return { state: waiting ? "scanned" : "pending" };
        }
        // The remaining answers are conclusive: the code is dead, so the
        // session is dropped and the UI can only offer a refresh.
        if (error === "expired_token") {
            this._deviceLogin = null;
            return { state: "expired" };
        }
        if (error === "access_denied") {
            this._deviceLogin = null;
            return { state: "denied" };
        }
        return {
            state: "error",
            message: data.error_description || data.errorDesc || "扫码登录失败",
        };
    }

    /**
     * Trade the device-code access token for a session (spec step 4).
     *
     * `appid` / `appname` / `devicesign` are all required -- this is not a
     * standard OAuth2 endpoint and the server rejects a request missing any
     * of them.
     */
    async _registerDeviceSession(accessToken) {
        const query = "?appid=" + encodeURIComponent(this._appId())
            + "&token=" + encodeURIComponent(accessToken)
            + "&appname=" + encodeURIComponent(this._appName())
            + "&devicesign=" + encodeURIComponent(this.deviceSign);
        const res = await this._request(
            this._apiOrigin() + ENDPOINTS.SESSION_REGISTER + query,
            { method: "GET" }
        );
        const data = res.data || {};
        if (!data.sessionid) {
            throw this._loginError(data, "扫码登录失败：未能换取会话");
        }

        this.userId = String(data.user_id || data.userid || "");
        this.sessionId = String(data.sessionid);
        this.nickname = data.nickname || data.usernick || "";
        this.loginType = "7";           // 7 is the scan type in the original
        this.status = USER_STATUS.loggedIn;
        this.store.set("userinfo", JSON.stringify(data));
        this._persistPanCookie();
        return data;
    }

    // -----------------------------------------------------------------------
    // Path A3: phone + SMS code
    //
    // LOGIN_PROTOCOL_SPEC.md section 3. `sendsms` mints a token that
    // `smslogin` must echo back, so the token is held on the client between
    // the two calls rather than round-tripped through the UI.
    // -----------------------------------------------------------------------

    /**
     * Request an SMS code.
     *
     * @param {string} phone
     * @param {string} [verifyCode] the image captcha, when the server asked
     * @returns {Promise<{token:string, captchaRequired:boolean, message:string}>}
     *          A captcha challenge is a normal outcome, not an error: the
     *          caller has to render the input and try again.
     */
    async sendSmsCode(phone, verifyCode) {
        const host = `${this._loginHost(0)}.xunlei.com`;
        const url = `https://${host}${ENDPOINTS.LOGIN_BASE_URL}${ENDPOINTS.LOGIN_PATH_SENDSMS}`
            + "?username=" + encodeURIComponent(phone);

        const form = this.baseParams2({
            op: "sendSms",
            // `from` is the original's LOGIN_ID entrance marker; "0" is the
            // PC entrance and is what the client's own config carries.
            from: this._appId(),
            mobile: phone,
            verifyType: "MEA",
            v: 2,
            type: 2,                 // 2 = sign in (1 = register)
        });
        if (verifyCode) {
            form.verifyCode = verifyCode;
            const verifyKey = this.jar.value("VERIFY_KEY", host, "/");
            if (verifyKey) form.verifyKey = verifyKey;
        }

        const res = await this._request(url, { method: "POST", form });
        const data = res.data || {};
        const code = String(data.errorCode || "");
        if (code === "0" || code === "") {
            this._smsToken = data.token || "";
            return { token: this._smsToken, captchaRequired: false, message: "" };
        }

        const err = this._loginError(data, "验证码发送失败");
        if (err.captchaRequired) {
            // The server wants an image captcha first. Surface it as a state,
            // not a failure, so the UI can ask for the code and retry.
            return { token: "", captchaRequired: true, message: err.message };
        }
        throw err;
    }

    /**
     * Verify the SMS code and finish the login.
     *
     * @param {object} credential { phone, code, verifyCode }
     */
    async loginWithSmsCode(credential) {
        const cred = credential || {};
        const phone = String(cred.phone || "");
        const code = String(cred.code || "");
        if (!this._smsToken) {
            throw new Error("请先获取短信验证码");
        }

        const host = `${this._loginHost(0)}.xunlei.com`;
        const url = `https://${host}${ENDPOINTS.LOGIN_BASE_URL}${ENDPOINTS.LOGIN_PATH_SMSLOGIN}`
            + "?username=" + encodeURIComponent(phone);

        const form = this.baseParams2({
            smsCode: code,
            token: this._smsToken,
            mobile: phone,
        });
        if (cred.verifyCode) form.verifyCode = cred.verifyCode;

        const res = await this._request(url, { method: "POST", form });
        const data = res.data || {};
        if (String(data.errorCode || "0") !== "0") {
            throw this._loginError(data, "短信验证码错误");
        }
        return this._finishV3Login(data);
    }

    // -----------------------------------------------------------------------
    // Path A4: account + password
    //
    // LOGIN_PROTOCOL_SPEC.md section 4. The password goes out in the clear:
    // `isMd5Pwd: "0"` is the original's own value and the transport is HTTPS,
    // so there is no client-side hashing to reproduce.
    // -----------------------------------------------------------------------

    /**
     * @param {object} credential { userName, passWord, verifyCode? }
     */
    async loginWithPassword(credential) {
        const cred = credential || {};
        const userName = String(cred.userName || "");
        const url = `https://${this._loginHost(0)}.xunlei.com`
            + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_LOGIN
            + "?username=" + encodeURIComponent(userName);

        const form = this.baseParams2({
            userName,
            passWord: String(cred.passWord || ""),
            isMd5Pwd: "0",
        });
        if (cred.verifyCode) {
            form.verifyCode = cred.verifyCode;
            const verifyKey = this.jar.value("VERIFY_KEY", this._loginHost(0) + ".xunlei.com", "/");
            if (verifyKey) form.verifyKey = verifyKey;
        }

        const res = await this._request(url, { method: "POST", form });
        const data = res.data || {};
        if (String(data.errorCode || "0") !== "0") {
            throw this._loginError(data, "账号或密码错误");
        }
        return this._finishV3Login(data);
    }

    /**
     * Turn a v3 login success into a live session.
     *
     * Both `login` and `smslogin` answer with a loginkey, and the original
     * posts that to `/v3/loginkey` to obtain the session cookie (spec section
     * 4.2). `smslogin` sometimes answers with the session already attached, in
     * which case there is nothing to exchange and the response is used as-is.
     */
    async _finishV3Login(data) {
        const loginkey = data.loginkey || data.loginKey || "";
        const userid = data.userid || data.userID || "";

        if (data.sessionid) {
            return this._applyLoginResponse(data);
        }
        if (!loginkey) {
            throw new Error("登录响应缺少 loginkey，无法换取会话");
        }
        return this.loginWithKey({ loginkey, userid });
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

        const form = this.baseParams2({
            userID: this.userId,
            sessionID: this.sessionId,
            vasid: ENDPOINTS.LOGIN_VAS_ID,
        });

        const res = await this._request(url, { method: "POST", form });
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
                const res = await this._request(
                    `https://${this._loginHost(0)}.xunlei.com`
                        + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_PING,
                    { method: "POST", form: this.baseParams2({ userID: this.userId }) }
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
            await this._request(
                `https://${this._loginHost(0)}.xunlei.com`
                    + ENDPOINTS.LOGIN_BASE_URL + ENDPOINTS.LOGIN_PATH_LOGOUT,
                {
                    method: "POST",
                    form: this.baseParams2({ userID: this.userId, sessionID: this.sessionId }),
                }
            );
        } catch (err) {
            this.log("logout request failed", err && err.message);
        }

        try {
            await this._request(ENDPOINTS.AUTH_REVOKE, {
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
    CookieJar,
    buildDeviceSign,
    readStoredDeviceId,
    parseVipInfo,
    createMemoryStore,
    request,
};
