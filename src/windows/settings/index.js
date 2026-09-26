/**
 * Settings centre.
 *
 * Three jobs:
 *
 *   1. ask the main process for the schema (`GetSettingsSchema`) and the
 *      current values (`GetConfigValue`), and draw one control per item
 *   2. write a change back with `SetConfigValue` -- one call per changed
 *      control, which is all it takes, because the main process's
 *      `ConfigHandler` is subscribed to the store and pushes the matching
 *      engine option itself
 *   3. stay in step with changes made anywhere else, through
 *      `OnConfigValueChanaged`
 *
 * The page has no schema of its own. It renders whatever the schema says, so a
 * setting added to `settings-schema.js` shows up here without this file
 * changing -- which is the point of the original's `generator-view` recursion
 * and the reason the thirteen `conf-*` Vue components were not reproduced.
 *
 * A control is never built from a string of HTML: every element comes from
 * `document.createElement`, so the page is testable under the same small DOM
 * stub the other windows are tested with.
 */

"use strict";

const bridge = window.thunderx || {};

const $ = (id) => document.getElementById(id);

/**
 * Call a server function and keep the failure.
 *
 * The page has one status line, and a failure that went to the main window's
 * banner would be behind this window -- so the outcome is returned rather than
 * thrown.
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
// State
// ---------------------------------------------------------------------------

/** The annotated schema, as returned by GetSettingsSchema. */
let schema = [];
/** "section.key" -> value, as returned by GetConfigValue. */
let values = {};
/** The signed-in user id, for the keys the original scopes per account. */
let userId = "";

/**
 * Every rendered control, keyed by its schema name.
 *
 * Two maps are needed and they are not the same key space: `controls` is what
 * a change event updates, `dependents` is what a switch enables or disables.
 * A child's own name is in both. `controlByStorage` is a third index, from the
 * stored key back to the control, because a change pushed by the main process
 * names the storage key (`radio_id_<userid>`) rather than the schema name.
 */
const controls = new Map();
const dependents = new Map();
const controlByStorage = new Map();

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

/**
 * The key a value is stored under.
 *
 * The original scopes some keys per account: `UserCommunitySet-radio_id_` is
 * stored as `radio_id_<userid>` once a session exists and without the suffix
 * when it does not (SETTINGS_SEARCH_NOTIFY_SPEC.md section 1.8, risk 2). The
 * schema marks those with `userScoped`; appending here keeps the rule in one
 * place instead of at each call site.
 */
function storageKey(item) {
    const suffix = item.userScoped && userId ? String(userId) : "";
    return `${item.section}.${item.key}${suffix}`;
}

/** The value to show, falling back to the schema default. */
function readValue(item) {
    const key = storageKey(item);
    if (Object.prototype.hasOwnProperty.call(values, key)) return values[key];
    return item.default;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function setStatus(message, kind) {
    const el = $("status");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-ok", "is-err");
    if (kind) el.classList.add(kind);
}

// ---------------------------------------------------------------------------
// Writing a value
// ---------------------------------------------------------------------------

/**
 * Store one change and redraw the dependent rows.
 *
 * The value's type is normalised to what the original stores: a checkbox is a
 * boolean, except where `valueType: "number"` says the same control is held as
 * 0/1 (一键下载), and a `list` is an array.
 */
async function writeValue(item, raw) {
    const value = normalize(item, raw);
    const key = item.key + (item.userScoped && userId ? String(userId) : "");

    const outcome = await callRaw("SetConfigValue", item.section, key, value);
    if (!outcome.ok) {
        setStatus(`保存失败：${outcome.error}`, "is-err");
        return false;
    }
    values[storageKey(item)] = value;
    applyDependents(item, value);
    setStatus("已保存", "is-ok");
    return true;
}

/** Coerce a control's raw DOM value into the stored type. */
function normalize(item, raw) {
    switch (item.type) {
        case "checkbox":
            if (item.valueType === "number") return raw ? 1 : 0;
            return !!raw;
        case "checkboxInput":
        case "checkboxSelect":
            return !!raw;
        case "list":
            if (Array.isArray(raw)) return raw;
            return String(raw || "")
                .split(/[,\n]/)
                .map((part) => part.trim())
                .filter(Boolean);
        default:
            return raw;
    }
}

/** Enable or disable the rows that hang off a switch. */
function applyDependents(item, value) {
    const list = dependents.get(item.name);
    if (!list) return;
    const on = item.type === "radio"
        // A radio's dependents belong to one specific option, not to "any
        // value": 限速 fields follow 限速 (0), not 全速 (1).
        ? String(value) === "0"
        : !!value;
    for (const child of list) {
        const entry = controls.get(child.name);
        if (entry && typeof entry.setEnabled === "function") entry.setEnabled(on);
    }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** A `<label class="check"><input type=checkbox> …` used by the checkbox rows. */
function makeCheckbox(item) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!readValue(item);
    input.addEventListener("change", () => writeValue(item, !!input.checked));
    return {
        el: input,
        set(value) {
            input.checked = !!value;
        },
        setEnabled(on) {
            input.disabled = !on;
        },
    };
}

/** A row of exclusive radios. */
function makeRadio(item) {
    const group = document.createElement("div");
    group.className = "radio-group";
    let current = String(readValue(item));
    const inputs = [];

    for (const option of item.options || []) {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = "radio";
        input.name = item.name;
        input.value = option.value;
        input.checked = option.value === current;
        const text = document.createElement("span");
        text.textContent = option.label;
        input.addEventListener("change", () => {
            current = option.value;
            for (const other of inputs) other.checked = other.value === current;
            writeValue(item, current);
        });
        label.append(input, text);
        group.appendChild(label);
        inputs.push(input);
    }

    return {
        el: group,
        set(value) {
            current = String(value);
            for (const input of inputs) input.checked = input.value === current;
        },
        setEnabled(on) {
            for (const input of inputs) input.disabled = !on;
        },
    };
}

/** A dropdown. */
function makeSelect(item) {
    const select = document.createElement("select");
    for (const option of item.options || []) {
        const node = document.createElement("option");
        node.value = option.value;
        node.textContent = option.label;
        select.appendChild(node);
    }
    select.value = String(readValue(item));
    select.addEventListener("change", () => writeValue(item, select.value));
    return {
        el: select,
        set(value) {
            select.value = String(value);
        },
        setEnabled(on) {
            select.disabled = !on;
        },
    };
}

/** A text input, or a number input when `type` says so. */
function makeInput(item) {
    const input = document.createElement("input");
    input.type = item.type === "number" ? "number" : "text";
    if (item.min !== undefined) input.min = item.min;
    if (item.max !== undefined) input.max = item.max;
    input.value = readValue(item) === undefined ? "" : String(readValue(item));
    input.addEventListener("change", () => writeValue(item, input.value));
    return {
        el: input,
        set(value) {
            input.value = value === undefined ? "" : String(value);
        },
        setEnabled(on) {
            input.disabled = !on;
        },
    };
}

/** A multi-line input. */
function makeTextarea(item) {
    const area = document.createElement("textarea");
    area.value = String(readValue(item) || "");
    area.addEventListener("change", () => writeValue(item, area.value));
    return {
        el: area,
        set(value) {
            area.value = String(value || "");
        },
        setEnabled(on) {
            area.disabled = !on;
        },
    };
}

/**
 * A path field with a picker button.
 *
 * `directory` opens the folder picker, `file` the file picker; both are the
 * same `PickDirectory` server function with a different `kind`, which is how
 * the new-task dialog already asks for a path.
 */
function makePath(item) {
    const wrap = document.createElement("div");
    wrap.className = "item__control";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "path";
    input.value = String(readValue(item) || "");
    input.addEventListener("change", () => writeValue(item, input.value));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "mini";
    button.textContent = item.type === "file" ? "选择" : "浏览";
    button.addEventListener("click", async () => {
        const outcome = await callRaw("PickDirectory", item.type === "file" ? "file" : "dir");
        if (!outcome.ok) {
            setStatus(`选择路径失败：${outcome.error}`, "is-err");
            return;
        }
        // An empty answer is a cancelled dialog, not a cleared field.
        if (!outcome.value) return;
        input.value = outcome.value;
        writeValue(item, input.value);
    });

    wrap.append(input, button);
    return {
        el: wrap,
        set(value) {
            input.value = String(value || "");
        },
        setEnabled(on) {
            input.disabled = !on;
            button.disabled = !on;
        },
    };
}

/** A list held as an array and edited as a comma-separated string. */
function makeList(item) {
    const input = document.createElement("input");
    input.type = "text";
    const current = readValue(item);
    input.value = Array.isArray(current) ? current.join(",") : String(current || "");
    input.addEventListener("change", () => writeValue(item, input.value));
    return {
        el: input,
        set(value) {
            input.value = Array.isArray(value) ? value.join(",") : String(value || "");
        },
        setEnabled(on) {
            input.disabled = !on;
        },
    };
}

/** A non-editable note. */
function makeText(item) {
    const span = document.createElement("span");
    span.className = "hint";
    span.textContent = String(readValue(item) || "");
    return { el: span, set(value) { span.textContent = String(value || ""); } };
}

/** Build the control for one item, by its declared type. */
function buildControl(item) {
    switch (item.type) {
        case "checkbox":
            return makeCheckbox(item);
        case "radio":
            return makeRadio(item);
        case "select":
            return makeSelect(item);
        case "number":
        case "input":
            return makeInput(item);
        case "textarea":
            return makeTextarea(item);
        case "directory":
        case "file":
            return makePath(item);
        case "list":
            return makeList(item);
        case "text":
            return makeText(item);
        default:
            // An unknown type is shown as read-only text rather than dropped:
            // a setting that silently disappears is worse than one that is not
            // editable yet.
            return makeText(item);
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * One row: label on the left, control on the right, and the schema's
 * `hint`/`unit` beside it.
 */
function makeRow(item, options) {
    const opts = options || {};
    const row = document.createElement("div");
    row.className = "item";
    if (opts.child) row.classList.add("item--child");
    if (opts.disabled) row.classList.add("item--disabled");

    const label = document.createElement("label");
    label.className = "item__label";
    label.textContent = item.label || item.key;

    const control = buildControl(item);
    if (opts.disabled) control.setEnabled(false);

    const holder = document.createElement("div");
    holder.className = "item__control";
    holder.appendChild(control.el);
    if (item.unit) {
        const unit = document.createElement("span");
        unit.className = "unit";
        unit.textContent = item.unit;
        holder.appendChild(unit);
    }
    if (item.hint) {
        const hint = document.createElement("span");
        hint.className = "hint";
        hint.textContent = item.hint;
        holder.appendChild(hint);
    }

    row.append(label, holder);
    controls.set(item.name, control);
    controlByStorage.set(storageKey(item), control);
    return row;
}

/** Walk an item list, rendering rows and registering parent/child links. */
function renderItems(items, container, disabled) {
    for (const item of items || []) {
        if (item.hidden) continue;

        container.appendChild(makeRow(item, { disabled }));
        if (disabled) controls.get(item.name).setEnabled(false);

        if (item.children && item.children.length) {
            const kids = [];
            for (const child of item.children) {
                if (child.hidden) continue;
                container.appendChild(makeRow(child, { child: true, disabled }));
                if (disabled) controls.get(child.name).setEnabled(false);
                kids.push(child);
            }
            if (kids.length) dependents.set(item.name, kids);
            // The dependent rows start in the state the parent is already in.
            applyDependents(item, readValue(item));
        }
    }
}

/** Build the whole page from the schema. */
function render() {
    const nav = $("nav-list");
    const content = $("content");
    nav.textContent = "";
    content.textContent = "";
    controls.clear();
    dependents.clear();
    controlByStorage.clear();

    const buttons = [];
    schema.forEach((category, index) => {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "nav-item";
        button.textContent = category.label;
        button.addEventListener("click", () => selectCategory(index));
        li.appendChild(button);
        nav.appendChild(li);
        buttons.push(button);

        const block = document.createElement("section");
        block.className = "category";
        block.dataset.category = category.id;

        const title = document.createElement("h3");
        title.className = "category__title";
        title.textContent = category.label;
        block.appendChild(title);

        if (category.unsupported && category.unsupportedReason) {
            const note = document.createElement("p");
            note.className = "category__note";
            note.textContent = category.unsupportedReason;
            block.appendChild(note);
        }

        renderItems(category.items, block, !!category.unsupported);
        content.appendChild(block);
    });

    navButtons = buttons;
    if (buttons.length) selectCategory(0);
}

let navButtons = [];

/**
 * Highlight one navigation item and scroll its block into view.
 *
 * The original computes this from each block's offset while the user scrolls
 * (`handleScroll`, renderer.js:36839); here the navigation is the driver and
 * the scroll follows it, which is the same picture without a scroll handler
 * fighting the user's own scrolling.
 */
function selectCategory(index) {
    navButtons.forEach((button, i) => button.classList.toggle("is-active", i === index));
    const blocks = $("content").children;
    const block = blocks && blocks[index];
    const content = $("content");
    if (block && typeof block.offsetTop === "number" && content) {
        content.scrollTop = block.offsetTop;
    }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

async function load() {
    const schemaOutcome = await callRaw("GetSettingsSchema");
    if (!schemaOutcome.ok) {
        setStatus(`读取设置项失败：${schemaOutcome.error}`, "is-err");
        return;
    }
    schema = schemaOutcome.value || [];

    const valuesOutcome = await callRaw("GetConfigValue");
    if (!valuesOutcome.ok) {
        setStatus(`读取配置失败：${valuesOutcome.error}`, "is-err");
        return;
    }
    values = valuesOutcome.value || {};

    // Best effort: the user-scoped keys only differ once a session exists, and
    // a signed-out client still has to render the page.
    const userOutcome = await callRaw("GetUserID");
    userId = userOutcome.ok && userOutcome.value ? String(userOutcome.value) : "";

    render();
    setStatus("");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
    $("save").addEventListener("click", async () => {
        const outcome = await callRaw("SaveConfig");
        if (!outcome.ok) {
            setStatus(`保存失败：${outcome.error}`, "is-err");
            return;
        }
        setStatus("已保存到配置文件", "is-ok");
    });

    // A change made anywhere else -- another window, a plugin -- arrives here.
    // Only the affected control is redrawn; rebuilding the page would throw
    // away the position the user is at.
    if (typeof bridge.onNativeEvent === "function") {
        bridge.onNativeEvent(({ name, payload }) => {
            if (name !== "OnConfigValueChanaged") return;
            const data = payload || {};
            const key = `${data.section}.${data.key}`;
            values[key] = data.value;
            // The stored key, not the schema name: a user-scoped setting
            // arrives as `radio_id_<userid>`, which is exactly the key
            // `controlByStorage` was built with.
            const entry = controlByStorage.get(key);
            if (entry) entry.set(data.value);
        });
    }

    load();
}

init();
