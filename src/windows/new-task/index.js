/**
 * New-task dialog.
 *
 * Three jobs:
 *
 *   1. turn what the user pastes into a list of links, and say how many tasks
 *      that is before anything is created
 *   2. for a magnet or a torrent, wait for the file list and let the user
 *      choose which files to download
 *   3. hand the result to `CreateNewTaskEx` -- once, for the whole batch
 *
 * Nothing here talks to the engine. The magnet pre-parse is a server function
 * (`PreDownload`), the create is a server function (`CreateNewTaskEx`), and the
 * window stays a view. The one exception is the file list, which is data the
 * pre-parse returns rather than an action.
 *
 * A note on the save directory and magnets: aria2 fixes a task's `dir` when
 * the task is added, and the pre-parse adds the task (it has to -- there is no
 * way to read a torrent's file list without one). So the directory is taken
 * from the field at the moment the parse starts; changing it afterwards does
 * not move the already-created task. That is a real limitation of doing the
 * pre-parse through the engine, and it is written down rather than hidden.
 */

"use strict";

const bridge = window.thunderx || {};

const $ = (id) => document.getElementById(id);

/*
 * Call a server function and keep the failure.
 *
 * The dialog has its own error line, and it is the only place a failure is
 * visible: a banner in the main window would be behind this one.
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
// Link handling
// ---------------------------------------------------------------------------

/*
 * The schemes the client accepts.
 *
 * Taken from the original's own clipboard handler, which tests exactly these
 * six prefixes. `magnet:?` rather than `magnet:` is the original's spelling: a
 * magnet URI is `magnet:` followed by a query, so the two agree on every link
 * that is actually valid.
 */
const LINK_PREFIXES = ["http://", "https://", "ftp://", "magnet:?", "thunder://", "ed2k://"];

/**
 * Split pasted text into links.
 *
 * Whitespace, not newlines: a paste from a web page arrives with newlines, one
 * from a terminal with spaces, and both are the same list. This is the PC
 * client's own `split()` behaviour.
 */
function splitLinks(text) {
    return String(text || "")
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function looksLikeLink(value) {
    const lower = String(value || "").toLowerCase();
    return LINK_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isMagnet(value) {
    return /^magnet:/i.test(String(value || ""));
}

function isTorrentUrl(value) {
    return /\.(torrent|metalink)(\?|#|$)/i.test(String(value || ""));
}

/** The file name a URL points at, for the torrent-source row. */
function nameFromUrl(value) {
    const text = String(value || "");
    const tail = text.split(/[?#]/)[0].split("/").pop();
    return tail || text;
}

function basename(value) {
    const text = String(value || "");
    const parts = text.split(/[\\/]/);
    return parts[parts.length - 1] || text;
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    /** A local .torrent the user chose; mutually exclusive with the link box. */
    torrentPath: "",
    /** The file list the pre-parse returned, or null. */
    files: null,
    /** The task the pre-parse created, adopted on submit instead of re-created. */
    taskId: "",
    /** The source key the last pre-parse was started for. */
    preparseKey: "",
    /** idle | loading | done | timeout | unavailable */
    preparseState: "idle",
    /** True while a create is in flight, so a double click cannot add twice. */
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

// ---------------------------------------------------------------------------
// Link box
// ---------------------------------------------------------------------------

function updateCount() {
    const urls = splitLinks($("links").value);
    const hint = $("link-count");
    if (state.torrentPath) {
        hint.textContent = "";
        return;
    }
    if (urls.length > 1) {
        hint.textContent = `将创建 ${urls.length} 个任务`;
    } else if (urls.length === 1) {
        hint.textContent = looksLikeLink(urls[0]) ? "" : "不是可识别的下载链接";
    } else {
        hint.textContent = "";
    }
}

function updateToolbar() {
    const urls = splitLinks($("links").value);
    const hasSource = urls.length > 0 || !!state.torrentPath;
    /*
     * The button is held down while a pre-parse is running.
     *
     * The spec's rule is "a non-empty box enables it", but a create during the
     * parse would make a second task for the same magnet: the parse has
     * already added one, and the submit would add another. The wait is the
     * feature -- the file list is what the user is waiting for -- and the
     * degraded label below is how the wait ends.
     */
    const busy = state.busy || state.preparseState === "loading";
    const submit = $("submit");
    submit.disabled = !hasSource || busy;
    submit.textContent =
        state.preparseState === "timeout"
            ? "直接创建（不选文件）"
            : state.preparseState === "loading"
              ? "解析中…"
              : "立即下载";
}

/** The single BT source in the box, or null. */
function btSource() {
    const urls = splitLinks($("links").value);
    if (urls.length !== 1) return null;
    const url = urls[0];
    if (isMagnet(url) || isTorrentUrl(url)) return { url };
    return null;
}

function onLinksInput() {
    // Typing a link replaces a chosen torrent file: one dialog, one source.
    if ($("links").value.trim() && state.torrentPath) {
        state.torrentPath = "";
        hideSource();
    }
    updateCount();
    updateToolbar();

    const source = btSource();
    const key = source ? source.url : "";
    if (key && key !== state.preparseKey) {
        startPreParse(source, key);
    } else if (!key && state.preparseKey) {
        resetPreparse();
        updateToolbar();
    }
}

// ---------------------------------------------------------------------------
// Torrent source row
// ---------------------------------------------------------------------------

function showSource(name) {
    $("source-name").textContent = name;
    $("source-name").title = name;
    $("source").classList.remove("is-hidden");
}

function hideSource() {
    $("source").classList.add("is-hidden");
}

function setTorrentSource(path) {
    state.torrentPath = path;
    // A file and a link are two answers to the same question, so choosing one
    // clears the other rather than leaving the dialog to guess which wins.
    $("links").value = "";
    showSource(basename(path));
    updateCount();
    startPreParse({ torrentPath: path }, `torrent:${path}`);
}

async function pickTorrent() {
    const result = await callRaw("PickDirectory", "torrent");
    if (!result.ok) {
        showError(`选择种子文件失败：${result.error}`);
        return;
    }
    if (!result.value) return;
    setTorrentSource(result.value);
}

// ---------------------------------------------------------------------------
// File list
// ---------------------------------------------------------------------------

function showFilesLoading(message) {
    $("files").classList.remove("is-hidden");
    $("files-head").classList.add("is-hidden");
    $("files-list").classList.add("is-hidden");
    $("files-loading").classList.remove("is-hidden");
    $("files-status").textContent = message;
}

function showFilesList(count) {
    if (count <= 0) {
        // Nothing to choose. An empty bordered box would read as a rendering
        // bug, so the whole section goes away instead.
        hideFiles();
        return;
    }
    $("files").classList.remove("is-hidden");
    $("files-loading").classList.add("is-hidden");
    $("files-head").classList.remove("is-hidden");
    $("files-list").classList.remove("is-hidden");
}

function hideFiles() {
    $("files").classList.add("is-hidden");
}

function renderFiles(files) {
    const list = $("files-list");
    list.textContent = "";

    for (const file of files) {
        const row = document.createElement("div");
        row.className = "file-row";
        // aria2's own 1-based file number, carried through to `select-file`.
        row.dataset.index = String(file.index);

        const label = document.createElement("label");
        label.className = "files-check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = file.selected !== false;
        box.addEventListener("change", updateFilesAll);
        label.appendChild(box);

        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = file.fileName || file.path || "";
        name.title = file.path || "";

        const size = document.createElement("span");
        size.className = "file-size";
        size.textContent = formatBytes(file.fileSize);

        const progress = document.createElement("span");
        progress.className = "file-progress";
        const bar = document.createElement("span");
        bar.className = "bar";
        const fill = document.createElement("i");
        const size0 = Number(file.fileSize) || 0;
        const done = Number(file.completedLength) || 0;
        const fraction = size0 > 0 ? Math.min(1, Math.max(0, done / size0)) : 0;
        fill.style.width = `${(fraction * 100).toFixed(1)}%`;
        bar.appendChild(fill);
        const text = document.createElement("span");
        text.textContent = `${Math.round(fraction * 100)}%`;
        progress.append(bar, text);

        row.append(label, name, size, progress);
        list.appendChild(row);
    }

    updateFilesAll();
}

/** File checkboxes, kept in step with the header's select-all. */
function fileBoxes() {
    return Array.from($("files-list").querySelectorAll("input[type=checkbox]"));
}

function updateFilesAll() {
    const boxes = fileBoxes();
    const all = $("files-all");
    const checked = boxes.filter((box) => box.checked).length;
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
}

function toggleAllFiles() {
    const wanted = $("files-all").checked;
    for (const box of fileBoxes()) box.checked = wanted;
    $("files-all").indeterminate = false;
}

/** The checked files' aria2 indices. Empty when there is nothing to choose. */
function selectedIndices() {
    const indices = [];
    for (const row of $("files-list").querySelectorAll(".file-row")) {
        const box = row.querySelector("input[type=checkbox]");
        if (box && box.checked) indices.push(Number(row.dataset.index));
    }
    return indices;
}

// ---------------------------------------------------------------------------
// Pre-parse
// ---------------------------------------------------------------------------

function resetPreparse() {
    state.preparseKey = "";
    state.preparseState = "idle";
    state.files = null;
    state.taskId = "";
    hideFiles();
}

/**
 * Ask the main process for a BT source's file list.
 *
 * `key` identifies the source the request was made for. A reply for a source
 * the user has already typed over is dropped, which is what stops a slow
 * magnet from filling the list after the box has moved on.
 */
async function startPreParse(source, key) {
    state.preparseKey = key;
    state.preparseState = "loading";
    state.files = null;
    state.taskId = "";
    clearMessages();
    showFilesLoading("正在解析种子信息…");
    updateToolbar();

    const result = await callRaw("PreDownload", source, $("dir").value.trim());
    if (state.preparseKey !== key) return;

    if (!result.ok) {
        state.preparseState = "unavailable";
        hideFiles();
        showError(`无法解析种子信息：${result.error}`);
        updateToolbar();
        return;
    }

    const value = result.value || {};
    if (value.ok) {
        state.preparseState = "done";
        state.taskId = value.taskId || "";
        state.files = value.files || [];
        if (state.files.length) {
            renderFiles(state.files);
            showFilesList(state.files.length);
        } else {
            // A torrent with no files is odd but possible (metadata arrived
            // before the file list did). Saying so beats an empty box.
            showFilesList(0);
            showNotice("该种子没有可选文件，将直接创建");
        }
    } else if (value.reason === "timeout") {
        // The task exists and is still trying. The user is offered the choice
        // that does not need a file list, rather than a dead end.
        state.preparseState = "timeout";
        state.taskId = value.taskId || "";
        state.files = null;
        hideFiles();
        showError("种子信息解析超时，将按磁力链直接创建（不选文件）");
    } else {
        state.preparseState = "unavailable";
        state.files = null;
        state.taskId = "";
        hideFiles();
        showError("当前没有可用的下载引擎，无法列出种子文件");
    }
    updateToolbar();
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

async function readClipboard() {
    try {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
            throw new Error("no clipboard api");
        }
        return await navigator.clipboard.readText();
    } catch (error) {
        // Reading the clipboard is a permission the page may not hold. Saying
        // so is better than a button that appears to do nothing.
        showError("读取剪贴板失败，请在链接框里按 Ctrl+V 粘贴");
        return "";
    }
}

function appendLinks(text) {
    const box = $("links");
    const existing = box.value.replace(/\s*$/, "");
    box.value = existing ? `${existing}\n${text}` : String(text);
}

async function pasteLinks() {
    const text = await readClipboard();
    if (!text) return;
    appendLinks(text);
    onLinksInput();
}

/**
 * Paste and create in one step.
 *
 * The pre-parse is deliberately not started: the point of this menu item is to
 * skip the wait. A torrent link still creates a task -- it just does not get a
 * file-selection step, which is the same outcome as the timeout path.
 */
async function pasteAndDownload() {
    // A parse already running means the box holds a source the user is
    // deciding about; adding a second task for it behind their back is worse
    // than saying no.
    if (state.preparseState === "loading") {
        showError("正在解析种子信息，请稍候再试");
        return;
    }
    const text = await readClipboard();
    if (!text) return;
    appendLinks(text);
    updateCount();
    await submit();
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

function setBusy(busy) {
    state.busy = busy;
    updateToolbar();
}

async function submit() {
    if (state.busy) return;
    const urls = splitLinks($("links").value);
    if (!urls.length && !state.torrentPath) return;

    clearMessages();

    /*
     * An empty selection is refused rather than treated as "everything".
     *
     * aria2 reads a missing `select-file` as "all files", so submitting with
     * every box cleared would download exactly what the user just deselected.
     */
    if (state.files && state.files.length > 0 && selectedIndices().length === 0) {
        showError("请至少选择一个文件");
        return;
    }

    setBusy(true);

    const dir = $("dir").value.trim();
    const startNow = $("start-now").checked;
    const out = $("out").value.trim();

    // A local torrent is one task with no URL; a box of links is one per line.
    const sources = state.torrentPath ? [{ torrentPath: state.torrentPath }] : urls.map((url) => ({ url }));

    let created = 0;
    let failure = "";
    for (const source of sources) {
        const single = sources.length === 1;
        const adopt =
            single &&
            state.taskId &&
            !!state.preparseKey &&
            state.preparseKey === (source.url || `torrent:${source.torrentPath}`);

        const spec = adopt
            ? { taskId: state.taskId, dir, startNow }
            : Object.assign({ dir, startNow }, source);
        // A file name is meaningful for one plain download only: a torrent
        // names its own files, and a batch has no single name to give.
        if (!adopt && single && out && !source.torrentPath && !isMagnet(source.url) && !isTorrentUrl(source.url)) {
            spec.out = out;
        }

        const indices = adopt ? selectedIndices() : [];
        const result = await callRaw("CreateNewTaskEx", spec, indices);
        if (result.ok && result.value) created += 1;
        else failure = result.error || "创建失败";
    }

    setBusy(false);

    if (created > 0) {
        // The window stays open. The original keeps it up so a second link can
        // be added without reopening, and closing it would throw away the save
        // directory the user just chose.
        showNotice(`已添加 ${created} 个任务`);
        $("links").value = "";
        $("out").value = "";
        state.torrentPath = "";
        hideSource();
        resetPreparse();
        updateCount();
        updateToolbar();
    }
    if (failure) showError(failure);
}

// ---------------------------------------------------------------------------
// Right-click menu
// ---------------------------------------------------------------------------

function showMenu(x, y) {
    const menu = $("menu");
    menu.classList.remove("is-hidden");
    // Clamped to the window: the dialog cannot be scrolled, so a menu that
    // opened past the edge would have unreachable items.
    const rect = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

function hideMenu() {
    $("menu").classList.add("is-hidden");
}

async function runMenuAction(action) {
    hideMenu();
    if (action === "paste") await pasteLinks();
    else if (action === "paste-download") await pasteAndDownload();
    else if (action === "clear") {
        $("links").value = "";
        onLinksInput();
    }
}

// ---------------------------------------------------------------------------
// Prefill
// ---------------------------------------------------------------------------

/**
 * Apply what the caller already knew.
 *
 * Delivered as an event rather than read at load: the window is created before
 * its page exists, so the main process has to wait for `did-finish-load` to
 * send it -- and a page cannot pull what was sent before it was there.
 */
function applyPrefill(payload) {
    const data = payload || {};
    if (data.dir) $("dir").value = data.dir;
    if (typeof data.startNow === "boolean") $("start-now").checked = data.startNow;

    if (data.torrentPath) {
        setTorrentSource(data.torrentPath);
        return;
    }
    if (data.url) appendLinks(data.url);
    onLinksInput();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function closeWindow() {
    if (typeof bridge.closeWindow === "function") bridge.closeWindow();
    else window.close();
}

async function browseDirectory() {
    const result = await callRaw("PickDirectory", "dir");
    if (!result.ok) {
        showError(`选择目录失败：${result.error}`);
        return;
    }
    if (result.value) $("dir").value = result.value;
}

function init() {
    $("close").addEventListener("click", closeWindow);
    $("cancel").addEventListener("click", closeWindow);
    $("submit").addEventListener("click", () => submit());
    $("browse").addEventListener("click", browseDirectory);
    $("pick-torrent").addEventListener("click", pickTorrent);
    $("source-pick").addEventListener("click", pickTorrent);
    $("paste").addEventListener("click", pasteLinks);
    $("clear").addEventListener("click", () => {
        $("links").value = "";
        onLinksInput();
    });
    $("files-all").addEventListener("change", toggleAllFiles);

    const box = $("links");
    box.addEventListener("input", onLinksInput);
    box.addEventListener("keydown", (event) => {
        // Ctrl+Enter creates without reaching for the mouse; the original
        // tests the same combination.
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
        }
    });
    box.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showMenu(event.clientX, event.clientY);
    });

    $("menu").addEventListener("click", (event) => {
        const action = event.target && event.target.dataset ? event.target.dataset.action : "";
        if (action) runMenuAction(action);
    });
    document.addEventListener("click", (event) => {
        if (!event.target.closest || !event.target.closest("#menu")) hideMenu();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideMenu();
    });

    if (typeof bridge.onNativeEvent === "function") {
        bridge.onNativeEvent(({ name, payload }) => {
            if (name === "onNewTaskPrefill") applyPrefill(payload);
        });
    }

    updateCount();
    updateToolbar();
}

init();
