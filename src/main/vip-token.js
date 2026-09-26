/**
 * VIP acceleration token client.
 *
 * This is the piece the user specifically asked for: the client-side half of
 * VIP download acceleration. Everything here is reproduced from the shipped
 * JavaScript, not guessed. The three findings that made it possible:
 *
 *   1. The symmetric key is derived, not stored:
 *          key = md5("xl_pc" + buildNo + userId + random)[0:16].toUpperCase()
 *
 *   2. The cipher is AES-128-ECB with an empty IV. The 16-byte key is the
 *      16 ASCII characters from step 1 -- it is NOT hex-decoded.
 *
 *   3. The token request is a POST of that ciphertext to
 *          http://ali.pc-x.speed.auth.vip.xunlei.com/speed/speedup?<query>
 *      authenticated with a Basic header built from the user id and the
 *      trial verify key.
 *
 * The response is decrypted with the same key and yields the vipCert that
 * gets handed to the download kernel.
 *
 * Original locations (for verification):
 *   out/main-renderer/renderer.js @2731731   createTokenBuffer
 *   out/main-renderer/renderer.js @2730116   praseTokenBuffer
 *   out/main-renderer/renderer.js @2734041   getUriParam / getKey
 *   out/main-renderer/renderer.js @251944    encryptBuffer / decryptBuffer
 *   out/main-renderer/renderer.js @2729618   the request itself
 */

"use strict";

const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const { ENDPOINTS, PROTOCOL, VIP_CONFIG } = require("./contract");

// ---------------------------------------------------------------------------
// Crypto primitives
// ---------------------------------------------------------------------------

/**
 * MD5 as a lowercase hex string.
 *
 * Named to match the original, whose spelling ("genarateMd5") is a typo that
 * is present at every call site. Keeping the name makes grepping the
 * recovered sources against this file straightforward.
 */
function genarateMd5(input) {
    return crypto.createHash("md5").update(input).digest("hex");
}

/**
 * Derive the AES key for a token request.
 *
 * @param {string|number} userId
 * @param {string|number} random  timestamp or nonce chosen by the caller
 * @param {string|number} buildNo numeric build number, e.g. "2662"
 * @returns {string} 16 uppercase hex characters, used as raw ASCII bytes
 */
function deriveKey(userId, random, buildNo) {
    const material = PROTOCOL.VIP_CLIENT_NAME + buildNo + userId + random;
    return genarateMd5(material).substr(0, 16).toUpperCase();
}

/**
 * AES-128-ECB encrypt.
 *
 * ECB needs no IV, and the original passes the empty string; Node accepts
 * that and ignores it. The key is used as a UTF-8 string, so it must be
 * exactly 16 bytes -- which the derivation guarantees.
 */
function encryptBuffer(plain, key) {
    const cipher = crypto.createCipheriv("aes-128-ecb", key, "");
    return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** AES-128-ECB decrypt. Inverse of encryptBuffer. */
function decryptBuffer(cipherText, key) {
    const decipher = crypto.createDecipheriv("aes-128-ecb", key, "");
    return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

/** JSON -> UTF-8 -> AES. The request body format. */
function encryptHttpBuffer(obj, key) {
    const json = JSON.stringify(obj);
    return encryptBuffer(Buffer.from(json), key);
}

/**
 * AES -> UTF-8 -> JSON.
 *
 * Returns null rather than throwing when the payload does not decrypt or
 * parse, because the original treats both as "no data" and lets the caller
 * decide. A throw here would surface as an unexplained failure on a token
 * refresh, which is a routine event.
 */
function decryptHttpBuffer(buf, key) {
    let plain;
    try {
        plain = decryptBuffer(buf, key);
    } catch (err) {
        return null;
    }
    if (!plain) return null;
    try {
        return JSON.parse(plain.toString());
    } catch (err) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Request shaping
// ---------------------------------------------------------------------------

/**
 * Build the URL query string for a token request.
 *
 * The two flavours in the original differ slightly; this follows the fuller
 * one used by the main renderer, which is the path that actually runs.
 */
function buildQuery({ sequence, timestamp, isVip, buildNo, verifyType }) {
    const parts = [
        `client_name=${PROTOCOL.VIP_CLIENT_NAME}`,
        `client_version=${buildNo}`,
        "release_version=1.0.0",
        "client_sequence=123456",
        `r=${timestamp}`,
        `verify_type=${verifyType === undefined ? 1 : verifyType}`,
        "isgroup=0",
        `isvip=${isVip ? 1 : 0}`,
    ];
    return parts.join("&");
}

/**
 * Assemble the token request payload.
 *
 * `file_index` is only present for BT tasks (taskType 2). For everything else
 * the field is omitted entirely rather than sent as null, because the
 * serializer drops undefined and the server distinguishes the two.
 */
function buildTaskInfos(taskInfo) {
    const files = [];
    for (let i = 0; i < taskInfo.files.length; i++) {
        const f = taskInfo.files[i];
        const entry = {
            url: f.url,
            filename: f.fileName,
            gcid: f.gcid,
            cid: f.cid,
            filesize: f.fileSize,
            refer_url: f.refUrl,
            cookies: "",
            tokeninfo: taskInfo.oldTokens ? taskInfo.oldTokens[i] : "",
        };
        if (taskInfo.taskType === 2) {
            entry.file_index = f.subId;
        }
        files.push(entry);
    }
    return files;
}

/** POST helper. Kept small: the token endpoint is plain HTTP. */
function post(urlString, body, headers, timeoutMs) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlString);
        const lib = url.protocol === "https:" ? https : http;
        const req = lib.request(
            {
                method: "POST",
                hostname: url.hostname,
                port: url.port || (url.protocol === "https:" ? 443 : 80),
                path: url.pathname + url.search,
                headers,
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(chunks) });
                });
            }
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error("timeout"));
        });
        req.on("error", reject);
        req.end(body);
    });
}

// ---------------------------------------------------------------------------
// Token client
// ---------------------------------------------------------------------------

/**
 * Issues and refreshes VIP acceleration certificates.
 *
 * One instance per running client. `callServerFunction` is injected so this
 * module stays free of any dependency on the RPC wiring.
 */
class VipTokenClient {
    /**
     * @param {object} deps
     * @param {function} deps.callServerFunction  (name, ...args) => Promise
     * @param {function} deps.getBuildNo          () => string
     */
    constructor(deps) {
        this.callServerFunction = deps.callServerFunction;
        this.getBuildNo = deps.getBuildNo;

        this.sequence = 0;
        this.host = ENDPOINTS.VIP_SPEED_HOST;
        this.retries = 2;
        this.timeout = 20000;

        /** taskId -> { cert, expireAt, timer } */
        this.certs = new Map();
    }

    /** Monotonic request sequence. The server uses it for replay detection. */
    _nextSequence() {
        this.sequence += 1;
        return this.sequence;
    }

    /**
     * Query a token (or the status of an existing one).
     *
     * @param {object} taskInfo   files, taskType, infoId, btTitle, userId
     * @param {boolean} [statusOnly] true to hit /speed/res_status instead
     * @returns {Promise<object|null>} the parsed cert, or null on failure
     */
    async queryToken(taskInfo, statusOnly = false) {
        const [userId, peerId, vipInfo] = await Promise.all([
            this.callServerFunction("GetUserID"),
            this.callServerFunction("GetPeerID"),
            this.callServerFunction("GetVipInfo"),
        ]);

        const sequence = this._nextSequence();
        const timestamp = Math.floor(Date.now() / 1000);
        const buildNo = this.getBuildNo();

        const key = deriveKey(userId, timestamp, buildNo);

        const payload = {
            peer_id: peerId,
            infohash: taskInfo.infoId,
            bt_title: taskInfo.btTitle,
            task_infos: buildTaskInfos(taskInfo),
            extra_infos: { bt_token_mode: 1 },
        };

        const body = encryptHttpBuffer(payload, key);

        const query = buildQuery({
            sequence,
            timestamp,
            isVip: !!(vipInfo && vipInfo.isVip),
            buildNo,
        });

        const path = statusOnly
            ? ENDPOINTS.VIP_SPEED_PATH_STATUS
            : ENDPOINTS.VIP_SPEED_PATH_QUERY;

        const url = `http://${this.host}${path}?${query}`;

        // The trial verify key participates in the Basic credential. When it
        // is absent the credential is just "userId:" which the server treats
        // as a non-trial request.
        const trialVerifyInfo = taskInfo.trialVerifyInfo || "";
        const authRaw = `${userId}:${trialVerifyInfo}`;

        const headers = {
            Authorization: `Basic ${Buffer.from(authRaw).toString("base64")}`,
            Accept: PROTOCOL.VIP_ACCEPT,
            "Content-Type": "application/octet-stream",
            "Content-Length": body.length,
        };

        let lastError = null;
        for (let attempt = 0; attempt <= this.retries; attempt++) {
            try {
                const res = await post(url, body, headers, this.timeout);
                if (res.status !== 200) {
                    lastError = new Error(`token endpoint returned ${res.status}`);
                    continue;
                }
                return this.parseTokenBuffer(userId, timestamp, res.data, statusOnly, buildNo);
            } catch (err) {
                lastError = err;
            }
        }

        if (lastError) this.emitError?.(lastError);
        return null;
    }

    /**
     * Decrypt and reshape a token response.
     *
     * The field renaming is part of the contract: the wire format calls the
     * long text `message` and the short text `simple_msg`, while every
     * consumer of the parsed object expects `detailMessage` and `message`.
     * Swapping them here keeps that translation in one place.
     */
    parseTokenBuffer(userId, timestamp, respBuf, statusOnly, buildNo) {
        const key = deriveKey(userId, timestamp, buildNo);
        const obj = decryptHttpBuffer(respBuf, key);
        if (!obj) return null;

        const out = obj;
        out.detailMessage = obj.message;
        out.message = obj.simple_msg;
        return out;
    }

    /**
     * Request a cert and remember when it expires.
     *
     * The refresh margin comes from the shipped config: refresh 300 seconds
     * before expiry, and treat anything under 20 seconds as already dead.
     */
    async requestCert(taskId, taskInfo) {
        const cert = await this.queryToken(taskInfo, false);
        if (!cert) return null;

        const ttl = Number(cert.expires_in || cert.expire_in || 0);
        const now = Date.now();
        const record = {
            cert,
            issuedAt: now,
            expireAt: ttl > 0 ? now + ttl * 1000 : 0,
        };
        this.certs.set(taskId, record);
        return record;
    }

    /** True when a cached cert is missing, dead, or inside the refresh margin. */
    needsRefresh(taskId) {
        const record = this.certs.get(taskId);
        if (!record) return true;
        if (!record.expireAt) return false;
        const remaining = (record.expireAt - Date.now()) / 1000;
        if (remaining <= VIP_CONFIG.TOKEN_EXPIRE_MIN_SECOND) return true;
        return remaining <= VIP_CONFIG.TOKEN_EXPIRE_ADVANCE_SECOND;
    }

    getCert(taskId) {
        const record = this.certs.get(taskId);
        return record ? record.cert : null;
    }

    forget(taskId) {
        this.certs.delete(taskId);
    }
}

module.exports = {
    genarateMd5,
    deriveKey,
    encryptBuffer,
    decryptBuffer,
    encryptHttpBuffer,
    decryptHttpBuffer,
    buildQuery,
    buildTaskInfos,
    VipTokenClient,
};
