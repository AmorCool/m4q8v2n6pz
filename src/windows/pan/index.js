/**
 * Cloud-drive browser.
 *
 * Two jobs:
 *
 *   1. draw one folder of the drive: a breadcrumb, a list, and a download
 *      button on every file
 *   2. ask the main process for a direct link when that button is pressed
 *
 * The page never talks to the drive itself. Listing and link extraction are
 * server functions (`PanListFiles`, `PanDownloadFile`), which is the one place
 * this differs from the original: there the ThunderPanPlugin page called the
 * drive API directly from the renderer (app.js@57600 runs in the plugin
 * context). Moving it behind the transport is what keeps the session material
 * -- cookies, peer id, device id -- in the main process where `login.js`
 * already keeps it, instead of copying it into a page.
 *
 * The flow the download button stands in for is the original's
 * `drive/fetchBackFiles` -> `openFetchBackBW` -> `IpcStartRetrieval` ->
 * `addOrRefreshServerAndToken` chain (PAN_DIRECT_LINK_SPEC.md section 1.1).
 * The fetch-back popup in the middle exists to choose a save directory; this
 * window has no directory picker, so the button goes straight from the list
 * to the link and the save directory is the application default.
 */

"use strict";

const bridge = window.thunderx || {};

const $ = (id) => document.getElementById(id);

/**
 * Call a server function and keep the failure.
 *
 * The drive's own errors carry a code (`not_logged_in` vs `session_expired`),
 * so the value is returned whole rather than unwrapped: the two 401 cases read
 * the same on the wire and only the code tells them apart.
 */
async function callRaw(method, ...args) {
    if (typeof bridge.rpc !== "function") {
        return { ok: false, error: "应用桥不可用" };
    }
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

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Byte count as a short human string. A folder reports 0 and is not shown. */
function formatBytes(value) {
    const size = Number(value) || 0;
    if (size <= 0) return "-";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let index = 0;
    let scaled = size;
    while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
    }
    const digits = scaled >= 100 || index === 0 ? 0 : 1;
    return `${scaled.toFixed(digits)} ${units[index]}`;
}

/**
 * A drive timestamp as a short local string.
 *
 * The drive sends RFC3339 in `modified_time`. An unparseable value is passed
 * through unchanged rather than shown as "Invalid Date".
 */
function formatTime(value) {
    const text = String(value || "");
    if (!text) return "";
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A drive entry is a folder when its `kind` says so. */
function isFolder(file) {
    return !!file && (file.isFolder === true || file.kind === "drive#folder");
}

/**
 * Wording for the error codes the drive client raises.
 *
 * An unrecognised code falls through to the raw message, which names the
 * cause better than a generic failure would.
 */
const ERROR_TEXT = {
    not_logged_in: "尚未登录迅雷账号，请先在主窗口登录",
    session_expired: "登录状态已过期，请重新登录",
    captcha_required: "云盘风控拦截：该请求需要设备指纹（未复刻）",
    forbidden: "没有访问该文件的权限",
    not_found: "文件不存在或已被删除",
    no_direct_link: "云盘没有返回下载直链",
    http_error: "云盘接口返回错误",
    network_error: "无法连接云盘，请检查网络",
};

function describeError(code, message) {
    return ERROR_TEXT[code] || message || "云盘请求失败";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    /** The folder currently open; "" is the drive root. */
    parentId: "",
    /** Path from the root to the open folder, for the breadcrumb. */
    crumbs: [{ id: "", name: "我的云盘" }],
    /** The listing currently drawn. */
    files: [],
    /** True while a download is being created, so a double click cannot add twice. */
    busy: false,
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function showError(message) {
    const line = $("error");
    line.textContent = message || "";
    line.classList.toggle("is-hidden", !message);
}

function showNotice(message) {
    const line = $("notice");
    line.textContent = message || "";
    line.classList.toggle("is-hidden", !message);
}

function clearMessages() {
    showError("");
    showNotice("");
}

function setLoading(on, text) {
    $("loading").classList.toggle("is-hidden", !on);
    if (text) $("loading-text").textContent = text;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Redraw the breadcrumb from `state.crumbs`. */
function renderCrumbs() {
    const nav = $("crumbs");
    // Clearing through textContent rather than removeChild keeps this one
    // statement and drops the listeners with the nodes.
    nav.textContent = "";

    state.crumbs.forEach((crumb, index) => {
        if (index > 0) {
            const separator = document.createElement("span");
            separator.className = "crumb-sep";
            separator.textContent = "/";
            nav.appendChild(separator);
        }

        const current = index === state.crumbs.length - 1;
        const button = document.createElement("button");
        button.type = "button";
        button.className = current ? "crumb is-current" : "crumb";
        button.textContent = crumb.name;
        button.title = crumb.name;
        // The open folder is not a link -- clicking it would reload the page
        // the user is already looking at.
        if (!current) button.addEventListener("click", () => gotoCrumb(index));
        nav.appendChild(button);
    });
}

/** One row. Folders navigate; files download. */
function buildRow(file) {
    const row = document.createElement("div");
    row.className = "file-row";

    const folder = isFolder(file);

    // The name cell. A folder is a button (the whole row is the navigation
    // target); a file is plain text, so a file does not look clickable.
    const name = document.createElement(folder ? "button" : "span");
    name.className = folder ? "file-name is-folder" : "file-name";
    name.title = file.name || "";
    if (folder) name.type = "button";

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.textContent = folder ? "▸" : "·";
    name.appendChild(icon);

    const label = document.createElement("span");
    label.textContent = file.name || "(未命名)";
    name.appendChild(label);

    if (folder) name.addEventListener("click", () => openFolder(file));

    const size = document.createElement("span");
    size.className = "col-size";
    size.textContent = folder ? "-" : formatBytes(file.size);

    const time = document.createElement("span");
    time.className = "col-time";
    time.textContent = formatTime(file.modifiedTime);

    const action = document.createElement("span");
    action.className = "col-action";
    if (!folder) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "download";
        button.textContent = "下载";
        button.addEventListener("click", () => downloadFile(file));
        action.appendChild(button);
    }

    row.append(name, size, time, action);
    return row;
}

function renderFiles() {
    const list = $("files");
    list.textContent = "";

    if (!state.files.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "这个文件夹是空的";
        list.appendChild(empty);
        return;
    }

    for (const file of state.files) list.appendChild(buildRow(file));
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function currentPath() {
    return state.crumbs.map((crumb) => crumb.name).join("/");
}

/**
 * Load one folder and draw it.
 *
 * The listing is fetched before anything is drawn so that a failure leaves
 * the previous folder's rows in place rather than replacing them with an
 * empty list that reads as "the drive is empty".
 */
async function load(parentId) {
    state.parentId = parentId || "";
    clearMessages();
    setLoading(true, "正在读取云盘…");

    const result = await callRaw("PanListFiles", { parentId: state.parentId });
    setLoading(false);

    const value = result.ok ? result.value : null;
    if (!result.ok || !value || value.ok === false) {
        const code = (value && value.code) || "";
        const message = (value && value.message) || result.error || "";
        showError(describeError(code, message));
        $("status-text").textContent = currentPath();
        return;
    }

    state.files = Array.isArray(value.files) ? value.files : [];
    renderFiles();
    $("count").textContent = `${state.files.length} 项`;
    $("status-text").textContent = currentPath();
}

function gotoCrumb(index) {
    state.crumbs = state.crumbs.slice(0, index + 1);
    renderCrumbs();
    load(state.crumbs[index].id);
}

function openFolder(file) {
    state.crumbs.push({ id: file.id, name: file.name || "(未命名)" });
    renderCrumbs();
    load(file.id);
}

function refresh() {
    load(state.parentId);
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Ask for the file's direct link and add the download.
 *
 * The extraction happens in the main process (`PanDownloadFile`), which
 * returns either `{ ok: true, taskId }` or `{ ok: false, code, message }`. The
 * button is disabled while the request is in flight because the drive issues
 * one link per call and a second click would create a second task for the same
 * file.
 */
async function downloadFile(file) {
    if (state.busy) return;
    state.busy = true;
    clearMessages();

    const result = await callRaw("PanDownloadFile", {
        fileId: file.id,
        name: file.name || "",
        size: file.size || 0,
        hash: file.hash || "",
        mimeType: file.mimeType || "",
    });

    state.busy = false;

    const value = result.ok ? result.value : null;
    if (!result.ok || !value || value.ok === false) {
        const code = (value && value.code) || "";
        const message = (value && value.message) || result.error || "";
        showError(`下载失败：${describeError(code, message)}`);
        return;
    }

    showNotice(`已添加到下载列表：${value.name || file.name || ""}`);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
    $("refresh").addEventListener("click", refresh);
    renderCrumbs();
    load("");
}

init();
