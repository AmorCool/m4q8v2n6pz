/**
 * Renderer.
 *
 * Two jobs, kept separate:
 *
 *   1. draw the task list from the events the kernel raises
 *   2. mount the views the plugins asked for as `<webview>` elements
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
            document.getElementById("account-name").textContent = payload && payload[0] ? payload[0] : "已登录";
            break;
        case "onLogout":
            document.getElementById("account-name").textContent = "未登录";
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

async function call(method, ...args) {
    const result = await bridge.rpc(method, ...args);
    if (!result || !result.ok) {
        showBanner(String((result && result.error) || "调用失败"));
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
        // The kernel decides whether this is a torrent, a magnet or a plain
        // URL, so the renderer does not guess and does not send a type.
        await call("AddTask", { url });
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
        if (selected) await call("RemoveTask", selected);
    });

    bridge.onNativeEvent(({ name, payload }) => handleEvent(name, payload));
    bridge.onViews((views) => {
        for (const descriptor of views) mountView(descriptor);
    });
    bridge.onBootError((message) => showBanner(`启动失败: ${message}`));

    mountQueuedViews();
    render();
}

init();
