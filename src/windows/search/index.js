/**
 * Search dropdown.
 *
 * Two jobs:
 *
 *   1. draw the hits: 本地任务 (the download list) and 云盘文件 (the drive)
 *   2. move the highlight on the address bar's arrow keys and answer Enter
 *
 * The page never owns the keyboard. The address bar stays in the main window
 * -- the panel is created with `focusable: false` -- so the keyword and the
 * keys arrive as `onSearchQuery` / `onSearchKey` events, and a pick goes back
 * through `SearchPick`. That is the original's split too: its `search-renderer`
 * was a panel under the main window's address bar.
 *
 * Searching is done with the original's own two calls: `SearchTask` for local
 * tasks and `SearchPanTask` for the drive. `SearchMovie` (在线影视联想) is
 * not called -- it needs the signed `api-shoulei-ssl.xunlei.com` backend, which
 * this build does not have, and an empty result would be a lie.
 */

"use strict";

const bridge = window.thunderx || {};

const $ = (id) => document.getElementById(id);

/** Call a server function and keep the failure, like the other window pages. */
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

/** Byte count as a short human string; 0 is not shown. */
function formatBytes(value) {
    const size = Number(value) || 0;
    if (size <= 0) return "";
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

const STATUS_LABEL = { 0: "等待中", 1: "正在下载", 2: "已暂停", 3: "已完成", 4: "失败" };

const PAN_ERROR_TEXT = {
    not_logged_in: "云盘搜索需要先登录迅雷账号",
    session_expired: "登录状态已过期，请重新登录",
    captcha_required: "云盘风控拦截：该请求需要设备指纹（未复刻）",
    network_error: "无法连接云盘，请检查网络",
    http_error: "云盘接口返回错误",
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    keyword: "",
    local: [],
    pan: [],
    panError: "",
    /** Flat, in render order: local hits first, then cloud hits. */
    items: [],
    /** The index Enter will open. */
    index: 0,
    loading: false,
    /** Bumped per query so a slow answer for an old keyword is dropped. */
    requestId: 0,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** The item shape the main window acts on, one per row. */
function buildItems() {
    const items = [];
    for (const task of state.local) {
        items.push({
            source: "local",
            taskId: task.taskId,
            name: task.name || task.url || task.taskId,
            url: task.url || "",
            status: task.status,
            totalSize: task.totalSize,
        });
    }
    for (const file of state.pan) {
        items.push({
            source: "pan",
            fileId: file.id,
            name: file.name || "(未命名)",
            size: file.size,
            hash: file.hash || "",
            mimeType: file.mimeType || "",
        });
    }
    return items;
}

/**
 * The name with the matched run wrapped in `<mark>`.
 *
 * Built from nodes rather than by injecting HTML: the name is user data (a file
 * name off the drive, a URL), and `innerHTML` here would be an injection point
 * in a page that has a preload bridge.
 */
function highlight(name, keyword) {
    const text = String(name || "");
    const needle = String(keyword || "");
    if (!needle) return document.createTextNode(text);

    const at = text.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return document.createTextNode(text);

    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(text.slice(0, at)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + needle.length);
    fragment.appendChild(mark);
    fragment.appendChild(document.createTextNode(text.slice(at + needle.length)));
    return fragment;
}

function sectionTitle(label) {
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = label;
    return title;
}

/** One row, tagged with its index in `state.items` so selection can find it. */
function buildRow(item, index) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.index = String(index);

    const name = document.createElement("span");
    name.className = "row-name";
    name.title = item.url || item.name;
    name.appendChild(highlight(item.name, state.keyword));

    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = item.source === "local"
        ? STATUS_LABEL[Number(item.status)] || ""
        : formatBytes(item.size);

    row.append(name, meta);
    row.addEventListener("click", () => pick(item));
    return row;
}

function render() {
    const sections = $("sections");
    sections.textContent = "";
    state.items = buildItems();

    if (state.local.length) {
        sections.appendChild(sectionTitle("本地任务"));
        state.local.forEach((task, i) => sections.appendChild(buildRow(state.items[i], i)));
    }

    const panOffset = state.local.length;
    if (state.pan.length) {
        sections.appendChild(sectionTitle("云盘文件"));
        state.pan.forEach((file, i) =>
            sections.appendChild(buildRow(state.items[panOffset + i], panOffset + i))
        );
    }

    if (state.panError) {
        const line = document.createElement("div");
        line.className = "hint";
        line.textContent = state.panError;
        sections.appendChild(line);
    }

    $("loading").classList.toggle("is-hidden", !state.loading);
    const empty = !state.loading && state.items.length === 0 && !state.panError;
    $("empty").classList.toggle("is-hidden", !empty);

    updateSelection();
}

/** Draw the keyboard highlight and keep it in view. */
function updateSelection() {
    const rows = $("sections").querySelectorAll(".row");
    for (const row of rows) {
        row.classList.toggle("is-selected", Number(row.dataset.index) === state.index);
    }
    const current = $("sections").querySelector(".row.is-selected");
    if (current && typeof current.scrollIntoView === "function") {
        current.scrollIntoView({ block: "nearest" });
    }
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/**
 * Run both searches for one keyword.
 *
 * The two answers arrive independently and are drawn as they land, because the
 * local list is instant while the drive call is a round trip -- waiting for
 * both would leave the panel blank for the length of a network call.
 */
function runSearch(keyword) {
    const text = String(keyword === undefined || keyword === null ? "" : keyword).trim();
    state.keyword = text;
    state.local = [];
    state.pan = [];
    state.panError = "";
    state.index = 0;
    state.loading = true;
    state.requestId += 1;
    const requestId = state.requestId;

    render();
    if (!text) {
        state.loading = false;
        render();
        return;
    }

    const local = callRaw("SearchTask", text).then((result) => {
        if (requestId !== state.requestId) return;
        state.local = result.ok && Array.isArray(result.value) ? result.value : [];
        render();
    });

    const pan = callRaw("SearchPanTask", text).then((result) => {
        if (requestId !== state.requestId) return;
        const value = result.ok ? result.value : null;
        if (!result.ok || !value || value.ok === false) {
            state.pan = [];
            state.panError = PAN_ERROR_TEXT[(value && value.code) || ""] ||
                (value && value.message) || result.error || "云盘搜索不可用";
        } else {
            state.pan = Array.isArray(value.files) ? value.files : [];
            state.panError = "";
        }
        render();
    });

    Promise.all([local, pan]).then(() => {
        if (requestId !== state.requestId) return;
        state.loading = false;
        render();
    });
}

/** Open a result: the main window decides what that means. */
async function pick(item) {
    if (!item) return;
    await callRaw("SearchPick", item);
}

/** The address bar's arrow keys and Enter. */
function handleKey(key) {
    if (key === "ArrowDown") {
        if (state.items.length) state.index = Math.min(state.index + 1, state.items.length - 1);
        updateSelection();
        return;
    }
    if (key === "ArrowUp") {
        state.index = Math.max(state.index - 1, 0);
        updateSelection();
        return;
    }
    if (key === "Enter") {
        pick(state.items[state.index]);
    }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function onNativeEvent(envelope) {
    const name = envelope && envelope.name;
    const payload = (envelope && envelope.payload) || {};
    if (name === "onSearchQuery") runSearch(payload.keyword);
    else if (name === "onSearchKey") handleKey(payload.key);
}

if (typeof bridge.onNativeEvent === "function") {
    bridge.onNativeEvent(onNativeEvent);
}
