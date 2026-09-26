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
    captcha_required: "需要输入图形验证码",
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

/*
 * 迅雷不强制登录.
 *
 * 未登录时照样进主界面, 能下载 HTTP / BT / 磁力链. 只有云盘和转存需要账号,
 * 那两处会自己提示. 之前是未登录直接切到登录页, 结果是没账号就什么都干不了 --
 * 而用户装迅雷本来就是为了下载.
 *
 * 登录页现在是主动进的: 点账号区的「登录」按钮, 或者点了云盘触发.
 */
function showLogin() {
    $("login").classList.remove("is-hidden");
    $("app").classList.add("is-hidden");
    $("account-name").textContent = "未登录";
    $("account-name").title = "";
    $("account-vip").classList.add("is-hidden");
    $("logout").classList.add("is-hidden");
    $("signin").classList.remove("is-hidden");
}

function showApp(summary) {
    $("login").classList.add("is-hidden");
    $("app").classList.remove("is-hidden");
    renderAccount(summary || {});
}

function renderAccount(summary) {
    const signedIn = Boolean(summary.nickname || summary.userId);
    $("account-name").textContent = summary.nickname || summary.userId || "未登录";
    $("account-name").title = summary.userId || "";
    const label = VIP_LABEL[summary.vipType] || "";
    $("account-vip").textContent = label;
    $("account-vip").classList.toggle("is-hidden", !(summary.isVip && label));
    // 未登录显示「登录」, 已登录显示「退出」. 两个按钮互斥, 不然会有两个入口
    // 同时挂在同一个位置.
    $("logout").classList.toggle("is-hidden", !signedIn);
    $("signin").classList.toggle("is-hidden", signedIn);
}

/*
 * Decide the initial screen.
 *
 * 未登录也进主界面. A session restored from disk shows the profile; without
 * one the task list still works and the account area offers a way in. The
 * profile fetch is allowed to fail -- an unreachable account server should
 * still let a signed-in user reach their downloads -- so a failure falls back
 * to the bare identity.
 */
async function loadSession() {
    const loggedIn = await callRaw("IsLogined");
    if (!loggedIn.ok || !loggedIn.value) {
        showApp({});
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
 * The account/password tab.
 *
 * The password goes to the server as-is: the original sends it with
 * `isMd5Pwd: "0"` over HTTPS and hashes nothing client-side
 * (LOGIN_PROTOCOL_SPEC.md section 4), so there is nothing to pre-hash here.
 * The captcha field stays hidden until the server asks for it, which is the
 * only moment a user can supply one.
 */
async function submitPassword() {
    const error = $("login-error");
    error.textContent = "";
    const userName = $("login-account").value.trim();
    const passWord = $("login-password").value;
    const verifyCode = $("login-captcha").value.trim();
    if (!userName || !passWord) {
        error.textContent = "请输入账号和密码";
        return;
    }

    const button = $("login-submit");
    button.disabled = true;
    button.textContent = "登录中…";
    try {
        const outcome = await callRaw("LoginWithKey", { userName, passWord, verifyCode });
        if (!outcome.ok) {
            // A captcha challenge is not a dead end: reveal the field so the
            // next attempt can carry the code.
            if (/图形验证码/.test(outcome.error)) {
                $("login-captcha-field").classList.remove("is-hidden");
            }
            error.textContent = describeLoginError(outcome.error);
            raiseToast("login_failed", NOTIFY_TYPE.RedNotify, describeLoginError(outcome.error), 4000);
            return;
        }
        await loadSession();
    } finally {
        button.disabled = false;
        button.textContent = "登录";
    }
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
 * The payload's `image` is an SVG data URL the main process renders from the
 * device-code URL -- the original draws the same URL locally with qrious
 * (spec section 2A step 2). The poll interval comes from the device-code
 * response rather than being fixed, because the server rate-limits the token
 * endpoint and answers a too-fast poll with an error instead of a status.
 */
async function refreshQRCode() {
    stopQRPolling();
    const status = $("qr-status");
    const placeholder = $("qr-placeholder");
    const image = $("qr-image");
    status.textContent = "正在获取二维码…";
    placeholder.textContent = "二维码加载中…";
    placeholder.classList.remove("is-hidden");
    image.classList.add("is-hidden");

    const outcome = await callRaw("GetLoginQRCode");
    if (!outcome.ok) {
        placeholder.textContent = "二维码不可用";
        status.textContent = describeLoginError(outcome.error);
        return;
    }

    const payload = outcome.value || {};
    if (payload.image) {
        image.src = payload.image;
        image.classList.remove("is-hidden");
        placeholder.classList.add("is-hidden");
    }
    status.textContent = "请使用迅雷 App 扫码";
    const interval = Math.max(1, Number(payload.interval) || 2) * 1000;
    pollQRCode(interval);
}

/*
 * Poll for the scan result.
 *
 * The states are the ones LoginClient.pollScanLogin reports. "pending" and
 * "scanned" keep the loop alive; everything else is conclusive and stops it,
 * because a poll on a dead code can only repeat the same answer.
 */
function pollQRCode(interval) {
    qrTimer = setInterval(async () => {
        const outcome = await callRaw("CheckLoginQRCode", "scan");
        if (!outcome.ok) {
            stopQRPolling();
            $("qr-status").textContent = describeLoginError(outcome.error);
            return;
        }
        const value = outcome.value || {};
        switch (value.state) {
            case "pending":
                $("qr-status").textContent = "请使用迅雷 App 扫码";
                break;
            case "scanned":
                $("qr-status").textContent = "已扫码，请在手机上确认";
                break;
            case "confirmed":
                stopQRPolling();
                $("qr-status").textContent = "登录成功";
                await loadSession();
                break;
            case "expired":
                stopQRPolling();
                $("qr-status").textContent = "二维码已失效，请刷新";
                break;
            case "denied":
                stopQRPolling();
                $("qr-status").textContent = "已在手机上取消登录，请刷新后重试";
                break;
            default:
                stopQRPolling();
                $("qr-status").textContent = value.message || "扫码登录失败";
        }
    }, interval);
}

// --- phone -----------------------------------------------------------------

let countdownTimer = null;

function startCountdown() {
    const button = $("phone-send");
    // 59 seconds, not 60: the original's own resend gate is 59000 ms
    // (LOGIN_PROTOCOL_SPEC.md section 3.1, `setNotSendsms`).
    let left = 59;
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

/*
 * Ask for an SMS code.
 *
 * The server can answer with a captcha challenge instead of sending, in which
 * case `captchaRequired` comes back and the image-captcha field is revealed.
 * That is a state, not a failure: the request has to be repeated with the
 * code the user reads off the picture.
 */
async function sendPhoneCode() {
    const error = $("phone-error");
    error.textContent = "";
    const phone = $("phone-number").value.trim();
    if (!/^\d{11}$/.test(phone)) {
        error.textContent = "请输入 11 位手机号";
        return;
    }

    const button = $("phone-send");
    const verifyCode = $("phone-captcha").value.trim();
    button.disabled = true;
    const outcome = await callRaw("SendPhoneCode", phone, verifyCode);
    if (!outcome.ok) {
        button.disabled = false;
        if (/图形验证码/.test(outcome.error)) {
            $("phone-captcha-field").classList.remove("is-hidden");
        }
        error.textContent = describeLoginError(outcome.error);
        return;
    }

    const value = outcome.value || {};
    if (value.captchaRequired) {
        button.disabled = false;
        $("phone-captcha-field").classList.remove("is-hidden");
        error.textContent = value.message || "请输入图形验证码后重试";
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
    // The original validates the code locally as exactly six digits before it
    // sends anything (LOGIN_PROTOCOL_SPEC.md section 3.2).
    if (!/^\d{6}$/.test(code)) {
        error.textContent = "请输入 6 位短信验证码";
        return;
    }
    const verifyCode = $("phone-captcha").value.trim();
    const outcome = await callRaw("LoginWithPhone", { phone, code, verifyCode });
    if (!outcome.ok) {
        if (/图形验证码/.test(outcome.error)) {
            $("phone-captcha-field").classList.remove("is-hidden");
        }
        error.textContent = describeLoginError(outcome.error);
        raiseToast("login_failed", NOTIFY_TYPE.RedNotify, describeLoginError(outcome.error), 4000);
        return;
    }
    await loadSession();
}

// --- logout ----------------------------------------------------------------

async function logout() {
    stopQRPolling();
    // Best effort. The server clears local state even when the request fails,
    // so the account area resets either way -- leaving a profile up would show
    // a session that no longer exists.
    await callRaw("Logout");
    // 退出之后回主界面, 不是回登录页. 迅雷退出账号照样能下载, 把人赶回登录页
    // 等于逼他再登一次才能用 -- 而这正是未登录状态下不该发生的事.
    showApp({});
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
    // The record, not the `<tr>`.
    //
    // `render` looks the row up with `rows.get(taskId)` and then needs the
    // cells as well, so returning the `<tr>` here made the two disagree: the
    // first render got a real element from the return value, and every LATER
    // render got this record from the map and then wrote `row.dataset.status`
    // on it -- which threw "Cannot set properties of undefined". The task list
    // therefore worked exactly once per task. Returning the record and reading
    // `cells.tr` at both call sites is the fix.
    return rows.get(taskId);
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
        // `createRow` returns the same record `rows` holds, so this is the
        // cells bundle either way and `cells.tr` is the element to write to.
        const cells = rows.get(taskId) || createRow(taskId);
        const row = cells.tr;

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
        case "OnTaskStatusChanged": {
            // Read the previous status BEFORE merging: a failure toast belongs
            // to the transition into 失败, and a task that reports 失败 again
            // on the next poll must not raise a second one.
            const before = tasks.get(payload.taskId);
            const merged = mergeTask(payload.taskId, payload);
            if (
                notifySettings.fail &&
                Number(merged.status) === 4 &&
                (!before || Number(before.status) !== 4)
            ) {
                raiseToast(
                    "download_failed",
                    NOTIFY_TYPE.RedNotify,
                    `下载失败：${merged.name || merged.url || payload.taskId}`,
                    4000
                );
            }
            break;
        }
        case "OnTaskDetailChanged":
            mergeTask(payload.taskId, payload);
            break;
        case "OnTaskCompleted": {
            const merged = mergeTask(payload.taskId, payload);
            if (notifySettings.finish) {
                raiseToast(
                    "download_complete",
                    NOTIFY_TYPE.GreenNotify,
                    `下载完成：${merged.name || merged.url || payload.taskId}`,
                    3000
                );
            }
            break;
        }
        case "OnTaskRemoved":
            tasks.delete(payload.taskId);
            if (selected === payload.taskId) selected = null;
            break;
        case "onLoginSuc":
            // The payload is [userId, sessionId]; the account area wants the
            // profile, so the screen is re-decided rather than read off it.
            loadSession();
            raiseToast("login_success", NOTIFY_TYPE.GreenNotify, "登录成功", 3000);
            break;
        case "onLogout":
            // 回主界面, 不是登录页. 理由同 logout().
            showApp({});
            break;
        case "OnConfigValueChanaged":
            // The original's spelling, typo and all (contract NATIVE_EVENTS).
            if (payload) applyNotifySetting(payload.section, payload.key, payload.value);
            break;
        case "onSearchCommit":
            handleSearchCommit(payload);
            break;
        case "onClipboardLink":
            handleClipboardLink(payload);
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
// Toast notifications
// ---------------------------------------------------------------------------

/*
 * The manager and its view.
 *
 * `ToastNotifyManager` (toast.js) owns every decision -- the 13 ids, the four
 * types, one-at-a-time, the auto-close timer and its hover pause -- and this
 * block only paints the top item into `.xly-down-bar`. Keeping the split is
 * what lets the manager be asserted without a DOM.
 *
 * The module is loaded as a plain script (see index.html), so it may be
 * missing if the page is opened outside Electron; the manager then runs
 * headless rather than throwing on start-up.
 */
const ToastNotify = window.ToastNotify || {};
const NOTIFY_IDS = ToastNotify.NOTIFY_IDS || {};
const NOTIFY_TYPE = ToastNotify.ToastNotifyItemType || { GreenNotify: 0, RedNotify: 1 };

const toastElement = document.getElementById("toast");
const toastText = document.getElementById("toast-text");
const toastAction = document.getElementById("toast-action");

const toastManager = new ToastNotify.ToastNotifyManager({
    view: {
        show(item) {
            toastText.textContent = item.message || "";
            const isFail =
                item.type === NOTIFY_TYPE.RedNotify || item.type === NOTIFY_TYPE.RedCancelNotify;
            toastElement.classList.toggle("is-fail", isFail);
            const hasButton = Boolean(item.viewOptions && item.viewOptions.viewVisible);
            toastAction.classList.toggle("is-hidden", !hasButton);
            if (hasButton) toastAction.textContent = item.viewOptions.viewText || "查看";
            toastElement.classList.remove("is-hidden");
            // The id is left on the element so a test (and a curious user)
            // can see which of the 13 notices is up.
            toastElement.dataset.notifyId = item.id || "";
        },
        hide() {
            toastElement.classList.add("is-hidden");
        },
    },
});

/**
 * Raise a toast.
 *
 * @param {string} id
 * @param {number} type  ToastNotifyItemType
 * @param {string} message
 * @param {number} [duration]
 * @param {object} [viewOptions] `{ viewText, onView }` shows the 查看 button
 */
function raiseToast(id, type, message, duration, viewOptions) {
    return viewOptions
        ? toastManager.showNotifyEx(id, type, message, duration, viewOptions)
        : toastManager.showNotify(id, type, message, duration);
}

/*
 * Which completion notices the user wants.
 *
 * These are the original's own two switches for the corner popup
 * (`ConfigMsg-ConfigMsg_Finish` / `ConfigMsg-ConfigMsg_FailSuggest`), read once
 * and kept in step through `OnConfigValueChanaged`. When the window is in the
 * foreground the same events are drawn as an in-app toast instead of a system
 * notification -- the system half is decided in the main process, which is the
 * only side that knows whether the window is focused.
 */
const notifySettings = { finish: true, fail: true };

function applyNotifySetting(section, key, value) {
    if (section !== "ConfigMsg") return;
    if (key === "ConfigMsg_Finish") notifySettings.finish = value !== false && value !== "0";
    if (key === "ConfigMsg_FailSuggest") notifySettings.fail = value !== false && value !== "0";
}

async function loadNotifySettings() {
    const result = await callRaw("GetConfigValue");
    if (!result.ok || !result.value) return;
    const flat = result.value;
    if ("ConfigMsg.ConfigMsg_Finish" in flat) {
        notifySettings.finish = flat["ConfigMsg.ConfigMsg_Finish"] !== false;
    }
    if ("ConfigMsg.ConfigMsg_FailSuggest" in flat) {
        notifySettings.fail = flat["ConfigMsg.ConfigMsg_FailSuggest"] !== false;
    }
}

// ---------------------------------------------------------------------------
// Address-bar search
// ---------------------------------------------------------------------------

/*
 * The address bar is the toolbar's existing link input.
 *
 * Typing a keyword opens the search dropdown -- a separate 460x246 borderless
 * window (main/searchwindow.js) positioned under the input -- while the input
 * itself keeps the keyboard focus, exactly like the original (the search
 * window is a panel, not a focus target). Keys are therefore handled HERE and
 * forwarded to the panel through the main process.
 */
const searchState = { open: false };

/** Whether the typed text is a link to download rather than a search term. */
function looksLikeLink(text) {
    return /^(magnet:|thunder:|ed2k:|https?:\/\/|ftps?:\/\/)/i.test(String(text || "").trim());
}

/** The input's rect in the page, which the main process turns into a position. */
function searchAnchor() {
    const input = document.getElementById("url");
    const rect = input.getBoundingClientRect();
    return {
        left: Math.round(rect.left),
        top: Math.round(rect.bottom),
        width: Math.round(rect.width),
    };
}

async function searchInputChanged() {
    const input = document.getElementById("url");
    const keyword = input.value.trim();
    if (!keyword || looksLikeLink(keyword)) {
        await searchClose();
        return;
    }
    searchState.open = true;
    await call("SearchInput", keyword, searchAnchor());
}

async function searchKey(key) {
    if (!searchState.open) return;
    await call("SearchKey", key);
}

async function searchClose() {
    if (!searchState.open) return;
    searchState.open = false;
    await call("SearchClose");
}

/*
 * What a picked result does.
 *
 * The panel cannot act on the main window, so a pick travels back here as
 * `onSearchCommit` and this is the only place that turns one into an action:
 * a local hit selects its row, a cloud hit is taken back to local.
 */
async function handleSearchCommit(item) {
    if (!item) return;
    if (item.source === "local" && item.taskId) {
        selected = item.taskId;
        render();
        const cells = rows.get(item.taskId);
        if (cells) cells.tr.scrollIntoView({ block: "nearest" });
        return;
    }
    if (item.source === "pan" && item.fileId) {
        const outcome = await callRaw("PanDownloadFile", {
            fileId: item.fileId,
            name: item.name || "",
            size: item.size || 0,
            hash: item.hash || "",
            mimeType: item.mimeType || "",
        });
        const value = outcome.ok ? outcome.value : null;
        if (!outcome.ok || !value || value.ok === false) {
            const message = (value && value.message) || outcome.error || "云盘请求失败";
            raiseToast("search_pan_failed", NOTIFY_TYPE.RedNotify, `添加失败：${message}`, 4000);
            return;
        }
        // The original's id for "云盘添加完成" (`task_add_to_cloud_notify`).
        // This build has no cloud upload, so the only cloud-add it can report
        // is a take-back to local, which is what this branch is.
        raiseToast(
            NOTIFY_IDS.notifyIdTaskAdd2Cloud || "task_add_to_cloud_notify",
            NOTIFY_TYPE.GreenNotify,
            `已添加到下载列表：${value.name || item.name || ""}`,
            3000
        );
    }
}

/*
 * Clipboard hint.
 *
 * The original's `ClipBoardNS` polls and raises `notifyIdTaskOperatorCopyLink`
 * with "剪贴板有一个链接哦，去粘贴～" (renderer.js:65175-65194). Reading the
 * clipboard needs the main process (`electron.clipboard`), so the poll lives
 * there and arrives here as `onClipboardLink`; this only draws it.
 */
function handleClipboardLink(payload) {
    const kind = (payload && payload.kind) || "link";
    const id = kind === "magnet"
        ? NOTIFY_IDS.notifyIdTaskOperatorCopyMagnetLink
        : NOTIFY_IDS.notifyIdTaskOperatorCopyLink;
    const message = kind === "magnet"
        ? "剪贴板有一个磁力链接哦，去粘贴～"
        : "剪贴板有一个链接哦，去粘贴～";
    raiseToast(id || kind, NOTIFY_TYPE.GreenNotify, message, 3000, {
        viewText: "粘贴",
        onView: () => {
            const input = document.getElementById("url");
            input.value = (payload && payload.text) || "";
            updateToolbar();
        },
    });
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
    input.addEventListener("input", () => {
        updateToolbar();
        // The address bar doubles as the search box; a link being typed is not
        // a search term, so searchInputChanged closes the panel for one.
        searchInputChanged();
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            // Only while the panel is up: otherwise the arrows would move the
            // text caret, which is what an input normally does.
            if (searchState.open) {
                event.preventDefault();
                searchKey(event.key);
            }
            return;
        }
        if (event.key === "Escape") {
            searchClose();
            return;
        }
        if (event.key === "Enter") {
            // A link is meant to be downloaded; anything else is a search.
            // Without this split, pressing Enter on a pasted magnet would do
            // nothing whenever the panel happened to be open.
            if (looksLikeLink(input.value) || !searchState.open) {
                document.getElementById("add").click();
            } else {
                searchKey("Enter");
            }
        }
    });
    // The panel is a separate window, so it cannot observe the input losing
    // focus; closing on the main window's blur is the reliable equivalent.
    window.addEventListener("blur", () => searchClose());

    // The cloud-drive browser. It is its own window, so this is the whole
    // wiring: ask the main process to open it. The page lists the drive
    // itself once it is up.
    //
    // 云盘是唯一需要账号的入口 -- 迅雷不登录也能下载, 但云盘文件必须先登录才
    // 能取直链. 所以这里拦一下, 把人引到登录页, 而不是开出一个必然 401 的窗口.
    document.getElementById("open-pan").addEventListener("click", async () => {
        const loggedIn = await callRaw("IsLogined");
        if (!loggedIn.ok || !loggedIn.value) {
            showLogin();
            selectTab("qr");
            $("qr-status").textContent = "云盘需要登录迅雷账号";
            return;
        }
        call("CreatePanWindow");
    });

    // 设置不需要登录: 下载目录、连接数、限速这些是本地偏好, 未登录也要能改.
    document.getElementById("open-settings").addEventListener("click", () => {
        call("CreateSettingsWindow");
    });

    document.getElementById("signin").addEventListener("click", () => {
        showLogin();
        selectTab("qr");
    });

    // 不登了, 回去下载. 迅雷不强制登录, 所以登录页必须能退出去 -- 否则未登录的
    // 人进去就出不来, 这正是之前强制登录时的问题换了个样子.
    document.getElementById("login-back").addEventListener("click", () => {
        stopQRPolling();
        showApp({});
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
        // Setting `value` programmatically fires no `input` event, so the
        // panel would otherwise be left open over a now-empty box.
        searchClose();
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

    /*
     * The toast bar's own three gestures.
     *
     * `mousemove`/`mouseout` freeze and restart the countdown
     * (renderer.js:28005-28079). The ✕ closes the top item; the optional
     * 查看 button runs the item's `onView` and then closes it, which is what
     * the original's `item.cancel()` does for a RedCancel notice.
     */
    toastElement.addEventListener("mousemove", () => toastManager.pause());
    toastElement.addEventListener("mouseout", () => toastManager.resume());
    document.getElementById("toast-close").addEventListener("click", () => {
        toastManager.closeNotify();
    });
    toastAction.addEventListener("click", () => {
        const top = toastManager.getTopNotify();
        const onView = top && top.viewOptions && top.viewOptions.onView;
        toastManager.closeNotify();
        if (typeof onView === "function") onView();
    });

    bridge.onNativeEvent(({ name, payload }) => handleEvent(name, payload));
    bridge.onViews((views) => {
        for (const descriptor of views) mountView(descriptor);
    });
    bridge.onBootError((message) => showBanner(`启动失败: ${message}`));

    loadNotifySettings();
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
