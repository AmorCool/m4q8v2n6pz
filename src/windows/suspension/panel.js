/**
 * The float panel page.
 *
 * It draws the task list the ball summarises: a name, a progress bar and a
 * status per row, a total speed in the header, and the three buttons the
 * original's panel menu offers. Every row is a way back to the main window.
 *
 * The list comes from `onSuspensionState`, not from the raw kernel events. The
 * main process already merges those -- a detail event carries the speed and a
 * status event carries the state, and neither carries the name -- so the panel
 * reads the merged answer rather than re-deriving it. That is also what keeps
 * this page and the ball from disagreeing: there is one merge, in one process.
 *
 * The pointer reporting exists because the panel and the ball are separate
 * windows: moving from the ball to the panel fires "leave" on the ball before
 * it fires anything here, and the main process is holding a short timer to see
 * whether the pointer arrives. `panelEnter` cancels that timer.
 */

"use strict";

const bridge = window.thunderx || {};

const $ = (id) => document.getElementById(id);

const STATUS = {
    0: { key: "waiting", label: "等待中" },
    1: { key: "active", label: "下载中" },
    2: { key: "paused", label: "已暂停" },
    3: { key: "done", label: "已完成" },
    4: { key: "error", label: "失败" },
};

function send(type, extra) {
    if (typeof bridge.suspensionAction !== "function") return;
    bridge.suspensionAction(Object.assign({ type }, extra || {}));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(value) {
    const size = Number(value) || 0;
    if (size <= 0) return "0 B";
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

function formatSpeed(value) {
    const speed = Number(value) || 0;
    return speed > 0 ? `${formatBytes(speed)}/s` : "";
}

function progressOf(task) {
    const total = Number(task.totalSize) || 0;
    const done = Number(task.completedSize) || 0;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, done / total));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One row. Clicking it raises the main window, which is the only action. */
function buildRow(task) {
    const status = STATUS[Number(task.status)] || STATUS[0];

    const row = document.createElement("div");
    row.className = "xly-suspension-list__item";
    row.dataset.status = status.key;
    row.dataset.taskId = String(task.taskId);
    row.title = task.url || "";

    const name = document.createElement("span");
    name.className = "xly-suspension-list__name";
    name.textContent = task.name || task.btTitle || task.url || task.taskId;

    const bar = document.createElement("span");
    bar.className = "xly-suspension-list__bar";
    const fill = document.createElement("i");
    fill.style.width = `${(progressOf(task) * 100).toFixed(1)}%`;
    bar.appendChild(fill);

    const label = document.createElement("span");
    label.className = "xly-suspension-list__status";
    label.textContent = status.label;

    row.append(name, bar, label);
    row.addEventListener("click", () => send("openTask", { taskId: task.taskId }));
    return row;
}

function render(state) {
    const data = state || {};
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];

    const title = $("title");
    if (title) {
        title.textContent = data.activeCount > 0 ? `正在下载 ${data.activeCount} 个任务` : "迅雷";
        title.title = data.statusText || "";
    }

    const speed = $("speed");
    if (speed) speed.textContent = formatSpeed(data.speed);

    const items = $("items");
    if (items) {
        items.textContent = "";
        // Newest first: a task the user just added is the one they are looking
        // for, and the list is capped by the box, not by a count.
        for (const task of tasks.slice().reverse()) items.appendChild(buildRow(task));
    }

    const empty = $("empty");
    if (empty) empty.classList.toggle("is-hidden", tasks.length > 0);

    const pause = $("pause-all");
    if (pause) pause.disabled = !tasks.some((task) => Number(task.status) === 1);
    const resume = $("resume-all");
    if (resume) resume.disabled = !tasks.some((task) => Number(task.status) === 2 || Number(task.status) === 4);

    document.body.dataset.skin = data.skin === 1 ? "vip" : "default";
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
    const panel = $("panel");
    if (panel) {
        // The main process is holding a "did the pointer arrive" timer when the
        // ball reports leave; these two cancel and restart it.
        panel.addEventListener("mouseenter", () => send("panelEnter"));
        panel.addEventListener("mouseleave", () => send("panelLeave"));
    }

    const pause = $("pause-all");
    if (pause) pause.addEventListener("click", () => send("pauseAll"));
    const resume = $("resume-all");
    if (resume) resume.addEventListener("click", () => send("resumeAll"));
    const open = $("open-main");
    if (open) open.addEventListener("click", () => send("openTask"));

    if (typeof bridge.onNativeEvent === "function") {
        bridge.onNativeEvent((envelope) => {
            if (envelope && envelope.name === "onSuspensionState") render(envelope.payload);
        });
    }

    render({ tasks: [] });
}

init();
