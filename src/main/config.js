/**
 * Config store -- the settings file and its write policy.
 *
 * Faithful to the original's `Config` module (`main-renderer/renderer.js:1222-1387`),
 * whose four observable behaviours are reproduced here one for one:
 *
 *   1. JSON on disk, 2-space indent, at `profiles/config.json`
 *      (`SettingInit.initConf`: `ConfigNS.init(join(__profilesDir,"config.json"))`,
 *      renderer.js:42783).
 *   2. A `.bak` beside it, written before the main file is replaced, and read
 *      back when the main file cannot be parsed (renderer.js:1312-1326).
 *   3. A five-second write delay: `setInterval(..., 5000)` fires `save()` only
 *      when a value actually changed (renderer.js:1252-1254). A control that
 *      must land immediately sets `immediatelySave`, which calls `saveSync()`
 *      (renderer.js:74538) -- that is the `saveSync`/`flush` pair below.
 *   4. `setValue` fires a change event **only when the value differs**
 *      (renderer.js:1258-1300). That single rule is what keeps the engine from
 *      being reconfigured on every keystroke, so it is not an optimisation.
 *
 * Two deliberate departures from the original:
 *
 *   - It never writes the registry. Only "开机启动" does in the original
 *     (`handleAutoRun`, renderer.js:72716), and that is `app.setLoginItemSettings`
 *     territory, not this file's.
 *   - The path is injected. The original resolves `__profilesDir` from its own
 *     install layout; a packaged Electron app must use `app.getPath("userData")`,
 *     and the test suite must be able to point at a temp directory. `path: null`
 *     makes the store memory-only, which is what a unit test wants and what a
 *     headless boot without Electron falls back to.
 *
 * This file holds no `electron`, so it loads under plain node.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const { defaultValues } = require("../renderer/settings-schema");

/** The original's poll interval, in milliseconds. */
const DEFAULT_WRITE_DELAY_MS = 5000;

/**
 * Split a flat `"section.key"` default back into its two halves.
 *
 * The schema's flat form joins with a dot (it is derived from the two
 * arguments of `getValue`, not from the schema's hyphen-joined `name`), so the
 * split here is on the first dot. Using the schema's `splitName` instead would
 * look for a hyphen, find none, and drop every default -- which is exactly the
 * bug this comment exists to prevent.
 */
function splitFlat(flat) {
    const at = String(flat).indexOf(".");
    if (at < 0) return { section: flat, key: "" };
    return { section: String(flat).slice(0, at), key: String(flat).slice(at + 1) };
}

/** Deep-ish equality, enough for the scalars and string arrays the schema holds. */
function sameValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
    }
    // A stored "5" and an incoming 5 are the same setting: the original's
    // formData defaults are mostly strings and its inputs hand back strings.
    if (a !== null && b !== null && typeof a !== "object" && typeof b !== "object") {
        return String(a) === String(b);
    }
    return false;
}

class ConfigStore {
    /**
     * @param {object} [options]
     * @param {string|null} [options.path]     config.json path; null = memory only
     * @param {object} [options.schema]        the settings schema (for defaults)
     * @param {number} [options.writeDelayMs]  write delay; default 5000
     * @param {function} [options.log]
     * @param {object} [options.fs]            injectable fs (tests)
     */
    constructor(options) {
        const opts = options || {};
        this.path = opts.path || null;
        this.schema = opts.schema || null;
        this.writeDelayMs = opts.writeDelayMs === undefined
            ? DEFAULT_WRITE_DELAY_MS
            : opts.writeDelayMs;
        this.log = opts.log || (() => {});
        this.fs = opts.fs || fs;

        /** section -> key -> value */
        this.data = {};
        /** "section.key" -> default, taken from the schema */
        this.defaults = this.schema ? defaultValues(this.schema) : {};
        /** True while a change is waiting to be written. */
        this.changed = false;

        this._listeners = [];
        this._timer = null;
        this._loaded = false;

        this.load();
    }

    // -----------------------------------------------------------------------
    // Load / merge
    // -----------------------------------------------------------------------

    /**
     * Read the file, falling back to the backup, then fill every gap with the
     * schema default.
     *
     * The order matters and is the original's: a corrupt main file must not
     * throw away the backup, so the backup is only consulted when the main one
     * is unreadable -- not when it is merely missing keys.
     */
    load() {
        let raw = null;
        let source = "";

        if (this.path) {
            raw = this._readJson(this.path);
            source = raw ? "config.json" : "";
            if (!raw) {
                raw = this._readJson(`${this.path}.bak`);
                if (raw) source = "config.json.bak";
            }
        }

        this.data = this.mergeConfigData(raw || {});
        this._loaded = true;
        if (this.path && source) this.log("config loaded from", source);
        return this.data;
    }

    /** Parse a JSON file, or null if it is missing or malformed. */
    _readJson(file) {
        try {
            const text = this.fs.readFileSync(file, "utf8");
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch (err) {
            return null;
        }
    }

    /**
     * Overlay the stored file on top of the schema defaults.
     *
     * Only the sections and keys the schema knows are guaranteed to exist; any
     * extra key already in the file is preserved, because a build that drops a
     * setting must not silently delete a user's value for it.
     */
    mergeConfigData(raw) {
        const out = {};

        for (const flat of Object.keys(this.defaults)) {
            const { section, key } = splitFlat(flat);
            if (!section || !key) continue;
            out[section] = out[section] || {};
            out[section][key] = this.defaults[flat];
        }

        for (const section of Object.keys(raw || {})) {
            const value = raw[section];
            if (!value || typeof value !== "object" || Array.isArray(value)) continue;
            out[section] = Object.assign({}, out[section] || {}, value);
        }

        return out;
    }

    // -----------------------------------------------------------------------
    // Read / write values
    // -----------------------------------------------------------------------

    /**
     * Read one value.
     *
     * A stored `false`/`0`/`""` is returned as itself, never replaced by the
     * fallback: `getValue` is asked "what is set", and "unset" is the only case
     * that falls through. That distinction is why `hasOwnProperty` is used
     * rather than a truthiness test.
     */
    getValue(section, key, fallback) {
        const bucket = this.data[section];
        if (bucket && Object.prototype.hasOwnProperty.call(bucket, key)) {
            return bucket[key];
        }
        const flat = `${section}.${key}`;
        if (Object.prototype.hasOwnProperty.call(this.defaults, flat)) {
            return this.defaults[flat];
        }
        return fallback;
    }

    /**
     * Write one value, and tell the listeners only if it changed.
     *
     * @returns {boolean} whether anything changed
     */
    setValue(section, key, value) {
        if (!section || !key) return false;
        const bucket = this.data[section] || (this.data[section] = {});
        const existing = Object.prototype.hasOwnProperty.call(bucket, key)
            ? bucket[key]
            : undefined;
        if (existing !== undefined && sameValue(existing, value)) return false;

        bucket[key] = value;
        this.changed = true;
        this._scheduleSave();
        this._emitChange(section, key, value);
        return true;
    }

    /** Every value, as a flat `"section.key": value` map (tests, diagnostics). */
    flat() {
        const out = {};
        for (const section of Object.keys(this.data)) {
            const bucket = this.data[section];
            if (!bucket || typeof bucket !== "object") continue;
            for (const key of Object.keys(bucket)) out[`${section}.${key}`] = bucket[key];
        }
        return out;
    }

    /** The raw nested object. A shallow copy, so a caller cannot mutate us. */
    getAll() {
        const out = {};
        for (const section of Object.keys(this.data)) {
            out[section] = Object.assign({}, this.data[section]);
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Listeners
    // -----------------------------------------------------------------------

    /**
     * Subscribe to value changes. Returns the remover.
     *
     * The callback is `(section, key, value)`, which is exactly what
     * `ConfigHandler` needs to translate one change into one engine action.
     */
    attachListener(callback) {
        if (typeof callback !== "function") return () => {};
        this._listeners.push(callback);
        return () => {
            const at = this._listeners.indexOf(callback);
            if (at >= 0) this._listeners.splice(at, 1);
        };
    }

    _emitChange(section, key, value) {
        for (const callback of this._listeners.slice()) {
            try {
                callback(section, key, value);
            } catch (err) {
                // A listener that throws must not stop the value from being
                // stored -- the file is the source of truth, the listeners are
                // downstream effects.
                this.log("config listener failed:", err.message);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    /**
     * Start the write timer if it is not already running.
     *
     * Started on the first change and left alone until it fires, which is the
     * original's shape (a fixed 5000 ms poll that checks `changed`) rather than
     * a timer reset on every keystroke -- a form typed into continuously would
     * otherwise never reach disk.
     */
    _scheduleSave() {
        if (!this.path || this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.save();
        }, this.writeDelayMs);
        // The timer must not be the reason the process stays alive.
        if (this._timer && typeof this._timer.unref === "function") this._timer.unref();
    }

    /** Write now, if anything changed. @returns {boolean} whether it wrote. */
    save() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (!this.path) {
            // Memory-only: nothing to write, but the change is no longer
            // pending, so a later flush does not re-report it.
            this.changed = false;
            return false;
        }
        if (!this.changed) return false;

        try {
            this.fs.mkdirSync(path.dirname(this.path), { recursive: true });
            // Backup before the replace, so .bak always holds the last file
            // that was known good. Copying after the write would make the two
            // files identical and the fallback useless.
            if (this.fs.existsSync(this.path)) {
                try {
                    this.fs.copyFileSync(this.path, `${this.path}.bak`);
                } catch (err) {
                    this.log("config backup failed:", err.message);
                }
            }
            this.fs.writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
            this.changed = false;
            return true;
        } catch (err) {
            // Leave `changed` set: the next tick retries rather than losing the
            // edit. A full disk is transient; a dropped setting is not.
            this.log("config save failed:", err.message);
            return false;
        }
    }

    /**
     * The original's `saveSync`, for controls marked `immediatelySave`
     * (renderer.js:74538). Same work as `save`; the name is kept because the
     * two spellings mean the same thing in the original and a reader looking
     * for one should find it.
     */
    saveSync() {
        return this.save();
    }

    /** Force a pending write out now (shutdown, and tests). */
    flush() {
        return this.save();
    }

    /** Stop the timer without writing. */
    dispose() {
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        this._listeners.length = 0;
    }
}

module.exports = {
    ConfigStore,
    DEFAULT_WRITE_DELAY_MS,
    sameValue,
    splitFlat,
};
