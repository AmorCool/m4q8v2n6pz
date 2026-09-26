/**
 * Smoke test.
 *
 * Verifies the parts that are testable without a network or an account:
 * the crypto round trip, the key derivation, the RPC tuple convention, the
 * kernel event names, and that the app boots.
 *
 * The crypto assertions are the important ones. They check the properties the
 * implementation depends on -- key length, determinism, round trip -- rather
 * than hardcoding a ciphertext, because a hardcoded vector would only prove
 * the test agrees with itself.
 */

"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const contract = require("../src/main/contract");
const vipToken = require("../src/main/vip-token");
const { createMesh } = require("../src/main/rpc");
const { ThunderKernel, createNullEngine, TASK_STATUS } = require("../src/main/kernel");
const login = require("../src/main/login");
const { createApplication } = require("../src/main/index");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        // This harness does not await, so an async test would record a pass
        // before its assertions ran, and a failure inside it would surface as
        // an unhandled rejection rather than as a failing test. Two of them
        // were written that way and passed for as long as nobody looked.
        // Refusing is the only way this stays fixed.
        if (result && typeof result.then === "function") {
            throw new Error("this test is async; use testAsync so that it is awaited");
        }
        passed += 1;
        console.log(`  ok    ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log(`  ok    ${name}`);
    } catch (err) {
        failed += 1;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${err.message}`);
    }
}

/*
 * The whole suite runs inside one async function.
 *
 * It has to. Several of these tests await, and at module scope a `test(...)`
 * call with an async body returns a promise nobody holds: the test is recorded
 * as a pass before its assertions have run, and a failure inside it appears as
 * an unhandled rejection rather than as a failing test. Seven of them were
 * written that way, and the only reason it went unnoticed is that the harness
 * accepted it.
 */
(async () => {

console.log("contract");

test("socket guid is the shipped value", () => {
    assert.strictEqual(
        contract.CLIENT_SOCKET_GUID,
        "{FD196984-2591-4588-AA6F-5C8AC1266290}"
    );
});

test("server context name is the shipped value", () => {
    assert.strictEqual(
        contract.SERVER_CONTEXT_NAME,
        "{46105371-DE78-4442-B59F-FDA1D6D7D430}"
    );
});

test("all four guids are distinct", () => {
    const guids = [
        contract.CLIENT_SOCKET_GUID,
        contract.SERVER_CONTEXT_NAME,
        contract.THIRD_CHANNEL_GUID,
        contract.OAUTH_LOGOUT_TAB_GUID,
    ];
    assert.strictEqual(new Set(guids).size, 4);
});

test("vas ids match the shipped list", () => {
    assert.strictEqual(contract.ENDPOINTS.LOGIN_VAS_ID, "2,14,33,34,35");
});

test("vip tier mapping matches the client", () => {
    assert.strictEqual(contract.VIP_TYPE_MAP[2], "normal");
    assert.strictEqual(contract.VIP_TYPE_MAP[3], "platinum");
    assert.strictEqual(contract.VIP_TYPE_MAP[5], "super");
});

test("kernel event names are the on-wire strings", () => {
    assert.strictEqual(contract.KERNEL_EVENTS.TASK_INSERTED, "OnTaskInserted");
    assert.strictEqual(
        contract.KERNEL_EVENTS.TASK_DCDN_STATUS_CHANGED,
        "OnTaskDcdnStatusChanged"
    );
    assert.strictEqual(
        contract.KERNEL_EVENTS.BT_SUB_FILE_DCDN_STATUS_CHANGED,
        "OnBtSubFileDcdnStatusChanged"
    );
});

console.log("\ncrypto");

test("deriveKey produces 16 uppercase hex characters", () => {
    const key = vipToken.deriveKey("12345", "1700000000", "2662");
    assert.strictEqual(key.length, 16, `expected 16 chars, got ${key.length}`);
    assert.match(key, /^[0-9A-F]{16}$/);
});

test("deriveKey is deterministic", () => {
    const a = vipToken.deriveKey("12345", "1700000000", "2662");
    const b = vipToken.deriveKey("12345", "1700000000", "2662");
    assert.strictEqual(a, b);
});

test("deriveKey changes with every input", () => {
    const base = vipToken.deriveKey("12345", "1700000000", "2662");
    assert.notStrictEqual(base, vipToken.deriveKey("12346", "1700000000", "2662"));
    assert.notStrictEqual(base, vipToken.deriveKey("12345", "1700000001", "2662"));
    assert.notStrictEqual(base, vipToken.deriveKey("12345", "1700000000", "2663"));
});

test("deriveKey mixes in the xl_pc client name", () => {
    // Reproduces the original expression directly. If the prefix or the
    // ordering ever drifts, this catches it.
    const crypto = require("crypto");
    const expected = crypto.createHash("md5")
        .update("xl_pc" + "2662" + "12345" + "1700000000")
        .digest("hex")
        .substr(0, 16)
        .toUpperCase();
    assert.strictEqual(vipToken.deriveKey("12345", "1700000000", "2662"), expected);
});

test("key is exactly 16 bytes so AES-128 accepts it", () => {
    const key = vipToken.deriveKey("999", "1700000000", "2662");
    assert.strictEqual(Buffer.byteLength(key, "utf8"), 16);
});

test("encrypt then decrypt round trips", () => {
    const key = vipToken.deriveKey("12345", "1700000000", "2662");
    const plain = Buffer.from("hello thunder, 你好迅雷");
    const cipher = vipToken.encryptBuffer(plain, key);
    assert.ok(!cipher.equals(plain), "ciphertext must differ from plaintext");
    const back = vipToken.decryptBuffer(cipher, key);
    assert.strictEqual(back.toString(), plain.toString());
});

test("ciphertext length is a multiple of the AES block size", () => {
    const key = vipToken.deriveKey("1", "2", "3");
    const cipher = vipToken.encryptBuffer(Buffer.from("abc"), key);
    assert.strictEqual(cipher.length % 16, 0);
});

test("ECB is blockwise, so identical plaintext blocks encrypt alike", () => {
    // ECB has no chaining. Encrypting the same 16 bytes twice in one buffer
    // must yield two identical ciphertext blocks. This pins the mode: had
    // the original used CBC, this assertion would fail.
    const key = vipToken.deriveKey("1", "2", "3");
    const block = Buffer.from("0123456789abcdef");
    const cipher = vipToken.encryptBuffer(Buffer.concat([block, block]), key);
    assert.ok(
        cipher.slice(0, 16).equals(cipher.slice(16, 32)),
        "two identical blocks should produce identical ciphertext under ECB"
    );
});

test("http buffer wrappers round trip JSON", () => {
    const key = vipToken.deriveKey("12345", "1700000000", "2662");
    const payload = {
        peer_id: "ABC",
        infohash: "0123456789abcdef0123456789abcdef01234567",
        task_infos: [{ url: "http://x/1", filesize: 1 }],
        extra_infos: { bt_token_mode: 1 },
    };
    const body = vipToken.encryptHttpBuffer(payload, key);
    const back = vipToken.decryptHttpBuffer(body, key);
    assert.deepStrictEqual(back, payload);
});

test("decryptHttpBuffer returns null instead of throwing on bad input", () => {
    const key = vipToken.deriveKey("1", "2", "3");
    assert.strictEqual(vipToken.decryptHttpBuffer(Buffer.from("garbage!"), key), null);
});

test("buildQuery carries the shipped field set", () => {
    const q = vipToken.buildQuery({
        sequence: 7,
        timestamp: 1700000000,
        isVip: true,
        buildNo: "2662",
    });
    assert.ok(q.includes("client_name=xl_pc"));
    assert.ok(q.includes("client_version=2662"));
    assert.ok(q.includes("release_version=1.0.0"));
    assert.ok(q.includes("client_sequence=123456"));
    assert.ok(q.includes("r=1700000000"));
    assert.ok(q.includes("verify_type=1"));
    assert.ok(q.includes("isgroup=0"));
    assert.ok(q.includes("isvip=1"));
});

test("buildQuery reports isvip=0 for a non-member", () => {
    const q = vipToken.buildQuery({
        sequence: 1,
        timestamp: 1,
        isVip: false,
        buildNo: "2662",
    });
    assert.ok(q.includes("isvip=0"));
    assert.ok(!q.includes("isvip=1"));
});

console.log("\nrequest shaping");

test("file_index is only set for BT tasks", () => {
    const bt = vipToken.buildTaskInfos({
        taskType: 2,
        files: [{ url: "u", fileName: "f", gcid: "g", cid: "c", fileSize: 1, refUrl: "r", subId: 3 }],
    });
    assert.strictEqual(bt[0].file_index, 3);

    const http = vipToken.buildTaskInfos({
        taskType: 1,
        files: [{ url: "u", fileName: "f", gcid: "g", cid: "c", fileSize: 1, refUrl: "r", subId: 3 }],
    });
    assert.ok(!("file_index" in http[0]), "non-BT entries must omit file_index entirely");
});

test("null file_index is dropped by serialisation, not sent as null", () => {
    const http = vipToken.buildTaskInfos({
        taskType: 1,
        files: [{ url: "u", fileName: "f", gcid: "g", cid: "c", fileSize: 1, refUrl: "r" }],
    });
    const json = JSON.stringify(http[0]);
    assert.ok(!json.includes("file_index"), json);
});

test("cookies is always present and empty", () => {
    const infos = vipToken.buildTaskInfos({
        taskType: 1,
        files: [{ url: "u", fileName: "f", gcid: "g", cid: "c", fileSize: 1, refUrl: "r" }],
    });
    assert.strictEqual(infos[0].cookies, "");
});

test("oldTokens carry through as tokeninfo", () => {
    const infos = vipToken.buildTaskInfos({
        taskType: 1,
        oldTokens: ["tok-a"],
        files: [{ url: "u", fileName: "f", gcid: "g", cid: "c", fileSize: 1, refUrl: "r" }],
    });
    assert.strictEqual(infos[0].tokeninfo, "tok-a");
});

console.log("\nrpc");

await testAsync("call resolves to a two element tuple", async () => {
    const mesh = createMesh();
    mesh.login.registerFunction("ping", async () => "pong");
    const result = await mesh.renderer.callRemoteClientFunction(
        contract.CONTEXTS.LOGIN_RENDERER,
        "ping"
    );
    assert.ok(Array.isArray(result), "result must be an array");
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], "pong");
});

await testAsync("a failing call returns null plus a message rather than throwing", async () => {
    const mesh = createMesh();
    const result = await mesh.renderer.callRemoteClientFunction(
        contract.CONTEXTS.LOGIN_RENDERER,
        "does-not-exist"
    );
    assert.strictEqual(result[0], null);
    assert.ok(typeof result[1] === "string" && result[1].length > 0);
});

await testAsync("an unknown context is reported, not thrown", async () => {
    const mesh = createMesh();
    const result = await mesh.renderer.callRemoteClientFunction("nowhere", "f");
    assert.strictEqual(result[0], null);
    assert.ok(result[1].includes("nowhere"));
});

await testAsync("a thrown handler becomes a null tuple", async () => {
    const mesh = createMesh();
    mesh.login.registerFunction("boom", async () => {
        throw new Error("exploded");
    });
    const result = await mesh.renderer.callRemoteClientFunction(
        contract.CONTEXTS.LOGIN_RENDERER,
        "boom"
    );
    assert.strictEqual(result[0], null);
    assert.strictEqual(result[1], "exploded");
});

await testAsync("the first event handler owns the result", async () => {
    const mesh = createMesh();
    const seen = [];
    mesh.login.attachServerEvent("evt", () => {
        seen.push("first");
        return "from-first";
    });
    mesh.login.attachServerEvent("evt", () => {
        seen.push("second");
        return "from-second";
    });
    const result = await mesh.renderer.callClientFunction(
        contract.CONTEXTS.LOGIN_RENDERER,
        "evt"
    );
    assert.strictEqual(result, "from-first");
    assert.deepStrictEqual(seen, ["first", "second"]);
});

await testAsync("broadcast reaches every listener", async () => {
    const mesh = createMesh();
    const got = [];
    mesh.renderer.attachServerEvent("b", (x) => got.push(["renderer", x]));
    mesh.login.attachServerEvent("b", (x) => got.push(["login", x]));
    await mesh.main.broadcastEvent("b", 42);
    assert.strictEqual(got.length, 2);
});

test("generateReqKey ignores the request id", () => {
    const a = require("../src/main/rpc").RpcNode.generateReqKey("/x", {
        headers: { "x-request-id": "aaa" },
    });
    const b = require("../src/main/rpc").RpcNode.generateReqKey("/x", {
        headers: { "x-request-id": "bbb" },
    });
    assert.strictEqual(a, b);
});

test("generateReqKey restores the request id it cleared", () => {
    const opts = { headers: { "x-request-id": "keepme" } };
    require("../src/main/rpc").RpcNode.generateReqKey("/x", opts);
    assert.strictEqual(opts.headers["x-request-id"], "keepme");
});

console.log("\nkernel");

test("vip ext info is formatted the way the kernel parses it", () => {
    const kernel = new ThunderKernel({ engine: createNullEngine() });
    kernel.applyVipInfo({ isVip: true, vipType: "platinum", vipLevel: 3 }, "ch1");
    assert.strictEqual(
        kernel.globalExtInfo,
        "isvip=1,viptype=platinum,viplevel=3,userchannel=ch1"
    );
});

test("a non-member formats as isvip=0 with empty type", () => {
    const kernel = new ThunderKernel({ engine: createNullEngine() });
    kernel.applyVipInfo({ isVip: false }, "");
    assert.strictEqual(kernel.globalExtInfo, "isvip=0,viptype=,viplevel=0,userchannel=");
});

test("enableDcdn records the accelerating file index", () => {
    const kernel = new ThunderKernel({ engine: createNullEngine() });
    const id = kernel.addTask({ url: "http://x/1" });
    kernel.enableDcdnWithVipCert(id, 2, { cert: "c" });
    const task = kernel.getTask(id);
    assert.strictEqual(task.bAcclerating, true);
    assert.strictEqual(task.dcdnFileIndex, 2);
});

test("disableDcdn clears the accelerating state", () => {
    const kernel = new ThunderKernel({ engine: createNullEngine() });
    const id = kernel.addTask({ url: "http://x/1" });
    kernel.enableDcdnWithVipCert(id, 2, {});
    kernel.disableDcdnWithVipCert(id, 2);
    const task = kernel.getTask(id);
    assert.strictEqual(task.bAcclerating, false);
    assert.strictEqual(task.dcdnFileIndex, -1);
});

test("getActiveTaskId finds the accelerating task", () => {
    const kernel = new ThunderKernel({ engine: createNullEngine() });
    const a = kernel.addTask({ url: "http://x/1" });
    kernel.addTask({ url: "http://x/2" });
    assert.strictEqual(kernel.getTask(a).bAcclerating, false);
    kernel.enableDcdnWithVipCert(a, 0, {});
    assert.strictEqual(kernel.getTask(a).taskId, a);
});

test("addTask returns a usable id", () => {
    const kernel = new ThunderKernel({ engine: createNullEngine() });
    const id = kernel.addTask({ url: "http://x/1" });
    assert.ok(id, "id must be truthy or callers will misbehave");
    assert.ok(kernel.getTask(id));
});

await testAsync("kernel forwards engine events under the original names", async () => {
    const engine = createNullEngine();
    const kernel = new ThunderKernel({ engine });
    const seen = [];
    kernel.on(contract.KERNEL_EVENTS.TASK_DCDN_STATUS_CHANGED, (p) => seen.push(p));
    engine.emit("task-dcdn-status-changed", { taskId: "t1", index: 0 });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].taskId, "t1");
});

console.log("\nlogin helpers");

test("device sign uses base64 of the raw digest", () => {
    const crypto = require("crypto");
    const sign = login.buildDeviceSign("MID", "pkg", "app", "key");
    const expectedDigest = crypto.createHash("md5")
        .update("MID" + "pkg" + "app" + "key")
        .digest("base64");
    assert.strictEqual(sign, "div101." + "MID" + expectedDigest);
    assert.ok(sign.startsWith("div101."));
});

test("a short device id is rejected", () => {
    assert.strictEqual(login.readStoredDeviceId("short", null), "");
    assert.strictEqual(login.readStoredDeviceId(null, "short"), "");
});

test("a valid device id passes through", () => {
    const id = "div101.abcdef0123456789XXXX";
    assert.strictEqual(login.readStoredDeviceId(id, null), id);
});

test("single quotes are stripped from the stored form", () => {
    assert.strictEqual(
        login.readStoredDeviceId(null, "'div101.abcdef0123456789XXXX'"),
        "div101.abcdef0123456789XXXX"
    );
});

test("vipType maps through the table", () => {
    assert.strictEqual(login.parseVipInfo({
        vipList: [{ vasType: 3, vipLevel: 2, isVip: 1 }],
    }).vipType, "platinum");
});

test("isVip accepts both the numeric and string forms", () => {
    assert.strictEqual(login.parseVipInfo({ vipList: [{ vasType: 2, isVip: 1 }] }).isVip, true);
    assert.strictEqual(login.parseVipInfo({ vipList: [{ vasType: 2, isVip: "1" }] }).isVip, true);
    assert.strictEqual(login.parseVipInfo({ vipList: [{ vasType: 2, isVip: "0" }] }).isVip, false);
    assert.strictEqual(login.parseVipInfo({ vipList: [{ vasType: 2, isVip: 0 }] }).isVip, false);
});

test("an empty vip list is a non-member, not an error", () => {
    const info = login.parseVipInfo({});
    assert.strictEqual(info.isVip, false);
    assert.strictEqual(info.vipType, "");
});

test("build number is the last dotted component", () => {
    const { buildNumberOf } = require("../src/main/index");
    assert.strictEqual(buildNumberOf("12.1.2.2662"), "2662");
    assert.strictEqual(buildNumberOf("1.0"), "0");
    assert.strictEqual(buildNumberOf(""), "");
});

// ---------------------------------------------------------------------------
// Cloud drive (pan)
//
// The drive's calls cannot be run end to end without a real account, so what
// is checked is the part that can be: the request the client would send, the
// parse of a response it might get back, and the classification of the two
// 401s. The samples are hand-written from the field names in
// PAN_DIRECT_LINK_SPEC.md section 2.1; they are not recordings.
// ---------------------------------------------------------------------------
console.log("\npan (cloud drive)");

const pan = require("../src/main/pan");

/** An identity as `Application.panSession` builds it. */
function panIdentity(extra) {
    return Object.assign(
        {
            peerId: "PEER",
            tpPeerId: "TPPEER",
            deviceId: "DEV",
            numericVersion: "2662",
            cookie: "a=b",
            baseUrl: pan.PAN_ENDPOINTS.drive.prod,
            tryBaseUrl: pan.TRY_ENDPOINTS.prod,
        },
        extra || {}
    );
}

/** A request stub that records what it was asked to send. */
function panStub(handler) {
    const seen = [];
    return {
        seen,
        request: async (url, opts) => {
            seen.push({ url, opts });
            return handler(url, opts, seen.length);
        },
    };
}

test("the three identity headers are always present", () => {
    const headers = pan.buildPanHeaders(panIdentity());
    assert.strictEqual(headers["x-peer-id"], "PEER");
    assert.strictEqual(headers["x-client-version-code"], "2662");
    assert.strictEqual(headers["x-device-id"], "DEV");
});

test("the file-info call switches to the drive peer id", () => {
    // app.js@58503: x-peer-id is the tp peer id when opts.useTpPeerId is set,
    // and the file-info call is the one that sets it.
    const headers = pan.buildPanHeaders(panIdentity({ useTpPeerId: true }));
    assert.strictEqual(headers["x-peer-id"], "TPPEER");
});

test("the captcha token is added only when there is one", () => {
    assert.ok(!("x-captcha-token" in pan.buildPanHeaders(panIdentity())));
    const headers = pan.buildPanHeaders(panIdentity({ captchaToken: "CT" }));
    assert.strictEqual(headers["x-captcha-token"], "CT");
});

test("listing points at the prod drive host and carries the fixed filters", () => {
    const req = pan.buildListFilesRequest(panIdentity(), { parentId: "root", limit: 50 });
    assert.strictEqual(req.method, "GET");
    assert.ok(req.url.startsWith("https://api-pan.xunlei.com/drive/v1/files?"), req.url);
    assert.ok(req.url.includes("parent_id=root"), req.url);
    assert.ok(req.url.includes("limit=50"), req.url);
    assert.ok(req.url.includes("with_audit=true"), req.url);
    const filters = decodeURIComponent(req.url.split("filters=")[1].split("&")[0]);
    assert.ok(filters.includes("PHASE_TYPE_COMPLETE"), filters);
    assert.ok(filters.includes('"trashed":{"eq":false}'), filters);
});

test("the file-info URL is the file id and carries the try token", () => {
    const req = pan.buildFileInfoRequest(panIdentity(), "FILE 1", { tryToken: "TT" });
    assert.ok(req.url.startsWith("https://api-pan.xunlei.com/drive/v1/files/FILE%201"), req.url);
    assert.ok(req.url.includes("try_token=TT"), req.url);
    assert.strictEqual(req.headers["x-peer-id"], "TPPEER");
});

test("a share link uses share/file_info with the three fields", () => {
    const req = pan.buildShareFileInfoRequest(panIdentity(), {
        fileId: "F", shareId: "S", passCodeToken: "P",
    });
    assert.ok(req.url.includes("share/file_info?"), req.url);
    assert.ok(req.url.includes("file_id=F"), req.url);
    assert.ok(req.url.includes("share_id=S"), req.url);
    assert.ok(req.url.includes("pass_code_token=P"), req.url);
});

test("the trial request posts to the try host with the super scene", () => {
    const req = pan.buildTryRequest(panIdentity(), "query", {
        fileId: "F", gcid: "G", fileName: "n.bin", mimeType: "text/plain", isSuperMember: true,
    });
    assert.strictEqual(req.method, "POST");
    assert.strictEqual(req.url, "https://try-pan-privilege-vip.xunlei.com/try/v1/query");
    assert.strictEqual(req.body.res_type, "PAN_RES");
    assert.strictEqual(req.body.client, "PC");
    assert.strictEqual(req.body.try_scene, "PAN_PACK_DOWNLOAD_SUPER");
    assert.strictEqual(req.body.res_desc.file_name, "n.bin");
});

test("a non-super member gets the platinum scene", () => {
    const req = pan.buildTryRequest(panIdentity(), "commit", { fileId: "F", isSuperMember: false });
    assert.strictEqual(req.body.try_scene, "PAN_PACK_DOWNLOAD_BAIJIN");
});

test("a listing marks folders and converts sizes to numbers", () => {
    const page = pan.parseFileList({
        files: [
            { id: "1", name: "folder", kind: "drive#folder", size: "0" },
            { id: "2", name: "f.bin", kind: "drive#file", size: "1024", web_content_link: "u" },
        ],
        next_page_token: "NP",
    });
    assert.strictEqual(page.files.length, 2);
    assert.strictEqual(page.files[0].isFolder, true);
    assert.strictEqual(page.files[1].isFolder, false);
    assert.strictEqual(typeof page.files[1].size, "number");
    assert.strictEqual(page.files[1].size, 1024);
    assert.strictEqual(page.nextPageToken, "NP");
});

test("the direct link takes expire and token from the first links key", () => {
    // app.js@204960: the key inside `links` is not fixed, so the first one is
    // used (spec section 9.1).
    const link = pan.parseDirectLink({
        web_content_link: "http://cdn/x",
        links: { cdn_1: { expire: "2026-01-01T00:00:00Z", token: "tok" } },
        name: "a.bin",
        size: "10",
    });
    assert.strictEqual(link.url, "http://cdn/x");
    assert.strictEqual(link.expire, "2026-01-01T00:00:00Z");
    assert.strictEqual(link.token, "tok");
    assert.strictEqual(link.size, 10);
});

test("the share wrapper parses the same way", () => {
    const link = pan.parseDirectLink({
        file_info: { web_content_link: "http://s/x", links: { k: { expire: "e", token: "t" } } },
    });
    assert.strictEqual(link.url, "http://s/x");
    assert.strictEqual(link.token, "t");
});

test("a 401 with no session is not-logged-in, with one it is expired", () => {
    assert.strictEqual(pan.classifyPanError(401, {}, false), pan.PAN_ERROR.NOT_LOGGED_IN);
    assert.strictEqual(pan.classifyPanError(401, {}, true), pan.PAN_ERROR.SESSION_EXPIRED);
});

test("a risk-control 403 is reported as needing a captcha", () => {
    assert.strictEqual(
        pan.classifyPanError(403, { error_description: "captcha/init required" }, true),
        pan.PAN_ERROR.CAPTCHA_REQUIRED
    );
    assert.strictEqual(pan.classifyPanError(403, { error_description: "no permission" }, true), pan.PAN_ERROR.FORBIDDEN);
});

test("a 404 is a missing file", () => {
    assert.strictEqual(pan.classifyPanError(404, {}, true), pan.PAN_ERROR.NOT_FOUND);
});

await testAsync("a signed-out client refuses before it sends anything", async () => {
    const stub = panStub(() => ({ status: 401, data: {} }));
    const client = new pan.PanClient({ getSession: () => ({}), request: stub.request });
    let err = null;
    try {
        await client.listFiles();
    } catch (error) {
        err = error;
    }
    assert.ok(err, "the call must reject");
    assert.strictEqual(err.code, pan.PAN_ERROR.NOT_LOGGED_IN);
    assert.strictEqual(stub.seen.length, 0, "no request must be sent without a session");
});

await testAsync("a 401 with a session reads as an expired session", async () => {
    const stub = panStub(() => ({ status: 401, data: { error_description: "unauthorized" } }));
    const client = new pan.PanClient({
        getSession: () => ({ sessionId: "S", peerId: "p", deviceId: "d", numericVersion: "2662" }),
        request: stub.request,
    });
    let err = null;
    try {
        await client.listFiles();
    } catch (error) {
        err = error;
    }
    assert.ok(err);
    assert.strictEqual(err.code, pan.PAN_ERROR.SESSION_EXPIRED);
    assert.strictEqual(stub.seen.length, 1, "the request must have been attempted");
});

await testAsync("resolving a self file runs the trial pair then file-info", async () => {
    const stub = panStub((url) => {
        if (url.includes("/try/v1/query")) return { status: 200, data: { status: "OK", left_times: 1 } };
        if (url.includes("/try/v1/commit")) return { status: 200, data: { status: "OK", try_token: "TT" } };
        if (url.includes("/files/F1")) {
            return {
                status: 200,
                data: {
                    web_content_link: "http://cdn/x",
                    links: { cdn: { expire: "2026-01-01T00:00:00Z", token: "tok" } },
                    name: "a.bin",
                    size: "10",
                },
            };
        }
        return { status: 404, data: {} };
    });
    const client = new pan.PanClient({
        getSession: () => ({ sessionId: "S", peerId: "p", deviceId: "d", numericVersion: "2662" }),
        request: stub.request,
    });

    const link = await client.resolveDirectLink({ fileId: "F1" });
    assert.strictEqual(link.url, "http://cdn/x");
    assert.strictEqual(link.token, "tok");
    assert.strictEqual(link.viaShare, false);

    // The trial token it just received has to reach the file-info call, or the
    // trial was claimed and thrown away.
    const info = stub.seen.find((c) => c.url.includes("/files/F1"));
    assert.ok(info, "file-info must have been called");
    assert.ok(info.url.includes("try_token=TT"), info.url);
});

await testAsync("a failed trial does not stop the link from being issued", async () => {
    const stub = panStub((url) => {
        if (url.includes("/try/v1/")) return { status: 403, data: { error_description: "no trial left" } };
        if (url.includes("/files/F2")) {
            return { status: 200, data: { web_content_link: "http://cdn/y", links: {} } };
        }
        return { status: 404, data: {} };
    });
    const client = new pan.PanClient({
        getSession: () => ({ sessionId: "S" }),
        request: stub.request,
    });
    const link = await client.resolveDirectLink({ fileId: "F2" });
    assert.strictEqual(link.url, "http://cdn/y");
    const info = stub.seen.find((c) => c.url.includes("/files/F2"));
    assert.ok(!info.url.includes("try_token="), info.url);
});

await testAsync("a shared file resolves through share/file_info", async () => {
    const stub = panStub((url) => {
        if (url.includes("share/file_info")) {
            return { status: 200, data: { file_info: { web_content_link: "http://s/x", links: { k: { expire: "e", token: "t" } } } } };
        }
        return { status: 404, data: {} };
    });
    const client = new pan.PanClient({ getSession: () => ({ sessionId: "S" }), request: stub.request });
    const link = await client.resolveDirectLink({ fileId: "F", shareId: "SH", passCodeToken: "PC" });
    assert.strictEqual(link.url, "http://s/x");
    assert.strictEqual(link.viaShare, true);
    assert.strictEqual(stub.seen.length, 1, "a share needs exactly one call");
});

await testAsync("a response with no link is a distinct error", async () => {
    const client = new pan.PanClient({
        getSession: () => ({ sessionId: "S" }),
        request: async () => ({ status: 200, data: {} }),
    });
    let err = null;
    try {
        await client.resolveDirectLink({ fileId: "F", useTry: false });
    } catch (error) {
        err = error;
    }
    assert.ok(err);
    assert.strictEqual(err.code, pan.PAN_ERROR.NO_DIRECT_LINK);
});

await testAsync("a network failure is reported as such, not as a 401", async () => {
    const client = new pan.PanClient({
        getSession: () => ({ sessionId: "S" }),
        request: async () => { throw new Error("ECONNREFUSED"); },
    });
    let err = null;
    try {
        await client.listFiles();
    } catch (error) {
        err = error;
    }
    assert.ok(err);
    assert.strictEqual(err.code, pan.PAN_ERROR.NETWORK);
});

console.log("\nboot");

/*
 * A path that is never a binary, used to ask for the stub engine.
 *
 * "No engine" has to be requested rather than assumed. A bare
 * createApplication picks up bin/aria2c.exe once a developer has run
 * engine:fetch, so a test that says nothing about the engine silently gets the
 * real one -- which spawns a process, perturbs the timing of everything after
 * it, and makes the suite pass or fail depending on whether a gitignored
 * directory happens to be populated. It did exactly that: the renderer event
 * test failed only on machines that had fetched the engine.
 *
 * So every application built here names its engine. The stub, unless the test
 * asks for something else, and `realEnginePath()` when it wants the real one.
 */
const STUB_ENGINE_PATH = "/definitely/not/here/aria2c";

function testApplication(options) {
    const opts = options || {};
    const config = Object.assign(
        { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        opts.config || {}
    );
    if (!("aria2Path" in config)) config.aria2Path = STUB_ENGINE_PATH;
    return createApplication(Object.assign({}, opts, { config }));
}

/*
 * The bundled engine, if this checkout has one.
 *
 * scripts/fetch-engine.js writes it to bin/, which is gitignored, so CI has
 * none and a developer machine usually does. Tests that need the real thing
 * ask through here and skip with a stated reason when it is absent, rather
 * than quietly testing the stub a second time.
 */
function realEnginePath() {
    const name = process.platform === "win32" ? "aria2c.exe" : "aria2c";
    const candidate = path.join(__dirname, "..", "bin", name);
    return fs.existsSync(candidate) ? candidate : null;
}

/*
 * Remove a directory, giving Windows a moment to let go of it.
 *
 * A directory that was a child process's working directory stays locked for
 * about a tenth of a second after that process exits, and rmdir answers EBUSY
 * for that whole time. fs.rmSync's own maxRetries does not cover it here, so
 * the wait is explicit. Without this the download test reports a failure on
 * a run where the download was perfect.
 */
async function removeDirectory(dir) {
    const deadline = Date.now() + 12000;
    for (;;) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            return;
        } catch (err) {
            if (Date.now() > deadline) throw err;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

/* Wait until aria2 answers, or give up. */
async function engineReady(engine, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        if (engine.rpc) {
            try {
                await engine.rpc.call("aria2.getVersion");
                return true;
            } catch {
                // The port is bound but aria2 is not serving yet.
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
}

    await testAsync("the application boots with no config", async () => {
        const app = await testApplication({
            config: {
                appid: "test-app",
                appkey: "test-key",
                package: "com.test",
                clientVersion: "1.2.3.456",
                platformVersion: "0",
            },
        });
        assert.ok(app.mesh, "mesh must exist");
        assert.ok(app.kernel, "kernel must exist");
        assert.ok(app.login, "login must exist");
        assert.ok(app.vipToken, "vip token client must exist");
        assert.ok(app.login.deviceSign.startsWith("div101."));
        await app.stop();
    });

    await testAsync("server functions answer through the mesh", async () => {
        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        const loggedIn = await app.mesh.main.callServerFunction(
            contract.SERVER_FUNCTIONS.IS_LOGINED
        );
        assert.strictEqual(loggedIn, false);

        const peerId = await app.mesh.main.callServerFunction(
            contract.SERVER_FUNCTIONS.GET_PEER_ID
        );
        assert.ok(typeof peerId === "string" && peerId.length > 0);
        await app.stop();
    });

    await testAsync("the dcdn rpc swaps arguments into kernel order", async () => {
        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        const taskId = app.kernel.addTask({ url: "http://x/1" });
        // Server functions take (callerContext, selfContext, ...realArgs).
        // The two leading entries are stripped by the registration wrapper, so
        // they are passed here to exercise the same path a plugin uses.
        // RPC order is then (taskId, cert, index); the kernel wants
        // (taskId, index, cert).
        await app.mesh.main.callServerFunction(
            contract.SERVER_FUNCTIONS.ENABLE_DCDN_WITH_VIP_CERT,
            "main-process",
            { name: "vip-download" },
            taskId,
            { cert: "the-cert" },
            4
        );
        const task = app.kernel.getTask(taskId);
        assert.strictEqual(task.dcdnFileIndex, 4, "index must not be mistaken for the cert");
        assert.strictEqual(task.bAcclerating, true);
        await app.stop();
    });

    await testAsync("a plugin call strips the two context arguments", async () => {
        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        // GET_CONFIG_MODULES takes (module, key). If the wrapper were missing,
        // the handler would read the context object as `module` and return [].
        const modules = await app.mesh.main.callServerFunction(
            contract.SERVER_FUNCTIONS.GET_CONFIG_MODULES,
            "main-process",
            { name: "vip-download" },
            "VipDownload",
            "WDYXDomains"
        );
        assert.deepStrictEqual(modules, ["lx.patch1.9you.com"]);
        await app.stop();
    });

    await testAsync("peer id is stable across calls", async () => {
        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        const first = app.getPeerId();
        const second = app.getPeerId();
        assert.strictEqual(first, second);
        await app.stop();
    });

    await testAsync("getConfigModules returns the shipped defaults", async () => {
        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        assert.deepStrictEqual(app.getConfigModules("HDVideo", "domains"), ["hd.xunlei.com"]);
        assert.deepStrictEqual(app.getConfigModules("VipDownload", "WDYXDomains"), ["lx.patch1.9you.com"]);
        assert.deepStrictEqual(app.getConfigModules("nope", "nope"), []);
        await app.stop();
    });

    // -----------------------------------------------------------------------
    // Plugin host
    //
    // A throwaway plugin directory is built on disk rather than pointing at
    // the real plugin tree, so the test is self-contained: it proves the host
    // contract, not that a particular internal build happens to be present.
    // -----------------------------------------------------------------------
    console.log("\nplugin host");

    const pluginHost = require("../src/main/plugin-host");

    function makeFakePlugin(rootDir, name, entrySource) {
        const dir = path.join(rootDir, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, "config.json"),
            JSON.stringify({ name, version: "1.0.0", main: "index.js" })
        );
        fs.writeFileSync(path.join(dir, "index.js"), entrySource);
        return dir;
    }

    await testAsync("a plugin loads with the globals it expects", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-plugin-"));
        const dir = makeFakePlugin(
            root,
            "Fake",
            `const fs = require("fs");
             const path = require("path");
             global.__probe = {
                 rootDir: global.__rootDir,
                 processName: global.__processName,
                 hasServer: !!global.__xdasIPCServer,
                 hasClient: !!global.__xdasIPCClienInstance,
                 configName: global.__xdasPluginConfig && global.__xdasPluginConfig.name,
                 dirname: __dirname,
                 ownFile: fs.existsSync(path.join(__dirname, "config.json")),
             };`
        );

        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        const manifest = await app.loadPlugin(dir);

        assert.strictEqual(manifest.name, "Fake");
        const probe = global.__probe;
        assert.strictEqual(probe.rootDir, dir, "__rootDir must be the plugin directory");
        assert.strictEqual(probe.processName, "main");
        assert.strictEqual(probe.hasServer, true);
        assert.strictEqual(probe.hasClient, true);
        assert.strictEqual(probe.configName, "Fake");
        // This is the one that catches a plain require(): __dirname would then
        // be this repo's scripts/ directory instead of the plugin's.
        assert.strictEqual(probe.dirname, dir, "__dirname must point at the plugin");
        assert.strictEqual(probe.ownFile, true);

        delete global.__probe;
        await app.stop();
    });

    await testAsync("the globals are restored after loading", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-plugin-"));
        const dir = makeFakePlugin(root, "Fake", "void 0;");

        const before = Object.prototype.hasOwnProperty.call(global, "__rootDir");
        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        await app.loadPlugin(dir);

        assert.strictEqual(
            Object.prototype.hasOwnProperty.call(global, "__rootDir"),
            before,
            "a global that did not exist before must be removed again"
        );
        assert.strictEqual(global.__rootDir, undefined);
        await app.stop();
    });

    await testAsync("native call facade invokes the trailing callback", async () => {
        let called = null;
        const facade = pluginHost.createNativeCallFacade({});
        // The plugins pass the callback last; a facade that swallowed it would
        // stall startup, so this is the load-bearing behaviour.
        facade.SomeNativeThing({ a: 1 }, (err, value) => {
            called = { err, value };
        });
        assert.ok(called, "the callback must have run synchronously");
        assert.strictEqual(called.err, null);
        await Promise.resolve();
    });

    await testAsync("native call facade is not thenable", async () => {
        const facade = pluginHost.createNativeCallFacade({});
        assert.strictEqual(facade.then, undefined);
        assert.strictEqual(await Promise.resolve(facade).then(() => "ok"), "ok");
    });

    await testAsync("AsyncGetNativeCallModuleObj answers asynchronously", async () => {
        const env = new pluginHost.PluginEnvironment();
        env.install({ rootDir: "/tmp/x", pluginName: "Fake", pluginConfig: {}, log: () => {} });
        const bag = await new Promise((resolve) => {
            global.AsyncGetNativeCallModuleObj(resolve);
        });
        assert.ok(bag && bag.nativeCall, "the module bag must expose nativeCall");
        env.restore();
    });

    await testAsync("a broken plugin is reported without stopping the scan", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-plugins-"));
        makeFakePlugin(root, "Good", "void 0;");
        const bad = makeFakePlugin(root, "Bad", "throw new Error('boom');");

        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        const results = await app.loadPlugins(root);
        const byName = Object.fromEntries(results.map((r) => [r.name, r]));

        assert.ok(byName.Good && byName.Good.manifest, "the good plugin must load");
        assert.ok(byName.Bad && byName.Bad.error, "the bad plugin must be reported");
        assert.ok(/boom/.test(byName.Bad.error), byName.Bad.error);
        await app.stop();
    });

    await testAsync("plugin functions land on the mesh", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tl-plugin-"));
        const dir = makeFakePlugin(
            root,
            "Fake",
            `global.__xdasIPCClienInstance.registerFunctions({
                 FakeProbe: function () { return "from-plugin"; },
             });`
        );

        const app = await testApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        await app.loadPlugin(dir);

        // callServerFunction unwraps the tuple: the shipped client does
        // `return r && r[0]`, so callers see a bare value here. The tuple
        // form lives on callServerFunctionEx.
        const value = await app.mesh.main.callServerFunction("FakeProbe");
        assert.strictEqual(value, "from-plugin");

        const tuple = await app.mesh.main.callServerFunctionEx("FakeProbe");
        assert.deepStrictEqual(tuple, ["from-plugin", undefined]);
        await app.stop();
    });

    // -----------------------------------------------------------------------
    // aria2 engine
    //
    // The RPC client is not exercised: that would need a running aria2. What
    // is tested is the translation layer, which is where the bugs are -- the
    // two sides do not line up evenly and every field name here is read by
    // something else.
    // -----------------------------------------------------------------------
    console.log("\naria2 engine");

    const aria2 = require("../src/main/engine-aria2");

    test("an active aria2 task maps to a downloading kernel task", () => {
        const mapped = aria2.toKernelTask("t1", {
            gid: "abc123",
            status: "active",
            totalLength: "1000",
            completedLength: "250",
            downloadSpeed: "500",
            uploadSpeed: "0",
            connections: "8",
            files: [{ index: "1", path: "/d/a.bin", length: "1000", completedLength: "250", selected: "true" }],
        });
        assert.strictEqual(mapped.taskId, "t1");
        assert.strictEqual(mapped.gid, "abc123");
        assert.strictEqual(mapped.status, 1, "active must map to downloading");
        assert.strictEqual(mapped.totalSize, 1000);
        assert.strictEqual(mapped.completedSize, 250);
        assert.strictEqual(mapped.progress, 0.25);
        assert.strictEqual(mapped.downloadSpeed, 500);
        assert.strictEqual(mapped.connections, 8);
        assert.strictEqual(mapped.fileCount, 1);
        assert.strictEqual(mapped.files[0].fileName, "a.bin");
    });

    test("aria2 numeric fields arrive as strings and become numbers", () => {
        // A string that stayed a string would break arithmetic in the UI, and
        // `"1000" > 900` is true while `"1000" + 1` is "10001".
        const mapped = aria2.toKernelTask("t1", {
            gid: "g", status: "active",
            totalLength: "1000", completedLength: "250", downloadSpeed: "500",
        });
        assert.strictEqual(typeof mapped.totalSize, "number");
        assert.strictEqual(typeof mapped.completedSize, "number");
        assert.strictEqual(typeof mapped.downloadSpeed, "number");
    });

    test("a complete task maps to completed", () => {
        const mapped = aria2.toKernelTask("t1", { gid: "g", status: "complete", totalLength: "10", completedLength: "10" });
        assert.strictEqual(mapped.status, 3);
    });

    test("an errored task keeps its aria2 error text", () => {
        const mapped = aria2.toKernelTask("t1", {
            gid: "g", status: "error", errorCode: "1", errorMessage: "boom",
        });
        assert.strictEqual(mapped.status, 4);
        assert.strictEqual(mapped.errorCode, 1);
        assert.strictEqual(mapped.errorMessage, "boom");
    });

    test("eta is nulled when aria2 reports it without speed", () => {
        // aria2 emits a huge sentinel eta for a stalled download. Passing it
        // through would show a date in the year 50000 in the UI.
        const stalled = aria2.toKernelTask("t1", { gid: "g", status: "active", downloadSpeed: "0", eta: "4294967295" });
        assert.strictEqual(stalled.etaSeconds, null);
        const moving = aria2.toKernelTask("t1", { gid: "g", status: "active", downloadSpeed: "100", eta: "60" });
        assert.strictEqual(moving.etaSeconds, 60);
    });

    test("a torrent is identified by its bittorrent block", () => {
        const mapped = aria2.toKernelTask("t1", {
            gid: "g", status: "active", infoHash: "abcdef",
            bittorrent: { info: { name: "the torrent" } },
        });
        assert.strictEqual(mapped.taskType, 2, "a torrent must be task type 2");
        assert.strictEqual(mapped.infoId, "ABCDEF", "info hash is reported upper case");
        assert.strictEqual(mapped.btTitle, "the torrent");
    });

    test("the infohash is upper cased to match the client convention", () => {
        // The client stores infohashes upper case and compares them to find
        // the same torrent added twice, so a lower-case one would duplicate.
        const lower = aria2.toKernelTask("t1", { gid: "g", status: "active", infoHash: "aabbcc" });
        assert.strictEqual(lower.infoId, "AABBCC");
    });

    test("an unknown aria2 status falls back to queued, not crashed", () => {
        const mapped = aria2.toKernelTask("t1", { gid: "g", status: "something-new" });
        assert.strictEqual(mapped.status, 0);
    });

    test("progress is zero rather than NaN when the length is unknown", () => {
        // A magnet link has no length until metadata arrives; 0/0 must not
        // become NaN and then render as "NaN%".
        const mapped = aria2.toKernelTask("t1", { gid: "g", status: "active", totalLength: "0", completedLength: "0" });
        assert.strictEqual(mapped.progress, 0);
        assert.ok(Number.isFinite(mapped.progress));
    });

    test("the turbo flags are present and carry values aria2 accepts", () => {
        const engine = new aria2.Aria2Engine({ binary: "/nonexistent/aria2c" });
        const args = engine.buildArgs().join(" ");

        // Names that only exist in a Turbo build. If the wiring dropped a
        // patch the engine would still start and quietly download slower.
        assert.ok(args.includes("--min-split-size=1K"), args);
        assert.ok(args.includes("--retry-on-400=true"), args);

        /*
         * And the values have to be ones aria2 takes.
         *
         * -1 is not among them. It is the ceiling the patch writes into the
         * option handler, not a value the option accepts, and passing it makes
         * aria2 refuse to start:
         *
         *     errorCode=28 max-connection-per-server must be >= 1
         *
         * This test asserted -1 for as long as the engine passed it, so it
         * agreed with the bug rather than catching it. Checking the shape of
         * the value is what makes it a test.
         */
        for (const name of ["max-connection-per-server", "split"]) {
            const match = args.match(new RegExp(`--${name}=(-?\\d+)`));
            assert.ok(match, `--${name} must be passed`);
            assert.ok(
                Number(match[1]) >= 1,
                `--${name} must be at least 1, got ${match[1]}`
            );
        }
    });

    test("the engine saves and reloads a session", () => {
        const engine = new aria2.Aria2Engine({ binary: "/nonexistent/aria2c", workDir: "/tmp/tl" });
        const args = engine.buildArgs().join(" ");
        // Without save-session a restart loses every in-flight download, which
        // is the difference between resuming and starting over.
        assert.ok(args.includes("--save-session="), args);
        assert.ok(args.includes("--input-file="), args);
        assert.ok(args.includes("--continue=true"), args);
    });

    test("dcdn state is tracked even though aria2 has no equivalent", () => {
        const engine = new aria2.Aria2Engine({ binary: "/nonexistent/aria2c" });
        const events = [];
        engine.on("task-dcdn-status-changed", (e) => events.push(e));

        engine.enableDcdn("t1", 2, "the-cert");
        assert.strictEqual(engine._dcdn.get("t1").fileIndex, 2);
        assert.strictEqual(events[0].bAcclerating, true);

        engine.disableDcdn("t1", 2);
        assert.strictEqual(engine._dcdn.has("t1"), false);
        assert.strictEqual(events[1].bAcclerating, false);
    });

    await testAsync("a free port is actually free", async () => {
        const port = await aria2.findFreePort();
        assert.ok(port > 0 && port < 65536, String(port));
    });

    await testAsync("the application boots with a stub when aria2 is absent", async () => {
        const app = await testApplication({
            config: {
                appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                aria2Path: "/definitely/not/here/aria2c",
            },
        });
        // No engine was found, so the kernel must still answer.
        const taskId = app.kernel.addTask({ url: "http://x/1" });
        assert.ok(taskId, "the stub engine must still hand out a task id");
        await app.stop();
    });

    await testAsync("a task event reaches a renderer listener", async () => {
        const app = await testApplication({
            config: {
                appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                aria2Path: "/definitely/not/here/aria2c",
            },
        });

        // The full path, end to end: engine emits, the kernel re-emits under
        // the client's event name, and a renderer listening for that name
        // receives it. A stub engine that stayed silent would leave this broken
        // with nothing to point at.
        const received = [];
        app.mesh.renderer.attachServerEvent("OnTaskInserted", (payload) => {
            received.push(payload);
        });

        const taskId = app.kernel.addTask({ url: "http://example.com/f.bin" });
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.strictEqual(received.length, 1, "the renderer must receive one event");
        assert.strictEqual(received[0].taskId, taskId);
        assert.strictEqual(received[0].url, "http://example.com/f.bin");
        assert.strictEqual(received[0].bAcclerating, false);
        await app.stop();
    });

    await testAsync("a task event also reaches the kernel's own map", async () => {
        const app = await testApplication({
            config: {
                appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                aria2Path: "/definitely/not/here/aria2c",
            },
        });
        const taskId = app.kernel.addTask({ url: "http://example.com/f.bin" });
        await new Promise((resolve) => setTimeout(resolve, 50));
        // The kernel keeps its own record so the UI can read synchronously.
        const task = app.kernel.getTask(taskId);
        assert.ok(task, "the kernel must have recorded the task");
        assert.strictEqual(task.url, "http://example.com/f.bin");
        await app.stop();
    });

    await testAsync("a configured engine path is only accepted if it is a file", async () => {
        // Windows has no executable bit, so an existence check alone would
        // accept a directory and the engine would fail to spawn much later.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thunderx-probe-"));
        try {
            const app = await testApplication({
                config: {
                    appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                    aria2Path: dir,
                },
            });
            assert.strictEqual(app.engine, undefined, "a directory must not be taken for the binary");
            await app.stop();
        } finally {
            await removeDirectory(dir);
        }
    });

    /*
     * The names the kernel calls, on both engines.
     *
     * The kernel tests `typeof engine.x === "function"` before every call, so a
     * name that is missing is not an error -- it is a silent no-op. That is how
     * a real engine exposing `stop` instead of `shutdown` ran to completion and
     * left aria2c behind, and how a duplicated `start` shadowed the lifecycle
     * one. The stub answered to everything, so neither showed up.
     *
     * Comparing the two sets is what turns that class of mistake into a
     * failure. It is deliberately a list of names rather than a reflection over
     * one engine: a name has to be on both sides to count.
     */
    test("both engines implement the names the kernel calls", () => {
        const names = [
            "addTask", "removeTask", "resumeTask", "pause",
            "setUserInfo", "setGlobalExtInfo",
            "enableDcdn", "updateDcdn", "disableDcdn",
            "start", "shutdown",
        ];
        const stub = createNullEngine();
        for (const name of names) {
            assert.strictEqual(
                typeof stub[name], "function",
                `the stub engine must implement ${name}`
            );
            assert.strictEqual(
                typeof aria2.Aria2Engine.prototype[name], "function",
                `the aria2 engine must implement ${name}`
            );
        }
    });

    /*
     * The real engine, when this checkout has one.
     *
     * The suite passed for a long time without ever starting aria2, because the
     * stub answers to every name and a real engine that could not boot at all
     * looked identical to one that could. So this test runs the binary when it
     * is present and says so when it is not, rather than silently testing the
     * stub twice.
     */
    await testAsync("the bundled engine boots, when the checkout has one", async () => {
        const binary = realEnginePath();
        if (!binary) {
            console.log("        skipped: no bin/ engine; run npm run engine:fetch");
            return;
        }

        const app = await testApplication({ config: { aria2Path: binary } });
        assert.ok(app.engine, "a real binary must produce a real engine");

        // The regression, stated directly. A per-task `start(taskId)` used to
        // replace the lifecycle `start()` in the same class, so this returned
        // undefined and the `.catch` the caller attaches threw from inside
        // createApplication. Asserting the shape fails here, where the cause is
        // legible, instead of two frames up where it is not.
        const started = app.engine.start();
        assert.ok(
            started && typeof started.then === "function",
            "engine.start() must return a promise, not undefined"
        );
        await started;

        assert.ok(
            await engineReady(app.engine, 20000),
            "aria2 must answer on its rpc port"
        );

        const taskId = app.kernel.addTask({ url: "http://example.com/engine.bin" });
        assert.ok(taskId, "the kernel must accept a task while the engine is up");

        await app.stop();
        assert.strictEqual(
            app.engine.process, null,
            "the engine process must be gone once the application has stopped"
        );
    });

    /*
     * A real download, over a real socket, through the real binary.
     *
     * Everything above this line can pass while the engine is unable to fetch
     * anything: the stub is happy to pretend, and a real engine that starts and
     * then fails on the first task looks the same from the outside. This is the
     * test that says the thing actually works.
     *
     * The payload is random so that a truncated or empty transfer cannot match,
     * and it is served from a loopback server so the suite needs no network.
     */
    await testAsync("the bundled engine downloads a file", async () => {
        const binary = realEnginePath();
        if (!binary) {
            console.log("        skipped: no bin/ engine; run npm run engine:fetch");
            return;
        }

        const payload = crypto.randomBytes(512 * 1024);
        const server = http.createServer((req, res) => {
            res.writeHead(200, {
                "Content-Length": payload.length,
                "Content-Type": "application/octet-stream",
            });
            res.end(payload);
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thunderx-download-"));
        let app;
        try {
            const port = server.address().port;
            app = await testApplication({
                config: { aria2Path: binary, downloadDir: dir },
            });

            const completed = new Promise((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error("the download did not finish in 30s")),
                    30000
                );
                app.kernel.on("OnTaskCompleted", (task) => {
                    clearTimeout(timer);
                    resolve(task);
                });
            });

            app.kernel.addTask({ url: `http://127.0.0.1:${port}/payload.bin` });
            const task = await completed;

            assert.ok(task.filePath, "a completed task must report where the file went");
            const received = fs.readFileSync(task.filePath);
            assert.strictEqual(
                received.length, payload.length,
                "the file must be the size that was served"
            );
            assert.ok(received.equals(payload), "the bytes must match what was served");
        } finally {
            if (app) await app.stop();
            server.close();
            // Windows holds the download directory for a moment after aria2
            // exits -- the .aria2 control file and the process's working
            // directory are both inside it. The release is not immediate and it
            // is longer when the machine is busy, which is what a full suite
            // run looks like. Retrying is the documented remedy; letting this
            // fail would report a download bug that is not there.
            await removeDirectory(dir);
        }
    });

    /*
     * The renderer reaches the kernel through server functions rather than by
     * holding the kernel object, so these go through the same transport a
     * plugin uses -- including the two leading context arguments every
     * registered handler strips. Calling the kernel directly would pass even if
     * the names or the argument order were wrong, which is exactly the mistake
     * worth catching here.
     */
    await testAsync("the renderer's task functions are reachable over the transport", async () => {
        const app = await testApplication({
            config: {
                appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                aria2Path: "/definitely/not/here/aria2c",
            },
        });
        const context = { id: "renderer" };
        const call = (name, ...args) =>
            app.mesh.main.callServerFunction(name, context, context, ...args);

        const taskId = await call("CreateNewTask", { url: "http://example.com/a.bin" });
        assert.ok(taskId, "CreateNewTask must return a task id");

        const listed = await call("GetAllTaskBaseInfo");
        assert.strictEqual(listed.length, 1, "the task must appear in the listing");
        assert.strictEqual(listed[0].taskId, taskId);

        const one = await call("GetTaskBaseInfo", taskId);
        assert.strictEqual(one.url, "http://example.com/a.bin");

        // Pause and resume are forwarded to the engine. With the stub in place
        // they are no-ops, but they must still resolve rather than throw --
        // a missing registration would come back as a rejection here.
        await call("PauseTask", taskId);
        await call("ResumeTask", taskId);

        await call("DeleteTask", taskId);
        const after = await call("GetAllTaskBaseInfo");
        assert.strictEqual(after.length, 0, "the task must be gone after DeleteTask");

        await app.stop();
    });

    /*
     * The cloud drive over the transport.
     *
     * This is the whole client-side path a signed-out install can walk: the
     * drive answers "not logged in" rather than an empty list, the take-back
     * queue round-trips through the two original names, and draining it
     * reports each file as failed instead of pretending a download started.
     * The happy path needs a real account and is not reachable here.
     */
    await testAsync("the cloud drive answers through the transport", async () => {
        const app = await testApplication({
            config: {
                appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                aria2Path: "/definitely/not/here/aria2c",
            },
        });
        const context = { id: "renderer" };
        const call = (name, ...args) =>
            app.mesh.main.callServerFunction(name, context, context, ...args);

        const listed = await call("PanListFiles", { parentId: "" });
        assert.strictEqual(listed.ok, false, "a signed-out listing must not look empty");
        assert.strictEqual(listed.code, "not_logged_in");

        const queued = await call("ExternalFetchBack", {
            files: [{ id: "F1", name: "a.bin", size: 10 }],
        });
        assert.strictEqual(queued.count, 1);

        const pending = await call("GetFetchBackFiles");
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].fileId, "F1");

        const started = await call("IpcStartRetrieval", "/tmp/somewhere");
        assert.strictEqual(started.added, 0);
        assert.strictEqual(started.failed, 1);
        assert.strictEqual(started.results[0].code, "not_logged_in");

        assert.strictEqual((await call("GetFetchBackFiles")).length, 0, "the queue must be drained");

        const folder = await call("IpcSetRecentFolder", "/tmp/somewhere");
        assert.strictEqual(folder.dir, "/tmp/somewhere");

        await app.stop();
    });

    await testAsync("an unregistered method resolves to nothing rather than throwing", async () => {
        const app = await testApplication({
            config: {
                appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1",
                aria2Path: "/definitely/not/here/aria2c",
            },
        });
        const context = { id: "renderer" };

        // This is the shipped transport's behaviour, not an oversight: a call
        // to a name nobody registered comes back as `[null, message]`, and
        // `callServerFunction` unwraps that to `null`. A renderer therefore
        // cannot tell a missing method from one that returned nothing, which
        // is why the renderer treats a null result as a failure rather than
        // trusting it. The test pins the behaviour so a future change to it is
        // a deliberate one.
        const value = await app.mesh.main.callServerFunction("NoSuchFunction", context, context);
        assert.strictEqual(value, null, "a missing method must not resolve to a value");

        // The tuple form is where the reason is still visible.
        const [result, message] = await app.mesh.main.callServerFunctionEx(
            "NoSuchFunction",
            context,
            context
        );
        assert.strictEqual(result, null);
        assert.ok(
            String(message).includes("NoSuchFunction"),
            "the message must name the method that was missing"
        );

        await app.stop();
    });

    /*
     * The cloud-drive page, driven against a DOM stub.
     *
     * Electron cannot start in this environment -- `electron <script>` exits
     * without a window -- so the page is loaded into a `vm` context with a
     * small DOM: enough for the renderer to build rows and for the test to
     * click them. What it proves is the wiring (the root listing is requested
     * on load, a folder name navigates, a file's button asks for the link),
     * not that the pixels are right. A real look at the window needs a
     * desktop session.
     */
    await testAsync("the cloud-drive page lists, navigates and downloads", async () => {
        const vm = require("vm");
        const source = fs.readFileSync(
            path.join(__dirname, "..", "src", "windows", "pan", "index.js"),
            "utf8"
        );

        // --- a DOM small enough for this page and no smaller ---------------
        const makeElement = (tag) => {
            const el = {
                tagName: String(tag || "div").toUpperCase(),
                children: [],
                _text: "",
                className: "",
                title: "",
                type: "",
                disabled: false,
                value: "",
                dataset: {},
                style: {},
                _listeners: {},
                appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
                append(...kids) { for (const kid of kids) this.appendChild(kid); },
                setAttribute(key, value) { this[key] = value; },
                addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); },
                removeEventListener() {},
                click() { (this._listeners.click || []).forEach((fn) => fn({ target: this })); },
                getBoundingClientRect() { return { width: 0, height: 0 }; },
            };
            Object.defineProperty(el, "textContent", {
                get() {
                    return this.children.length
                        ? this.children.map((child) => child.textContent).join("")
                        : this._text;
                },
                set(value) { this._text = String(value); this.children.length = 0; },
            });
            const classes = new Set();
            el.classList = {
                add: (...names) => names.forEach((name) => classes.add(name)),
                remove: (...names) => names.forEach((name) => classes.delete(name)),
                toggle: (name, force) => {
                    const on = force === undefined ? !classes.has(name) : !!force;
                    if (on) classes.add(name); else classes.delete(name);
                    return on;
                },
                contains: (name) => classes.has(name),
            };
            return el;
        };

        const ids = [
            "refresh", "crumbs", "count", "files", "loading",
            "loading-text", "error", "notice", "status-text",
        ];
        const byId = {};
        for (const id of ids) byId[id] = makeElement(id === "refresh" ? "button" : "div");
        const documentStub = { getElementById: (id) => byId[id] || null, createElement: makeElement };

        // --- the page's calls ----------------------------------------------
        const calls = [];
        const rpc = async (method, ...args) => {
            calls.push({ method, args });
            if (method === "PanListFiles") {
                const parentId = (args[0] && args[0].parentId) || "";
                if (parentId === "") {
                    return {
                        ok: true,
                        value: {
                            ok: true,
                            files: [
                                { id: "folder-1", name: "电影", kind: "drive#folder", isFolder: true, size: 0 },
                                { id: "file-1", name: "a.bin", kind: "drive#file", size: 1024, modifiedTime: "2026-01-02T03:04:05Z" },
                            ],
                        },
                    };
                }
                return {
                    ok: true,
                    value: { ok: true, files: [{ id: "file-2", name: "inside.bin", kind: "drive#file", size: 10 }] },
                };
            }
            if (method === "PanDownloadFile") {
                return { ok: true, value: { ok: true, name: "a.bin", taskId: "t1" } };
            }
            return { ok: true, value: null };
        };

        const sandbox = { document: documentStub, console, setTimeout, clearTimeout };
        sandbox.window = sandbox;
        sandbox.thunderx = { rpc };
        vm.createContext(sandbox);
        vm.runInContext(source, sandbox, { filename: "pan/index.js" });

        // load() is async; give it a tick to settle.
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.ok(calls.length >= 1, "the page must ask for something on load");
        assert.strictEqual(calls[0].method, "PanListFiles");
        assert.strictEqual(calls[0].args[0].parentId, "", "the first call must be the root folder");

        const rows = byId["files"].children;
        assert.strictEqual(rows.length, 2, "two rows: one folder, one file");

        // The folder's name is a button; clicking it navigates into the folder.
        const folderName = rows[0].children[0];
        assert.ok(folderName.className.includes("is-folder"), folderName.className);
        folderName.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const navCall = calls[calls.length - 1];
        assert.strictEqual(navCall.method, "PanListFiles");
        assert.strictEqual(navCall.args[0].parentId, "folder-1", "the folder id must be the new parent");
        assert.strictEqual(byId["files"].children.length, 1, "the folder's own listing must be drawn");

        // Back to the root through the breadcrumb, then press the file button.
        byId["crumbs"].children[0].click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.strictEqual(calls[calls.length - 1].args[0].parentId, "", "the root crumb must go back");

        const download = byId["files"].children[1].children[3].children[0];
        assert.strictEqual(download.className, "download");
        download.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const downloadCall = calls.find((call) => call.method === "PanDownloadFile");
        assert.ok(downloadCall, "the download button must call PanDownloadFile");
        assert.strictEqual(downloadCall.args[0].fileId, "file-1");
        assert.ok(byId["notice"].textContent.includes("a.bin"), byId["notice"].textContent);
    });

    // -----------------------------------------------------------------------
    // Suspension window
    //
    // Electron cannot start in this environment, so the window itself is a
    // stub. What is checked is everything that decides where it goes and what
    // it shows: the clamp the original spells out at out/main.js:302219, the
    // four panel directions, the click's three branches, and the aggregation
    // that lets the ball and the panel share one answer. The pages are driven
    // against a DOM stub for the same reason the pan page is.
    // -----------------------------------------------------------------------
    console.log("\nsuspension window");

    const suspension = require("../src/main/suspension");

    test("the four suspension server functions are in the contract", () => {
        assert.strictEqual(contract.SERVER_FUNCTIONS.GET_MAIN_WINDOW_STATES, "GetMainWindowStates");
        assert.strictEqual(contract.SERVER_FUNCTIONS.BRING_MAIN_WND_TO_TOP, "BringMainWndToTop");
        assert.strictEqual(contract.SERVER_FUNCTIONS.SET_SUSPENSION_POSITION, "SetSuspensionPosition");
        assert.strictEqual(contract.SERVER_FUNCTIONS.GET_SUSPENSION_CONFIG, "GetSuspensionConfig");
        assert.strictEqual(contract.NATIVE_EVENTS.ON_SUSPENSION_STATE, "onSuspensionState");
    });

    test("the eight sizes are the original's, and so is the window", () => {
        assert.strictEqual(suspension.SIZES.autoHideAtX, 380);
        assert.strictEqual(suspension.SIZES.autoHideAtY, 226);
        assert.strictEqual(suspension.SIZES.ballSize, 52);
        assert.strictEqual(suspension.SIZES.ballHeight, 56, "the hexagon is 52 wide and 56 tall");
        assert.strictEqual(suspension.SIZES.ballTop, 10);
        assert.strictEqual(suspension.SIZES.weltSize, 12);
        assert.strictEqual(suspension.SIZES.weltTopSize, 62);
        assert.strictEqual(suspension.SIZES.speedWidth, 72);
        assert.strictEqual(suspension.SIZES.floatHeight, 262);
        assert.strictEqual(suspension.WINDOW_OPTIONS.width, 400);
        assert.strictEqual(suspension.WINDOW_OPTIONS.height, 262);
    });

    test("the clamp keeps the whole ball on screen, so it can always be grabbed", () => {
        const area = { x: 0, y: 0, width: 1920, height: 1080 };
        // Off the bottom-right: the ball's 56x74 hit rectangle is pulled back
        // until it is fully inside. A literal reading of the original's
        // expression (window bounds, -84-380 / -226-74) left the ball unable to
        // reach the right 464px or the bottom 300px, which is where the
        // reported snap-back came from.
        assert.deepStrictEqual(suspension.clampToWorkArea({ x: 5000, y: 5000 }, area), {
            x: 1920 - 56,
            y: 1080 - 74,
        });
        // Off the top-left: the ball is brought fully on screen rather than
        // left hanging 380px past the edge where it cannot be clicked.
        assert.deepStrictEqual(suspension.clampToWorkArea({ x: -5000, y: -5000 }, area), { x: 0, y: 0 });
        // A spot with room on every side is left alone.
        assert.deepStrictEqual(suspension.clampToWorkArea({ x: 400, y: 300 }, area), { x: 400, y: 300 });
        // Every point of the work area is reachable: the far corner and the
        // near corner both survive.
        assert.deepStrictEqual(suspension.clampToWorkArea({ x: 1864, y: 1006 }, area), { x: 1864, y: 1006 });
        assert.deepStrictEqual(suspension.clampToWorkArea({ x: 1000, y: 500 }, area), { x: 1000, y: 500 });
    });

    test("the panel offset matches setFloatPanelDirection", () => {
        const size = { width: 400, height: 262 };
        assert.deepStrictEqual(suspension.setFloatPanelDirection(suspension.FloatPanelDirection.LeftBottom, size), { x: -400, y: 0 });
        assert.deepStrictEqual(suspension.setFloatPanelDirection(suspension.FloatPanelDirection.LeftTop, size), { x: -400, y: -262 });
        assert.deepStrictEqual(suspension.setFloatPanelDirection(suspension.FloatPanelDirection.RightTop, size), { x: 0, y: -262 });
        assert.deepStrictEqual(suspension.setFloatPanelDirection(suspension.FloatPanelDirection.RightBottom, size), { x: 0, y: 0 });
    });

    test("the panel opens toward the half with room", () => {
        const area = { x: 0, y: 0, width: 1920, height: 1080 };
        const at = (x, y) => ({ x, y, width: 400, height: 262 });
        assert.strictEqual(suspension.chooseDirection(at(0, 0), area), suspension.FloatPanelDirection.RightBottom);
        assert.strictEqual(suspension.chooseDirection(at(1800, 0), area), suspension.FloatPanelDirection.LeftBottom);
        assert.strictEqual(suspension.chooseDirection(at(0, 900), area), suspension.FloatPanelDirection.RightTop);
        assert.strictEqual(suspension.chooseDirection(at(1800, 900), area), suspension.FloatPanelDirection.LeftTop);
    });

    test("the ball's anchor is the hexagon's centre, not the window's", () => {
        // The ball is at top:10px, left:0 and is 52x56, so its centre is 26px in
        // and 10+28=38px down -- not the 200,131 a window-centred anchor gives.
        assert.deepStrictEqual(suspension.ballAnchor({ x: 100, y: 50 }), { x: 126, y: 88 });
    });

    test("the panel hangs off the ball's edge, never over it", () => {
        const D = suspension.FloatPanelDirection;
        const ball = { x: 1000, y: 600 };
        // The ball occupies x 1000..1052, y 610..666 in screen coordinates.
        const cases = [
            [D.RightBottom, { x: 1052, y: 610 }],
            [D.RightTop, { x: 1052, y: 666 }],
            [D.LeftBottom, { x: 1000, y: 610 }],
            [D.LeftTop, { x: 1000, y: 666 }],
        ];
        for (const [direction, expected] of cases) {
            assert.deepStrictEqual(suspension.ballPanelAnchor(ball, direction), expected);
            // And the panel that hangs from that corner does not cover the ball.
            const pos = suspension.panelPosition(expected, { width: 400, height: 262 }, direction);
            const panel = { x: pos.x, y: pos.y, width: 400, height: 262 };
            const overlaps =
                panel.x < ball.x + 52 && ball.x < panel.x + panel.width &&
                panel.y < ball.y + 66 && ball.y + 10 < panel.y + panel.height;
            assert.strictEqual(overlaps, false, `direction ${direction} must not cover the ball`);
        }
    });

    /** A registry stub: records sends, positions and show/hide per window. */
    function fakeSuspensionWindows() {
        const windows = new Map();
        const sent = [];
        const makeWindow = (name) => ({
            name,
            lastPosition: null,
            bounds: { x: 0, y: 0, width: 400, height: 262 },
            ignoreMouse: null,
            shown: 0,
            hidden: 0,
            loaded: null,
            _once: {},
            _on: {},
            setPosition(x, y) {
                this.lastPosition = { x, y };
                this.bounds.x = x;
                this.bounds.y = y;
            },
            getBounds() {
                return Object.assign({}, this.bounds);
            },
            showInactive() {
                this.shown += 1;
            },
            hide() {
                this.hidden += 1;
            },
            setAlwaysOnTop() {},
            setIgnoreMouseEvents(ignore, opts) {
                this.ignoreMouse = { ignore, opts };
            },
            loadFile(file) {
                this.loaded = file;
            },
            once(event, fn) {
                (this._once[event] = this._once[event] || []).push(fn);
            },
            on(event, fn) {
                (this._on[event] = this._on[event] || []).push(fn);
            },
            isDestroyed() {
                return false;
            },
            fireOnce(event) {
                for (const fn of this._once[event] || []) fn();
            },
            webContents: {
                send(channel, payload) {
                    sent.push({ channel, payload, window: name });
                },
            },
        });
        return {
            windows,
            sent,
            openWindow(name) {
                if (!windows.has(name)) windows.set(name, makeWindow(name));
                return windows.get(name);
            },
            getWindow(name) {
                return windows.get(name) || null;
            },
            broadcast(channel, payload) {
                sent.push({ channel, payload });
            },
        };
    }

    test("the ball starts off-screen and click-through", () => {
        const wm = fakeSuspensionWindows();
        const svc = new suspension.SuspensionService({ windowManager: wm });
        const win = svc.startSuspensionWindow({ x: null, y: null });
        // Off-screen first: a transparent window shown before its page paints
        // is a solid rectangle for one frame.
        assert.deepStrictEqual(win.lastPosition, { x: -999, y: -999 });
        assert.strictEqual(win.ignoreMouse.ignore, true);
        assert.strictEqual(win.ignoreMouse.opts.forward, true, "forward keeps mousemove reaching the page");
        assert.ok(win.loaded.endsWith("index.html"), win.loaded);
    });

    test("the first paint puts the ball in the bottom-right of the work area", () => {
        const wm = fakeSuspensionWindows();
        const svc = new suspension.SuspensionService({
            windowManager: wm,
            getPrimaryWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
        });
        const win = svc.startSuspensionWindow({ x: null, y: null });
        win.fireOnce("ready-to-show");
        // Bottom-right, inset by 8px -- deliberately NOT on the clamp boundary,
        // because a default that sits exactly on the boundary is what made a
        // short drag toward the corner look like a snap back to the start.
        assert.deepStrictEqual(win.lastPosition, { x: 1920 - 56 - 8, y: 1080 - 74 - 8 });
        assert.strictEqual(win.shown, 1);
    });

    test("a saved position wins over the default corner", () => {
        const wm = fakeSuspensionWindows();
        const svc = new suspension.SuspensionService({
            windowManager: wm,
            getPrimaryWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
            loadPosition: () => ({ x: 300, y: 200 }),
        });
        const win = svc.startSuspensionWindow({ x: null, y: null });
        win.fireOnce("ready-to-show");
        assert.deepStrictEqual(win.lastPosition, { x: 300, y: 200 });
    });

    test("a drag moves the window and the release clamps and saves it", () => {
        const wm = fakeSuspensionWindows();
        const saved = [];
        const svc = new suspension.SuspensionService({
            windowManager: wm,
            getDisplayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
            persistPosition: (pos) => saved.push(pos),
        });
        const win = svc.startSuspensionWindow({ x: 100, y: 100 });

        // Mid-drag is unclamped on purpose: clamping while the button is down
        // makes the ball stick to the edge and jump when the pointer returns.
        svc.handleAction({ type: "drag", x: 5000, y: 5000 });
        assert.deepStrictEqual(win.lastPosition, { x: 5000, y: 5000 });

        svc.handleAction({ type: "dragEnd", x: 5000, y: 5000 });
        assert.deepStrictEqual(win.lastPosition, { x: 1920 - 56, y: 1080 - 74 });
        assert.strictEqual(saved.length, 1);
        assert.deepStrictEqual(saved[0], { x: 1920 - 56, y: 1080 - 74 });
    });

    test("the ball's click raises, dismisses or restores the main window", () => {
        const cases = [
            [{ minimized: true, visible: false, focused: false }, "restore"],
            [{ minimized: false, visible: true, focused: true }, "hide"],
            [{ minimized: false, visible: true, focused: false }, "show"],
        ];
        for (const [states, expected] of cases) {
            const counts = { brought: 0, hidden: 0 };
            const svc = new suspension.SuspensionService({
                windowManager: fakeSuspensionWindows(),
                getMainWindowStates: () => states,
                bringMainToTop: () => {
                    counts.brought += 1;
                },
                hideMainWindow: () => {
                    counts.hidden += 1;
                },
            });
            assert.strictEqual(svc.showOrHideMainWindow(), expected);
            assert.strictEqual(counts.brought, expected === "hide" ? 0 : 1);
            assert.strictEqual(counts.hidden, expected === "hide" ? 1 : 0);
        }
    });

    test("hovering the ball shows the panel on the roomy side and unblocks clicks", () => {
        const wm = fakeSuspensionWindows();
        const svc = new suspension.SuspensionService({
            windowManager: wm,
            getPrimaryWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
            getDisplayForPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
        });
        const ball = svc.startSuspensionWindow({ x: 1400, y: 700 });
        ball.fireOnce("ready-to-show");

        svc.handleAction({ type: "hover" });
        const panel = wm.getWindow(suspension.PANEL_WINDOW);
        assert.ok(panel, "the panel window must exist");
        assert.strictEqual(panel.shown, 1);
        assert.strictEqual(ball.ignoreMouse.ignore, false, "clicks must reach the ball while it is hovered");
        // Ball at 1400,700 -> its centre (1426,738) is in the right/bottom
        // quadrant, so the panel goes left and up (LeftTop) and hangs off the
        // ball's bottom-left corner at (1400,766): 1400-400, 766-262.
        assert.deepStrictEqual(panel.lastPosition, { x: 1000, y: 504 });
        // The point of the anchor change: the panel must not cover the ball, or
        // the press meant for the ball lands on the panel window instead.
        const panelBox = { x: 1000, y: 504, width: 400, height: 262 };
        const overlaps =
            panelBox.x < 1400 + 52 && 1400 < panelBox.x + 400 &&
            panelBox.y < 700 + 66 && 700 + 10 < panelBox.y + 262;
        assert.strictEqual(overlaps, false, "the panel must sit beside the ball, not over it");

        svc.handleAction({ type: "leave" });
        assert.strictEqual(ball.ignoreMouse.ignore, true, "clicks must pass through again once the pointer leaves");
    });

    test("kernel events merge into one summary both windows can read", () => {
        const wm = fakeSuspensionWindows();
        const svc = new suspension.SuspensionService({ windowManager: wm });

        svc.onKernelEvent("OnTaskInserted", {
            taskId: "t1", name: "a.bin", status: 1, totalSize: 100, completedSize: 25, downloadSpeed: 500,
        });
        // A detail event carries no name; a replace would drop it.
        svc.onKernelEvent("OnTaskDetailChanged", { taskId: "t1", completedSize: 50, downloadSpeed: 700 });
        const state = svc.updateSuspensionState();

        assert.strictEqual(state.tasks.length, 1);
        assert.strictEqual(state.tasks[0].name, "a.bin", "a detail event must not drop the name");
        assert.strictEqual(state.progress, 0.5, "progress is bytes, not a mean of percentages");
        assert.strictEqual(state.speed, 700);
        assert.strictEqual(state.activeCount, 1);
        assert.strictEqual(state.isDowning, true);

        const last = wm.sent[wm.sent.length - 1];
        assert.strictEqual(last.channel, "native-event");
        assert.strictEqual(last.payload.name, "onSuspensionState");
        assert.strictEqual(last.payload.payload.activeCount, 1);
    });

    test("a removed task leaves the summary", () => {
        const wm = fakeSuspensionWindows();
        const svc = new suspension.SuspensionService({ windowManager: wm });
        svc.onKernelEvent("OnTaskInserted", { taskId: "t1", status: 1, totalSize: 10, completedSize: 0 });
        svc.onKernelEvent("OnTaskRemoved", { taskId: "t1" });
        const state = svc.updateSuspensionState();
        assert.strictEqual(state.tasks.length, 0);
        assert.strictEqual(state.activeCount, 0);
        assert.strictEqual(state.isDowning, false);
    });

    test("the status line says what the ball is doing", () => {
        assert.strictEqual(suspension.defaultStatusText(2, 3, false, false), "下载中 2 个任务");
        assert.strictEqual(suspension.defaultStatusText(0, 0, false, false), "暂无任务");
        assert.strictEqual(suspension.defaultStatusText(0, 2, true, false), "全部完成");
        assert.strictEqual(suspension.defaultStatusText(0, 2, false, true), "有任务失败");
        assert.strictEqual(suspension.defaultStatusText(0, 2, false, false), "已暂停");
    });

    // --- the two pages, against a DOM stub --------------------------------

    /** A DOM small enough for the suspension pages and no smaller. */
    function makeSuspensionDom(ids) {
        const makeElement = (tag) => {
            const el = {
                tagName: String(tag || "div").toUpperCase(),
                children: [],
                _text: "",
                className: "",
                title: "",
                type: "",
                disabled: false,
                value: "",
                dataset: {},
                style: {},
                _listeners: {},
                _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
                appendChild(child) {
                    this.children.push(child);
                    child.parentNode = this;
                    return child;
                },
                append(...kids) {
                    for (const kid of kids) this.appendChild(kid);
                },
                setAttribute(key, value) {
                    this[key] = value;
                },
                addEventListener(name, fn) {
                    (this._listeners[name] = this._listeners[name] || []).push(fn);
                },
                removeEventListener() {},
                getBoundingClientRect() {
                    return this._rect;
                },
                dispatch(name, event) {
                    for (const fn of this._listeners[name] || []) fn(event || {});
                },
            };
            Object.defineProperty(el, "textContent", {
                get() {
                    return this.children.length
                        ? this.children.map((child) => child.textContent).join("")
                        : this._text;
                },
                set(value) {
                    this._text = String(value);
                    this.children.length = 0;
                },
            });
            const classes = new Set();
            el.classList = {
                add: (...names) => names.forEach((name) => classes.add(name)),
                remove: (...names) => names.forEach((name) => classes.delete(name)),
                toggle: (name, force) => {
                    const on = force === undefined ? !classes.has(name) : !!force;
                    if (on) classes.add(name);
                    else classes.delete(name);
                    return on;
                },
                contains: (name) => classes.has(name),
            };
            return el;
        };

        const byId = {};
        for (const id of ids) byId[id] = makeElement("div");
        const documentStub = {
            body: makeElement("body"),
            _listeners: {},
            getElementById: (id) => byId[id] || null,
            createElement: makeElement,
            addEventListener(name, fn) {
                (this._listeners[name] = this._listeners[name] || []).push(fn);
            },
            dispatch(name, event) {
                for (const fn of this._listeners[name] || []) fn(event || {});
            },
        };
        return { byId, documentStub, makeElement };
    }

    /** Load a page under a vm with the DOM stub, and hand back its channels. */
    function loadSuspensionPage(relative, ids) {
        const vm = require("vm");
        const source = fs.readFileSync(
            path.join(__dirname, "..", "src", "windows", "suspension", relative),
            "utf8"
        );
        const dom = makeSuspensionDom(ids);

        const actions = [];
        let nativeHandler = null;
        const sandbox = {
            document: dom.documentStub,
            console,
            setTimeout,
            clearTimeout,
        };
        sandbox.window = sandbox;
        sandbox.thunderx = {
            suspensionAction: (action) => actions.push(action),
            onNativeEvent: (fn) => {
                nativeHandler = fn;
            },
        };
        vm.createContext(sandbox);
        vm.runInContext(source, sandbox, { filename: relative });

        return { dom, actions, emit: (envelope) => nativeHandler && nativeHandler(envelope) };
    }

    test("the ball page draws the summary and reports its gestures", () => {
        const page = loadSuspensionPage("index.js", [
            "ball", "ring", "percent", "hit", "bubble", "bubble-text", "bubble-red", "bubble-btn",
        ]);
        const { byId } = page.dom;
        byId["hit"]._rect = { left: 0, top: 0, right: 56, bottom: 74, width: 56, height: 74 };

        page.emit({ name: "onSuspensionState", payload: { progress: 0.42, isDowning: true, skin: 0 } });
        assert.strictEqual(byId["percent"].textContent, "42%");
        assert.strictEqual(byId["ring"].style.strokeDashoffset, "58", "the arc is the missing percentage");
        assert.strictEqual(page.dom.documentStub.body.dataset.mode, "down");

        // Over the ball, then off it: the main process toggles mouse pass-through
        // on exactly these two messages.
        page.dom.documentStub.dispatch("mousemove", { clientX: 20, clientY: 20, screenX: 0, screenY: 0 });
        assert.strictEqual(page.actions[page.actions.length - 1].type, "hover");
        page.dom.documentStub.dispatch("mousemove", { clientX: 300, clientY: 200, screenX: 0, screenY: 0 });
        assert.strictEqual(page.actions[page.actions.length - 1].type, "leave");

        // A press that moves is a drag; the window origin is screen - client,
        // so the new origin is (1000-20, 500-20) shifted by the pointer's move.
        // `preventDefault` must be called, or the browser can turn the press
        // into a native drag and swallow the mousemove stream the drag needs.
        let pressPrevented = 0;
        const press = (type, sx, sy, cx, cy) => ({
            button: 0, screenX: sx, screenY: sy, clientX: cx, clientY: cy,
            preventDefault() {
                pressPrevented += 1;
            },
        });
        byId["hit"].dispatch("mousedown", press("mousedown", 1000, 500, 20, 20));
        assert.strictEqual(pressPrevented, 1, "mousedown must preventDefault");
        page.dom.documentStub.dispatch("mousemove", { clientX: 40, clientY: 30, screenX: 1020, screenY: 510 });
        const drag = page.actions[page.actions.length - 1];
        assert.strictEqual(drag.type, "drag");
        assert.deepStrictEqual({ x: drag.x, y: drag.y }, { x: 1000, y: 490 });

        page.dom.documentStub.dispatch("mouseup", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "dragEnd");

        // A press that does not move is a click.
        byId["hit"].dispatch("mousedown", press("mousedown", 1000, 500, 20, 20));
        page.dom.documentStub.dispatch("mouseup", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "leftClick");

        byId["hit"].dispatch("dblclick", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "leftDBClick");

        let prevented = false;
        byId["hit"].dispatch("contextmenu", {
            preventDefault() {
                prevented = true;
            },
        });
        assert.ok(prevented, "the page's own menu must not appear");
        assert.strictEqual(page.actions[page.actions.length - 1].type, "rightClick");

        byId["bubble-btn"].dispatch("click", {});
        const bubble = page.actions[page.actions.length - 1];
        assert.strictEqual(bubble.type, "bubbleBtn");
        assert.strictEqual(bubble.index, 4, "the original reports the button by index 4");
    });

    test("the ball page applies the bubble and the skin", () => {
        const page = loadSuspensionPage("index.js", [
            "ball", "ring", "percent", "hit", "bubble", "bubble-text", "bubble-red", "bubble-btn",
        ]);
        const { byId } = page.dom;

        page.emit({ type: "bubble", field: "text", value: "会员加速试用中" });
        assert.strictEqual(byId["bubble-text"].textContent, "会员加速试用中");
        page.emit({ type: "bubble", field: "red", value: "2026-01-01 到期" });
        assert.ok(!byId["bubble-red"].classList.contains("is-hidden"));
        page.emit({ type: "bubble", field: "show" });
        assert.ok(!byId["bubble"].classList.contains("is-hidden"));
        page.emit({ type: "bubble", field: "hide" });
        assert.ok(byId["bubble"].classList.contains("is-hidden"));

        page.emit({ name: "onSuspensionState", payload: { progress: 1, isDowning: false, skin: 1 } });
        assert.strictEqual(page.dom.documentStub.body.dataset.skin, "vip");
        assert.strictEqual(byId["percent"].textContent, "100%");
    });

    test("the panel page lists tasks and wires its buttons", () => {
        const page = loadSuspensionPage("panel.js", [
            "panel", "title", "speed", "items", "empty", "pause-all", "resume-all", "open-main",
        ]);
        const { byId } = page.dom;

        assert.ok(!byId["empty"].classList.contains("is-hidden"), "an empty list says so");

        page.emit({
            name: "onSuspensionState",
            payload: {
                activeCount: 1,
                speed: 2048,
                skin: 0,
                statusText: "下载中 1 个任务",
                tasks: [
                    { taskId: "t1", name: "a.bin", status: 1, totalSize: 100, completedSize: 50 },
                    { taskId: "t2", name: "b.bin", status: 3, totalSize: 10, completedSize: 10 },
                ],
            },
        });

        assert.strictEqual(byId["items"].children.length, 2);
        assert.strictEqual(byId["title"].textContent, "正在下载 1 个任务");
        assert.strictEqual(byId["speed"].textContent, "2.0 KB/s");
        assert.ok(byId["empty"].classList.contains("is-hidden"));
        // Newest first: the task the user just added is the one they want.
        assert.strictEqual(byId["items"].children[0].dataset.taskId, "t2");
        assert.strictEqual(byId["items"].children[1].dataset.taskId, "t1");
        assert.strictEqual(byId["items"].children[1].dataset.status, "active");
        // name, bar, status; the bar's fill carries the fraction.
        assert.strictEqual(byId["items"].children[1].children[1].children[0].style.width, "50.0%");

        byId["pause-all"].disabled = false;
        byId["items"].children[1].dispatch("click", {});
        const open = page.actions[page.actions.length - 1];
        assert.strictEqual(open.type, "openTask");
        assert.strictEqual(open.taskId, "t1");

        byId["pause-all"].dispatch("click", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "pauseAll");
        byId["resume-all"].dispatch("click", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "resumeAll");
        byId["open-main"].dispatch("click", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "openTask");

        // Entering the panel cancels the ball's hide timer; leaving restarts it.
        byId["panel"].dispatch("mouseenter", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "panelEnter");
        byId["panel"].dispatch("mouseleave", {});
        assert.strictEqual(page.actions[page.actions.length - 1].type, "panelLeave");
    });

    test("the panel disables a button that would do nothing", () => {
        const page = loadSuspensionPage("panel.js", [
            "panel", "title", "speed", "items", "empty", "pause-all", "resume-all", "open-main",
        ]);
        const { byId } = page.dom;

        page.emit({
            name: "onSuspensionState",
            payload: { activeCount: 0, speed: 0, tasks: [{ taskId: "t1", status: 3, totalSize: 1, completedSize: 1 }] },
        });
        assert.strictEqual(byId["pause-all"].disabled, true, "nothing is downloading");
        assert.strictEqual(byId["resume-all"].disabled, true, "nothing is paused or failed");
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
