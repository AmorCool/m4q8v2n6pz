/**
 * Thunder pan (cloud drive) client.
 *
 * This is the client side of "取回本地": read the drive's file list, ask the
 * drive for a file's `web_content_link`, and hand that URL to the download
 * kernel. It is the piece the recovered material calls `ThunderPanPlugin`'s
 * network layer (spec: PAN_DIRECT_LINK_SPEC.md sections 2.1 and 3.1).
 *
 * Everything here is plain node. There is no `electron`, no `net` module and
 * no cookie jar of its own: the HTTP call is injected, and the session
 * material is read through a getter, so the whole file can be loaded and
 * driven by the test suite without an account. That is deliberate -- with no
 * real account there is no way to exercise the happy path end to end, so the
 * parts that *can* be checked offline (request construction, response
 * parsing, error classification) are kept as pure functions and checked
 * directly.
 *
 * Recovered sources (offsets are byte offsets into the shipped bundles, the
 * same convention PAN_DIRECT_LINK_SPEC.md uses):
 *   resources/app/plugins/ThunderPanPlugin/0.7.0/static/app.7253809.js
 *     @54857   base URL table (drive / shoulei / password)
 *     @57600   the shared request helper `k(url, params, opts)`
 *     @58503   request header assembly (x-peer-id / x-client-version-code /
 *              x-device-id / space-authorization, withCredentials)
 *     @30702   list files, single page
 *     @31030   list files, paged
 *     @33436   getFileInfo (files/{id}) -> web_content_link
 *     @36233   try/v1 query + commit (trial acceleration)
 *     @463226  share/detail + share/file_info (share module 230)
 *     @204300  addOrRefreshServerAndToken -- the direct-link fetch this
 *              module implements the client half of
 */

"use strict";

const { request } = require("./login");

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/**
 * Base URL table, copied from the shipped client (app.js@54857).
 *
 * The original switches between test and prod with an `APIEnv` flag; the two
 * entries are kept here so a test build can be pointed at the alpha host
 * without editing a caller.
 */
const PAN_ENDPOINTS = Object.freeze({
    drive: Object.freeze({
        test: "http://api-alpha-drive.office.k8s.xunlei.cn/drive/v1/",
        prod: "https://api-pan.xunlei.com/drive/v1/",
    }),
    shoulei: Object.freeze({
        test: "http://test.api-shoulei-ssl.xunlei.com/",
        prod: "https://api-shoulei-ssl.xunlei.com/",
    }),
});

/**
 * Trial-acceleration host.
 *
 * The trial endpoints live on their own host in production but share the
 * shoulei host in the test environment (spec section 2.1, rows 5 and 6), so
 * they cannot be derived from `PAN_ENDPOINTS.shoulei` alone.
 */
const TRY_ENDPOINTS = Object.freeze({
    test: "https://test.api-shoulei-ssl.xunlei.com/",
    prod: "https://try-pan-privilege-vip.xunlei.com/",
});

/** `try_scene` values, chosen by membership tier (app.js@36233). */
const TRY_SCENE = Object.freeze({
    super: "PAN_PACK_DOWNLOAD_SUPER",
    platinum: "PAN_PACK_DOWNLOAD_BAIJIN",
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error codes a caller is expected to branch on.
 *
 * The two that matter are NOT_LOGGED_IN and SESSION_EXPIRED: both surface as
 * HTTP 401 and the original never tells them apart, but a UI has to. "Sign in
 * first" is an instruction the user can act on; "your session ended, sign in
 * again" is a different one. The client decides between them from whether it
 * held a session at all when the request was made.
 */
const PAN_ERROR = Object.freeze({
    NOT_LOGGED_IN: "not_logged_in",
    SESSION_EXPIRED: "session_expired",
    CAPTCHA_REQUIRED: "captcha_required",
    FORBIDDEN: "forbidden",
    NOT_FOUND: "not_found",
    NO_DIRECT_LINK: "no_direct_link",
    HTTP: "http_error",
    NETWORK: "network_error",
});

/** An error carrying one of the codes above plus the server's own text. */
class PanError extends Error {
    constructor(code, message, extra) {
        super(message || code);
        this.name = "PanError";
        this.code = code;
        this.status = (extra && extra.status) || 0;
        this.data = (extra && extra.data) || null;
    }
}

// ---------------------------------------------------------------------------
// Request construction (pure)
// ---------------------------------------------------------------------------

/** Percent-encode one query value the way the client's serializer does. */
function encodeValue(value) {
    return encodeURIComponent(value === undefined || value === null ? "" : String(value));
}

/** Build a query string from an ordered parameter object. */
function toQueryString(params) {
    return Object.keys(params)
        .map((key) => `${key}=${encodeValue(params[key])}`)
        .join("&");
}

/** Join a base URL and a path without doubling or dropping the slash. */
function joinUrl(base, path) {
    const left = String(base || "");
    const right = String(path || "");
    if (left.endsWith("/")) return left + right.replace(/^\//, "");
    return left + (right.startsWith("/") ? right : "/" + right);
}

/**
 * Assemble the headers every drive request carries (app.js@58503).
 *
 * Three of the four are the client's identity and are always present; the
 * captcha token and the safe-box token are added only by the requests that
 * need them. `x-peer-id` switches to the drive-specific peer id when the
 * caller asks for it (`opts.useTpPeerId`), which the file-info call does.
 *
 * The cookie is not a header the original sets by hand -- it rides on
 * `withCredentials: true`, which is a browser fetch flag with no node
 * equivalent. Node has to send it explicitly, so the caller supplies the
 * cookie string and it is written out here. That is the one place this
 * differs in mechanism from the original while producing the same wire bytes.
 */
function buildPanHeaders(identity, extra) {
    const id = identity || {};
    const headers = {
        "x-peer-id": id.useTpPeerId && id.tpPeerId ? id.tpPeerId : id.peerId || "",
        "x-client-version-code": String(id.numericVersion || ""),
        "x-device-id": id.deviceId || "",
    };
    if (id.captchaToken) headers["x-captcha-token"] = id.captchaToken;
    if (id.safeToken) headers["space-authorization"] = id.safeToken;
    if (id.cookie) headers["Cookie"] = id.cookie;
    if (extra && extra.headers) Object.assign(headers, extra.headers);
    return headers;
}

/**
 * GET files -- the drive's own file listing (app.js@30702 / @31030).
 *
 * `filters` is a nested object on the wire. The recovered serializer
 * (`d.a.stringify`, app.js@57600) was not reproduced byte for byte, so the
 * JSON spelling is used; it is the form the public drive API documents and
 * the same one the alpha host accepts. `with_audit` is fixed to true by the
 * caller in the original rather than passed through.
 */
function buildListFilesRequest(identity, options) {
    const o = options || {};
    const filters = {
        phase: { eq: "PHASE_TYPE_COMPLETE" },
        trashed: { eq: false },
    };
    /*
     * A name filter for search.
     *
     * The drive's `filters` object is Google-Drive-shaped and `contains` is the
     * documented string operator, so a search is a listing with one extra
     * clause rather than a different endpoint. The original's `SearchPanTask`
     * was implemented natively and its wire shape was not recovered
     * (SETTINGS_SEARCH_NOTIFY_SPEC.md section 2.3(2) only records the call),
     * so this is the reading that needs no invention: reuse the listing the
     * client already makes.
     */
    if (o.nameContains) filters.name = { contains: String(o.nameContains) };

    const params = {
        parent_id: o.parentId || "",
        page_token: o.pageToken || "",
        limit: o.limit || 100,
        filters: JSON.stringify(filters),
        with_audit: "true",
    };
    return {
        method: "GET",
        url: joinUrl(identity.baseUrl, "files") + "?" + toQueryString(params),
        headers: buildPanHeaders(identity),
    };
}

/**
 * GET files/{fileId} -- the direct link (app.js@33436, called from @204960).
 *
 * `try_token` is only present on the trial path; a member's request omits it.
 * The drive-specific peer id is requested for this call, which is why the
 * header builder takes the flag.
 */
function buildFileInfoRequest(identity, fileId, options) {
    const o = options || {};
    const params = {};
    if (o.tryToken) params.try_token = o.tryToken;
    const query = toQueryString(params);
    const headers = buildPanHeaders(Object.assign({}, identity, { useTpPeerId: true }));
    return {
        method: "GET",
        url: joinUrl(identity.baseUrl, "files/" + encodeURIComponent(fileId)) + (query ? "?" + query : ""),
        headers,
    };
}

/**
 * GET share/file_info -- the direct link for a file inside a share
 * (app.js@463226, module 230). The method is left as GET because the
 * recovered wrapper passes no method, and the shared helper defaults to GET.
 */
function buildShareFileInfoRequest(identity, options) {
    const o = options || {};
    const params = {
        file_id: o.fileId || "",
        share_id: o.shareId || "",
        pass_code_token: o.passCodeToken || "",
    };
    return {
        method: "GET",
        url: joinUrl(identity.baseUrl, "share/file_info") + "?" + toQueryString(params),
        headers: buildPanHeaders(identity),
    };
}

/**
 * POST try/v1/{query,commit} -- trial acceleration (app.js@36233).
 *
 * `res_desc` describes the file rather than identifying it by id alone, and
 * `client` is the fixed string "PC". The scene comes from the membership
 * tier, not from the caller, which is why it is computed here.
 */
function buildTryRequest(identity, action, info) {
    const o = info || {};
    const body = {
        res_type: "PAN_RES",
        res_desc: {
            id: o.fileId || "",
            gcid: o.gcid || "",
            file_name: o.fileName || "",
            mime_type: o.mimeType || "",
        },
        try_scene: o.isSuperMember ? TRY_SCENE.super : TRY_SCENE.platinum,
        client: "PC",
    };
    return {
        method: "POST",
        url: joinUrl(identity.tryBaseUrl, "try/v1/" + action),
        headers: Object.assign(buildPanHeaders(identity), {
            "Content-Type": "application/json",
        }),
        body,
    };
}

// ---------------------------------------------------------------------------
// Response parsing (pure)
// ---------------------------------------------------------------------------

/**
 * Normalise one entry of a `files[]` array.
 *
 * The drive speaks Google-Drive-shaped objects: `kind` carries the type, so
 * a folder is `drive#folder` and everything else is a file. The numeric
 * fields arrive as strings and are converted here once, because a string
 * that stayed a string breaks arithmetic in the UI (`"1000" + 1`).
 */
function normalizeFile(raw) {
    const f = raw || {};
    const kind = f.kind || "";
    return {
        id: f.id || "",
        name: f.name || "",
        kind,
        isFolder: kind === "drive#folder",
        size: Number(f.size || 0),
        mimeType: f.mime_type || "",
        hash: f.hash || "",
        // The link may already be present in a listing; it is only valid until
        // `links[].expire`, so a download always re-reads it (see getFileInfo).
        webContentLink: f.web_content_link || "",
        iconLink: f.icon_link || "",
        thumbnailLink: f.thumbnail_link || "",
        modifiedTime: f.modified_time || "",
        phase: f.phase || "",
        // Files still being audited have no usable link and are skipped by
        // the caller; the flag is surfaced rather than hidden.
        sensitive: !!f.sensitive,
    };
}

/** `{ files, nextPageToken }` from a `files` listing. */
function parseFileList(data) {
    const list = data && Array.isArray(data.files) ? data.files : [];
    return {
        files: list.map(normalizeFile),
        nextPageToken: (data && data.next_page_token) || "",
    };
}

/**
 * Pull the direct link out of a file-info response.
 *
 * Two fields matter and the second is easy to miss:
 *   web_content_link -- the URL the downloader fetches
 *   links[<first>]    -- `{ expire, token }`; `expire` is what schedules the
 *                        refresh, and `token` is what the original hands to
 *                        `enableTaskCert` (app.js@205626)
 *
 * The key inside `links` is not a fixed name -- the original takes
 * `Object.keys(o.links)[0]` (spec section 9.1), so the same is done here.
 * Accepts either a bare file object or a `{ file_info: {...} }` wrapper so
 * the share path and the self path parse alike.
 */
function parseDirectLink(raw) {
    const f = (raw && raw.file_info) || raw || {};
    const links = f.links || null;
    let expire = "";
    let token = "";
    if (links && typeof links === "object") {
        const keys = Object.keys(links);
        if (keys.length) {
            const entry = links[keys[0]] || {};
            expire = entry.expire || "";
            token = entry.token || "";
        }
    }
    return {
        url: f.web_content_link || "",
        expire,
        token,
        name: f.name || "",
        size: Number(f.size || 0),
        hash: f.hash || "",
        mimeType: f.mime_type || "",
    };
}

/**
 * Decide what a non-200 answer means.
 *
 * `hasSession` is the caller's answer to "did I hold a session when I sent
 * this", and it is what separates the two 401 cases. A 403 whose body
 * mentions captcha is the risk-control rejection described in spec section
 * 3.1, and it is reported separately because the remedy is different: it
 * needs a device fingerprint, not a new login.
 */
function classifyPanError(status, data, hasSession) {
    const text = String(
        (data && (data.error_description || data.error || data.message || data.error_msg)) || ""
    );
    if (status === 401) {
        return hasSession ? PAN_ERROR.SESSION_EXPIRED : PAN_ERROR.NOT_LOGGED_IN;
    }
    if (status === 403) {
        return /captcha|verify|risk/i.test(text) ? PAN_ERROR.CAPTCHA_REQUIRED : PAN_ERROR.FORBIDDEN;
    }
    if (status === 404) return PAN_ERROR.NOT_FOUND;
    return PAN_ERROR.HTTP;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Cloud-drive client.
 *
 * @param {object} deps
 * @param {function} deps.getSession  -> the current identity; see below
 * @param {function} [deps.request]   the HTTP call; defaults to login.js's
 * @param {string}   [deps.env]       "prod" (default) or "test"
 * @param {function} [deps.log]
 *
 * `getSession()` returns:
 *   { userId, sessionId, peerId, tpPeerId, deviceId, numericVersion,
 *     cookie, captchaToken, safeToken }
 * An empty `sessionId` means nobody is signed in, which is what makes the
 * 401 classification possible.
 */
class PanClient {
    constructor(deps) {
        const d = deps || {};
        this.getSession = d.getSession || (() => ({}));
        this.request = d.request || request;
        const env = d.env === "test" ? "test" : "prod";
        this.env = env;
        this.baseUrl = d.baseUrl || PAN_ENDPOINTS.drive[env];
        this.shouleiBaseUrl = d.shouleiBaseUrl || PAN_ENDPOINTS.shoulei[env];
        this.tryBaseUrl = d.tryBaseUrl || TRY_ENDPOINTS[env];
        this.log = d.log || (() => {});
    }

    /** The identity a builder needs, with the base URLs filled in. */
    _identity(extra) {
        const session = this.getSession() || {};
        return Object.assign(
            {
                userId: session.userId || "",
                sessionId: session.sessionId || "",
                peerId: session.peerId || "",
                tpPeerId: session.tpPeerId || session.peerId || "",
                deviceId: session.deviceId || "",
                numericVersion: session.numericVersion || "",
                cookie: session.cookie || "",
                captchaToken: session.captchaToken || "",
                safeToken: session.safeToken || "",
                baseUrl: this.baseUrl,
                tryBaseUrl: this.tryBaseUrl,
            },
            extra || {}
        );
    }

    _hasSession() {
        const session = this.getSession() || {};
        return !!session.sessionId;
    }

    /**
     * Refuse a call before it is sent when nobody is signed in.
     *
     * The original would send it and read the 401 back. Stopping here is the
     * one place this client is deliberately smarter than the original: with no
     * session the answer is known, and a round trip to a host that will reject
     * it tells the user nothing extra. It also keeps the "not logged in" path
     * independent of the network, which is what lets it be checked offline.
     */
    _requireSession() {
        if (!this._hasSession()) {
            throw new PanError(PAN_ERROR.NOT_LOGGED_IN, "尚未登录迅雷账号");
        }
    }

    /** Run one prepared request and turn a failure into a PanError. */
    async _send(prepared) {
        let res;
        try {
            res = await this.request(prepared.url, {
                method: prepared.method,
                headers: prepared.headers,
                body: prepared.body,
            });
        } catch (err) {
            throw new PanError(PAN_ERROR.NETWORK, (err && err.message) || "request failed");
        }

        if (res.status === 200) {
            // A 200 that still carries an error field is a drive-level
            // rejection rather than a transport one; surface it as such.
            if (res.data && res.data.error && !res.data.files && !res.data.web_content_link) {
                const code = /captcha/i.test(String(res.data.error))
                    ? PAN_ERROR.CAPTCHA_REQUIRED
                    : PAN_ERROR.HTTP;
                throw new PanError(code, String(res.data.error), { status: 200, data: res.data });
            }
            return res.data;
        }

        const code = classifyPanError(res.status, res.data, this._hasSession());
        const detail =
            (res.data && (res.data.error_description || res.data.error || res.data.message)) ||
            `HTTP ${res.status}`;
        throw new PanError(code, String(detail), { status: res.status, data: res.data });
    }

    /**
     * List the drive's files under a parent (empty parent = root).
     *
     * One page per call; the caller follows `nextPageToken`. The original's
     * paged helper loops internally, but a UI that draws a page at a time
     * wants the token, so it is returned rather than consumed.
     */
    async listFiles(options) {
        this._requireSession();
        const data = await this._send(buildListFilesRequest(this._identity(), options));
        return parseFileList(data);
    }

    /** GET files/{fileId} and return the raw response (link fields included). */
    async getFileInfo(fileId, options) {
        this._requireSession();
        return this._send(buildFileInfoRequest(this._identity(), fileId, options));
    }

    /**
     * Search the drive by file name -- the original's `SearchPanTask`.
     *
     * Folders are dropped: the panel's only action is "take this back to
     * local", and a folder has no direct link. Keeping them would produce rows
     * that fail on click, which reads as a broken search rather than as a
     * folder.
     *
     * @param {string} keyword
     * @param {object} [options] `{ limit }`
     * @returns {Promise<object[]>} normalised, non-folder files
     */
    async searchFiles(keyword, options) {
        this._requireSession();
        const o = options || {};
        const data = await this._send(
            buildListFilesRequest(this._identity(), {
                limit: o.limit || 30,
                nameContains: keyword,
            })
        );
        return parseFileList(data).files.filter((file) => !file.isFolder);
    }

    /** GET share/file_info. */
    async shareFileInfo(options) {
        this._requireSession();
        return this._send(buildShareFileInfoRequest(this._identity(), options));
    }

    /** Trial query: is a trial available, and how many are left. */
    async queryTry(info) {
        this._requireSession();
        return this._send(buildTryRequest(this._identity(), "query", info));
    }

    /** Trial commit: claim a trial and receive its `try_token`. */
    async commitTry(info) {
        this._requireSession();
        return this._send(buildTryRequest(this._identity(), "commit", info));
    }

    /**
     * The whole direct-link lookup, in the original's order (app.js@204300).
     *
     * A shared file and an owned file take different routes:
     *   - shared: GET share/file_info, one call, no trial
     *   - owned:  trial query + commit first, then GET files/{id} with the
     *             resulting `try_token`
     *
     * The trial pair is best effort. The original runs it unconditionally,
     * but a member does not need it and a rejected commit must not block a
     * link that would otherwise be issued -- so a failure there is logged and
     * the file-info call proceeds without a token.
     *
     * @returns {Promise<object>} `{ ok, url, expire, token, name, ... }`
     * @throws {PanError} NO_DIRECT_LINK when the response carries no URL
     */
    async resolveDirectLink(options) {
        const o = options || {};

        if (o.shareId) {
            const data = await this.shareFileInfo({
                fileId: o.fileId,
                shareId: o.shareId,
                passCodeToken: o.passCodeToken,
            });
            return this._finish(parseDirectLink(data), { viaShare: true });
        }

        let tryToken = "";
        if (o.useTry !== false) {
            try {
                await this.queryTry(o);
                const committed = await this.commitTry(o);
                tryToken = (committed && committed.try_token) || "";
            } catch (err) {
                // Not fatal: the token only raises the priority of the link,
                // it does not gate issuing one.
                this.log("trial acceleration unavailable:", err && err.message);
            }
        }

        const data = await this.getFileInfo(o.fileId, { tryToken });
        return this._finish(parseDirectLink(data), { viaShare: false, tryToken });
    }

    _finish(link, extra) {
        if (!link.url) {
            throw new PanError(
                PAN_ERROR.NO_DIRECT_LINK,
                "the drive returned no web_content_link"
            );
        }
        return Object.assign({ ok: true }, link, extra || {});
    }

    /**
     * Whether the drive can be reached at all right now.
     *
     * Used by the window before it draws a list, so that a signed-out user
     * sees "sign in first" rather than an empty folder that looks like an
     * empty drive.
     */
    async probe() {
        if (!this._hasSession()) {
            return { ok: false, code: PAN_ERROR.NOT_LOGGED_IN, message: "尚未登录迅雷账号" };
        }
        try {
            await this.listFiles({ limit: 1 });
            return { ok: true };
        } catch (err) {
            return {
                ok: false,
                code: (err && err.code) || PAN_ERROR.NETWORK,
                message: (err && err.message) || "云盘不可用",
            };
        }
    }
}

module.exports = {
    PanClient,
    PanError,
    PAN_ERROR,
    PAN_ENDPOINTS,
    TRY_ENDPOINTS,
    TRY_SCENE,
    buildPanHeaders,
    buildListFilesRequest,
    buildFileInfoRequest,
    buildShareFileInfoRequest,
    buildTryRequest,
    toQueryString,
    joinUrl,
    normalizeFile,
    parseFileList,
    parseDirectLink,
    classifyPanError,
};
