/**
 * Renderer.
 *
 * Three jobs, kept separate:
 *
 *   1. gate the window on a session -- the login screen until one exists, the
 *      task list after
 *   2. draw the task list from the events the kernel raises
 *   3. mount the views the plugins asked for as `<webview>` elements
 *
 * Nothing here talks to the engine directly. Every action goes through the
 * same server-function names the plugin contract uses, so the UI exercises the
 * contract instead of a shortcut beside it.
 *
 * State is a map from task id to the last event seen for it. Events are
 * partial -- a progress event carries no name, a status event carries no size
 * -- so the map is merged into rather than replaced, and a row is redrawn from
 * the merged result.
 */

"use strict";

const bridge = window.thunderx;

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------

/*
 * Which screen is up is the server's answer, not a local flag.
 *
 * `IsLogined` is the same call the plugins make, so the window cannot disagree
 * with the rest of the client about whether a session exists. Everything below
 * only translates that answer into DOM.
 */

const $ = (id) => document.getElementById(id);

/*
 * Call a server function and keep the failure instead of routing it to the
 * main window's banner. The login screen has its own error line, and the
 * banner sits behind the login screen -- a failure reported there would never
 * be seen.
 */
async function callRaw(method, ...args) {
    try {
        const result = await bridge.rpc(method, ...args);
        if (!result || !result.ok) {
            return { ok: false, error: String((result && result.error) || "调用失败") };
        }
        return { ok: true, value: result.value };
    } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
    }
}

/*
 * Account-system error codes worth their own wording.
 *
 * The codes come from the recovered error table. The ones a user can act on
 * are translated, and anything unrecognised falls through to the raw message,
 * which names the cause better than a generic failure would.
 */
const LOGIN_ERROR_TEXT = {
    invalid_account_or_password: "账号或密码错误",
    invalid_password: "密码错误",
    user_blocked: "账号已被封禁",
    user_pending: "账号尚未激活",
    captcha_required: "需要输入图形验证码（该接口未复刻）",
    captcha_invalid: "图形验证码错误",
    invalid_verification_code: "验证码错误",
    two_factor_required: "需要二次验证",
    unreachable: "无法连接服务器，请检查网络",
    deadline_exceeded: "请求超时，请重试",
};

function describeLoginError(message) {
    const text = String(message || "登录失败");
    for (const code of Object.keys(LOGIN_ERROR_TEXT)) {
        if (text.includes(code)) return LOGIN_ERROR_TEXT[code];
    }
    return text;
}

const VIP_LABEL = { normal: "普通会员", platinum: "白金会员", super: "超级会员" };

function showLogin() {
    $("login").classList.remove("is-hidden");
    $("app").classList.add("is-hidden");
    $("account-name").textContent = "未登录";
    $("account-name").title = "";
    $("account-vip").classList.add("is-hidden");
    $("logout").classList.add("is-hidden");
}

function showApp(summary) {
    $("login").classList.add("is-hidden");
    $("app").classList.remove("is-hidden");
    renderAccount(summary || {});
}

function renderAccount(summary) {
    $("account-name").textContent = summary.nickname || summary.userId || "已登录";
    $("account-name").title = summary.userId || "";
    const label = VIP_LABEL[summary.vipType] || "";
    $("account-vip").textContent = label;
    $("account-vip").classList.toggle("is-hidden", !(summary.isVip && label));
    $("logout").classList.remove("is-hidden");
}

/*
 * Decide the initial screen.
 *
 * A session restored from disk shows the task list without a login round trip;
 * a fresh install shows the login screen. The profile fetch is allowed to fail
 * -- an unreachable account server should still let a signed-in user reach
 * their downloads -- so a failure falls back to the bare identity.
 */
async function loadSession() {
    const loggedIn = await callRaw("IsLogined");
    if (!loggedIn.ok || !loggedIn.value) {
        showLogin();
        return;
    }
    const summary = await callRaw("RefreshUserInfo");
    showApp(summary.ok ? summary.value : {});
}

async function loadVersion() {
    const result = await callRaw("GetThunderVersion");
    if (result.ok && result.value) $("login-version").textContent = result.value;
}

// --- tabs ------------------------------------------------------------------

function selectTab(name) {
    document.querySelectorAll(".login-tab").forEach((tab) => {
        tab.classList.toggle("is-active", tab.dataset.tab === name);
    });
    document.querySelectorAll(".login-pane").forEach((pane) => {
        pane.classList.toggle("is-hidden", pane.dataset.pane !== name);
    });
}

// --- account + password ----------------------------------------------------

function toggleReveal() {
    const input = $("login-password");
    const shown = input.type === "text";
    input.type = shown ? "password" : "text";
    $("login-reveal").textContent = shown ? "显示" : "隐藏";
}

/*
 * The account/password tab cannot finish a login yet, and it says so through
 * the server rather than in the page.
 *
 * The server wants a loginkey, and the step that turns a password into one
 * lives in the original's qLogin bundle -- not in this repository. The call is
 * still made, with the credential as far as it can be assembled, so the gap is
 * reported by the same path that will report a real failure once the
 * derivation exists. Hardcoding the message here would leave a second place to
 * change and would take the transport out of the flow.
 */
async function submitPassword() {
    const error = $("login-error");
    error.textContent = "";
    const userid = $("login-account").value.trim();
    const password = $("login-password").value;
    if (!userid || !password) {
        error.textContent = "请输入账号和密码";
        return;
    }

    const outcome = await callRaw("LoginWithKey", { userid, loginkey: "" });
    if (!outcome.ok) {
        error.textContent = describeLoginError(outcome.error);
        return;
    }
    await loadSession();
}

// --- QR --------------------------------------------------------------------

let qrTimer = null;

function stopQRPolling() {
    if (qrTimer) {
        clearInterval(qrTimer);
        qrTimer = null;
    }
}

/*
 * Ask for a QR payload and start polling for the scan.
 *
 * Both calls are registered but unimplemented: the device-code sequence was
 * not recovered, so the request fails and its reason is shown in the status
 * line. The loop below is what runs once a payload exists. The interval is the
 * one part of this path that is a guess, so it is kept responsive and is
 * cancelled on the first conclusive answer.
 */
async function refreshQRCode() {
    stopQRPolling();
    const status = $("qr-status");
    const placeholder = $("qr-placeholder");
    status.textContent = "正在获取二维码…";
    placeholder.textContent = "二维码加载中…";

    const outcome = await callRaw("GetLoginQRCode");
    if (!outcome.ok) {
        placeholder.textContent = "二维码不可用";
        status.textContent = describeLoginError(outcome.error);
        return;
    }

    const payload = outcome.value || {};
    if (payload.image) {
        $("qr-image").src = payload.image;
        $("qr-image").classList.remove("is-hidden");
        placeholder.classList.add("is-hidden");
    }
    status.textContent = "请使用迅雷 App 扫码";
    pollQRCode(payload.id);
}

function pollQRCode(id) {
    qrTimer = setInterval(async () => {
        const outcome = await callRaw("CheckLoginQRCode", id);
        if (!outcome.ok) {
            stopQRPolling();
            $("qr-status").textContent = describeLoginError(outcome.error);
            return;
        }
        const state = (outcome.value && outcome.value.state) || "";
        if (state === "scanned") {
            $("qr-status").textContent = "已扫码，请在手机上确认";
        } else if (state === "confirmed") {
            stopQRPolling();
            await loadSession();
        } else if (state === "expired") {
            stopQRPolling();
            $("qr-status").textContent = "二维码已失效，请刷新";
        }
    }, 2000);
}

// --- phone -----------------------------------------------------------------

let countdownTimer = null;

function startCountdown() {
    const button = $("phone-send");
    let left = 60;
    button.disabled = true;
    button.textContent = `${left}s 后重发`;
    countdownTimer = setInterval(() => {
        left -= 1;
        if (left <= 0) {
            clearInterval(countdownTimer);
            countdownTimer = null;
            button.disabled = false;
            button.textContent = "获取验证码";
            return;
        }
        button.textContent = `${left}s 后重发`;
    }, 1000);
}

async function sendPhoneCode() {
    const error = $("phone-error");
    error.textContent = "";
    const phone = $("phone-number").value.trim();
    if (!/^\d{11}$/.test(phone)) {
        error.textContent = "请输入 11 位手机号";
        return;
    }
    const outcome = await callRaw("SendPhoneCode", phone);
    if (!outcome.ok) {
        error.textContent = describeLoginError(outcome.error);
        return;
    }
    startCountdown();
}

/*
 * The agreement checkbox gates the button.
 *
 * This is a compliance habit rather than something the recovered material
 * records -- the original's own step is unknown -- so it is flagged as an
 * addition rather than presented as evidence.
 */
function updatePhoneSubmit() {
    $("phone-submit").disabled = !$("phone-agree").checked;
}

async function submitPhone() {
    const error = $("phone-error");
    error.textContent = "";
    const phone = $("phone-number").value.trim();
    const code = $("phone-code").value.trim();
    if (!/^\d{11}$/.test(phone)) {
        error.textContent = "请输入 11 位手机号";
        return;
    }
    if (!/^\d{4,6}$/.test(code)) {
        error.textContent = "请输入验证码";
        return;
    }
    const outcome = await callRaw("LoginWithPhone", { phone, code });
    if (!outcome.ok) {
        error.textContent = describeLoginError(outcome.error);
        return;
    }
    await loadSession();
}

// --- logout ----------------------------------------------------------------

async function logout() {
    stopQRPolling();
    // Best effort. The server clears local state even when the request fails,
    // so the screen switches either way -- leaving the task list up would show
    // a session that no longer exists.
    await callRaw("Logout");
    showLogin();
}

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

/*
 * Status numbers as the kernel defines them. The names are what the sidebar
 * filters match on, so this is the one place the two are tied together.
 */
const STATUS = {
    0: "waiting",
    1: "active",
    2: "paused",
    3: "done",
    4: "error",
};

const STATUS_LABEL = {
    waiting: "等待中",
    active: "正在下载",
    paused: "已暂停",
    done: "已完成",
    error: "失败",
};

const tasks = new Map();
let filter = "all";
let selected = null;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/*
 * Speed and size are formatted with the unit the value actually calls for
 * rather than a fixed one: a 900 B/s transfer shown as "0.0 MB/s" reads as a
 * stalled download.
 */
function formatBytes(value) {
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let scaled = value;
    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }
    const digits = scaled >= 100 || index === 0 ? 0 : 1;
    return `${scaled.toFixed(digits)} ${units[index]}`;
}

function formatSpeed(value) {
    if (!Number.isFinite(value) || value <= 0) return "";
    return `${formatBytes(value)}/s`;
}

function formatProgress(task) {
    const total = Number(task.totalSize) || 0;
    const done = Number(task.completedSize) || 0;
    if (total <= 0) {
        // A magnet link has no size until metadata arrives, and a percentage of
        // an unknown total is not a number worth printing.
        return done > 0 ? formatBytes(done) : "0%";
    }
    const percent = Math.min(100, Math.max(0, (done / total) * 100));
    return `${percent.toFixed(1)}%`;
}

function progressFraction(task) {
    const total = Number(task.totalSize) || 0;
    const done = Number(task.completedSize) || 0;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, done / total));
}

// ---------------------------------------------------------------------------
// Task table
// ---------------------------------------------------------------------------

/*
 * Rows are keyed by task id and reused. Rebuilding the table on every progress
 * event would discard the selection several times a second, and the selection
 * is what the toolbar buttons act on.
 */
const rows = new Map();

function createRow(taskId) {
    const tr = document.createElement("tr");
    tr.dataset.taskId = taskId;

    const name = document.createElement("td");
    name.className = "cell-name";

    const size = document.createElement("td");
    size.className = "cell-size";

    const progress = document.createElement("td");
    progress.className = "cell-progress";
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("i");
    bar.appendChild(fill);
    const text = document.createElement("span");
    progress.append(bar, text);

    const speed = document.createElement("td");
    speed.className = "cell-speed";

    const status = document.createElement("td");
    status.className = "cell-status";

    tr.append(name, size, progress, speed, status);

    tr.addEventListener("click", () => {
        selected = taskId;
        render();
    });
    tr.addEventListener("dblclick", () => {
        // The name is the only cell a user has a reason to copy, and the body
        // is user-select:none to keep the table from behaving like a document.
        window.getSelection()?.selectAllChildren(name);
    });

    rows.set(taskId, { tr, name, size, progress: text, fill, speed, status });
    return tr;
}

function visible(task) {
    if (filter === "all") return true;
    return STATUS[Number(task.status)] === filter;
}

function render() {
    const body = document.getElementById("tasks-body");
    const empty = document.getElementById("empty");

    let shown = 0;
    for (const [taskId, task] of tasks) {
        const row = rows.get(taskId) || createRow(taskId);
        const cells = rows.get(taskId);

        const statusName = STATUS[Number(task.status)] || "waiting";
        row.dataset.status = statusName;
        row.dataset.accelerated = task.bAcclerating ? "1" : "0";
        row.classList.toggle("is-selected", taskId === selected);

        cells.name.textContent = task.name || task.url || taskId;
        cells.name.title = task.url || "";
        cells.size.textContent = task.totalSize > 0 ? formatBytes(task.totalSize) : "";
        cells.progress.textContent = formatProgress(task);
        cells.fill.style.width = `${(progressFraction(task) * 100).toFixed(1)}%`;
        cells.speed.textContent = formatSpeed(task.downloadSpeed);
        cells.status.textContent = STATUS_LABEL[statusName] || "";

        // The row is only attached once, and only while it is visible. A row
        // that is filtered out is detached rather than hidden, so a large
        // queue does not accumulate offscreen nodes.
        if (visible(task)) {
            shown += 1;
            if (row.parentNode !== body) body.appendChild(row);
        } else if (row.parentNode === body) {
            body.removeChild(row);
        }
    }

    // Tasks removed while filtered out still have rows; drop them.
    for (const [taskId, cells] of rows) {
        if (!tasks.has(taskId)) {
            cells.tr.remove();
            rows.delete(taskId);
        }
    }

    empty.classList.toggle("is-hidden", shown > 0);
    updateToolbar();
}

/*
 * Toolbar enablement follows the selection, which is the only thing that
 * decides whether the buttons would do anything.
 */
function updateToolbar() {
    const task = selected ? tasks.get(selected) : null;
    const statusName = task ? STATUS[Number(task.status)] : null;
    document.getElementById("pause").disabled = !task || statusName !== "active";
    document.getElementById("resume").disabled = !task || !(statusName === "paused" || statusName === "error");
    document.getElementById("remove").disabled = !task;
    document.getElementById("add").disabled = document.getElementById("url").value.trim() === "";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/*
 * Merging, not replacing.
 *
 * The kernel sends a different subset of fields with each event, so a replace
 * would make a row lose its name as soon as a progress event arrived.
 */
function mergeTask(taskId, patch) {
    const current = tasks.get(taskId) || { taskId };
    const next = Object.assign(current, patch || {});
    tasks.set(taskId, next);
    return next;
}

/*
 * Progress arrives as a detail change rather than an event of its own. The
 * kernel has no separate progress event: `OnTaskDetailChanged` carries the
 * fields that move during a transfer, speed and completed size among them.
 */
function handleEvent(name, payload) {
    switch (name) {
        case "OnTaskInserted":
            mergeTask(payload.taskId, payload);
            if (!selected) selected = payload.taskId;
            break;
        case "OnTaskStatusChanged":
            mergeTask(payload.taskId, payload);
            break;
        case "OnTaskDetailChanged":
            mergeTask(payload.taskId, payload);
            break;
        case "OnTaskCompleted":
            mergeTask(payload.taskId, payload);
            break;
        case "OnTaskRemoved":
            tasks.delete(payload.taskId);
            if (selected === payload.taskId) selected = null;
            break;
        case "onLoginSuc":
            // The payload is [userId, sessionId]; the account area wants the
            // profile, so the screen is re-decided rather than read off it.
            loadSession();
            break;
        case "onLogout":
            showLogin();
            break;
        default:
            return;
    }
    render();
}

// ---------------------------------------------------------------------------
// Plugin views
// ---------------------------------------------------------------------------

const mounted = new Set();

/*
 * Mounting is by view id, once.
 *
 * A reload re-creates the page and the queue is drained again, so a mount that
 * did not check would end up with two elements for the same id.
 */
function mountView(descriptor) {
    if (mounted.has(descriptor.id)) return;
    mounted.add(descriptor.id);

    const view = document.createElement("webview");
    view.setAttribute("src", descriptor.src);
    // The plugin decides this, and the original passes it through. A view that
    // needs node gets it; one that does not, does not.
    if (descriptor.nodeintegration) {
        view.setAttribute("nodeintegration", "");
    }
    view.dataset.viewId = descriptor.id;

    /*
     * Height is driven by the view rather than fixed.
     *
     * The plugin pages size themselves to their content, and a fixed height
     * either clips a form or leaves a band of empty page below a banner. The
     * reported height is used only within sane bounds so a page that reports
     * nonsense cannot take the whole window.
     */
    view.addEventListener("dom-ready", () => {
        view.classList.add("is-open");
    });

    document.getElementById("views").appendChild(view);
}

async function mountQueuedViews() {
    try {
        const views = await bridge.listViews();
        for (const descriptor of views) mountView(descriptor);
    } catch (error) {
        // A missing bridge means the page was opened outside Electron, which is
        // a legitimate thing to do while working on the markup.
        console.warn("could not list views:", error);
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/*
 * Methods that are expected to return nothing.
 *
 * The transport answers an unregistered name with `[null, message]`, which
 * unwraps to `null` -- so "no such method" and "the method returned nothing"
 * arrive looking the same. Without this list every void operation would be
 * reported as a missing feature, and with the check removed entirely a button
 * backed by a method that does not exist would silently do nothing.
 */
const VOID_METHODS = new Set(["PauseTask", "ResumeTask", "DeleteTask"]);

async function call(method, ...args) {
    const result = await bridge.rpc(method, ...args);
    if (!result || !result.ok) {
        showBanner(String((result && result.error) || "调用失败"));
        return null;
    }
    if (!VOID_METHODS.has(method) && (result.value === null || result.value === undefined)) {
        showBanner(`没有这个功能: ${method}`);
        return null;
    }
    return result.value;
}

function showBanner(message) {
    const banner = document.getElementById("banner");
    banner.textContent = message;
    banner.classList.remove("is-hidden");
}

function init() {
    document.querySelectorAll(".filter").forEach((button) => {
        button.addEventListener("click", () => {
            filter = button.dataset.status;
            document.querySelectorAll(".filter").forEach((other) => {
                other.classList.toggle("is-active", other === button);
            });
            render();
        });
    });

    const input = document.getElementById("url");
    input.addEventListener("input", updateToolbar);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") document.getElementById("add").click();
    });

    document.getElementById("add").addEventListener("click", async () => {
        const url = input.value.trim();
        if (!url) return;
        /*
         * The dialog is the real path now.
         *
         * It carries what this one-line input cannot: the save directory, a
         * file name, and the torrent file list with per-file selection. The
         * link the user already typed is handed over as a prefill so the paste
         * is not thrown away.
         *
         * The inline create below is kept as the fallback rather than deleted.
         * A build whose window cannot open -- or a call that fails -- still
         * has to be able to start a download, and the one-line path is exactly
         * that: no directory, no selection, but a task that runs.
         */
        const opened = await call("CreatePreNewTaskWindow", { prefill: { url } });
        if (!opened) await call("CreateNewTask", { url });
        input.value = "";
        updateToolbar();
    });

    document.getElementById("pause").addEventListener("click", async () => {
        if (selected) await call("PauseTask", selected);
    });
    document.getElementById("resume").addEventListener("click", async () => {
        if (selected) await call("ResumeTask", selected);
    });
    document.getElementById("remove").addEventListener("click", async () => {
        if (selected) await call("DeleteTask", selected);
    });

    bridge.onNativeEvent(({ name, payload }) => handleEvent(name, payload));
    bridge.onViews((views) => {
        for (const descriptor of views) mountView(descriptor);
    });
    bridge.onBootError((message) => showBanner(`启动失败: ${message}`));

    wireLogin();

    mountQueuedViews();
    render();
}

/*
 * Login screen wiring, kept out of `init` so the two screens do not read as
 * one long list of listeners.
 */
function wireLogin() {
    document.querySelectorAll(".login-tab").forEach((tab) => {
        tab.addEventListener("click", () => selectTab(tab.dataset.tab));
    });

    $("login-reveal").addEventListener("click", toggleReveal);
    $("login-submit").addEventListener("click", submitPassword);
    $("login-password").addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitPassword();
    });
    $("login-account").addEventListener("keydown", (event) => {
        if (event.key === "Enter") submitPassword();
    });

    $("qr-refresh").addEventListener("click", refreshQRCode);

    $("phone-send").addEventListener("click", sendPhoneCode);
    $("phone-submit").addEventListener("click", submitPhone);
    $("phone-agree").addEventListener("change", updatePhoneSubmit);

    $("logout").addEventListener("click", logout);

    // The QR tab is the default, so its payload is requested on load; the
    // version label comes from the same server function the plugins use.
    loadVersion();
    refreshQRCode();
    loadSession();
}

init();
