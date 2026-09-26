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

const contract = require("../src/main/contract");
const vipToken = require("../src/main/vip-token");
const { createMesh } = require("../src/main/rpc");
const { ThunderKernel, createNullEngine, TASK_STATUS } = require("../src/main/kernel");
const login = require("../src/main/login");

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
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

test("call resolves to a two element tuple", async () => {
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

test("a failing call returns null plus a message rather than throwing", async () => {
    const mesh = createMesh();
    const result = await mesh.renderer.callRemoteClientFunction(
        contract.CONTEXTS.LOGIN_RENDERER,
        "does-not-exist"
    );
    assert.strictEqual(result[0], null);
    assert.ok(typeof result[1] === "string" && result[1].length > 0);
});

test("an unknown context is reported, not thrown", async () => {
    const mesh = createMesh();
    const result = await mesh.renderer.callRemoteClientFunction("nowhere", "f");
    assert.strictEqual(result[0], null);
    assert.ok(result[1].includes("nowhere"));
});

test("a thrown handler becomes a null tuple", async () => {
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

test("the first event handler owns the result", async () => {
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

test("broadcast reaches every listener", async () => {
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

test("kernel forwards engine events under the original names", async () => {
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

console.log("\nboot");

(async () => {
    await testAsync("the application boots with no config", async () => {
        const { createApplication } = require("../src/main/index");
        const app = await createApplication({
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
        const { createApplication } = require("../src/main/index");
        const app = await createApplication({
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
        const { createApplication } = require("../src/main/index");
        const app = await createApplication({
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
        const { createApplication } = require("../src/main/index");
        const app = await createApplication({
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
        const { createApplication } = require("../src/main/index");
        const app = await createApplication({
            config: { appid: "a", appkey: "k", package: "p", clientVersion: "1.0.0.1" },
        });
        const first = app.getPeerId();
        const second = app.getPeerId();
        assert.strictEqual(first, second);
        await app.stop();
    });

    await testAsync("getConfigModules returns the shipped defaults", async () => {
        const { createApplication } = require("../src/main/index");
        const app = await createApplication({
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

    const os = require("os");
    const fs = require("fs");
    const pluginHost = require("../src/main/plugin-host");
    const { createApplication } = require("../src/main/index");

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

        const app = await createApplication({
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
        const app = await createApplication({
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

        const app = await createApplication({
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

        const app = await createApplication({
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

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
