/**
 * The floating ball and its panel.
 *
 * The original is one Electron window plus a native behaviour addon plus a
 * second window for the panel, and this keeps that split. Two facts from the
 * recovered build shape everything below:
 *
 *   1. The window is 400x262 and transparent, created in
 *      `SuspensionWindowHelper.createSuspensionWindow` (out/main.js:5987):
 *      `frame: false, width: 400, height: 262, alwaysOnTop: true,
 *      backgroundColor: "#0000"`. The size is not a guess -- the panel's own
 *      stylesheet draws a `.xly-suspension-list` of exactly 400x262, so the
 *      window and the panel are the same box.
 *
 *   2. The ball itself is DOM, not GDI+. `.xly-suspension-polygon` is a 52x56
 *      hexagon drawn with `clip-path: polygon(51% 0,100% 28%,100% 76%,50% 100%,
 *      1% 75%,0 28%)`, and `.xly-suspension-area` is its 56x74 hit rectangle
 *      (out/suspension-renderer/renderer.css). NINE of the ten CSS keyframes
 *      live in that same file, so the animation is CSS too.
 *
 * There is a second window: `FloatPanelHelper.getFloatPanelWindow()` is shown
 * with `showInactive()` and positioned by `setFloatPanelDirection`, which maps
 * a four-value enum to an offset (out/suspension-renderer/renderer.js). Both
 * windows are opened through the shared registry so neither can be left out of
 * event delivery or of the safety settings `openWindow` applies.
 *
 * This file holds no `electron`. The window is created through the registry,
 * and the display queries, the main-window controls and the position store are
 * all injected, so the parts that are pure -- the clamp, the panel direction,
 * the state aggregation -- can be exercised by the test suite without a GUI.
 * `electron-main.js` is the only place that knows about screens and menus.
 *
 * The 33 members of the original's `ThunderSuspensionWindow` are mapped onto
 * methods here (UI_SPEC_2 section 1.2 lists them one by one). The callback
 * setters fill `this.callbacks`, and the renderer reaches them over the
 * `suspension-action` channel rather than through the RPC mesh, because the
 * actions are window gestures -- hover, drag, click -- not service calls.
 */

"use strict";

const path = require("path");

const { NATIVE_EVENTS } = require("./contract");

/** Window names in the shared registry. */
const WINDOW_NAME = "suspension";
const PANEL_WINDOW = "suspension-panel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The eight sizes the original names (out/main.js:6083).
 *
 * They are exported rather than inlined because the renderer stylesheet has to
 * agree with them, and a stylesheet cannot import a module. The numbers here
 * are the reference; the CSS copies them.
 */
const SIZES = Object.freeze({
    autoHideAtX: 380,
    autoHideAtY: 226,
    ballSize: 52,
    ballTop: 10,
    weltSize: 12,
    weltTopSize: 62,
    speedWidth: 72,
    floatHeight: 262,
});

/**
 * Two more numbers the clamp needs, neither of which is in that table.
 *
 * 56x74 is `.xly-suspension-area`, the ball's hit rectangle, and 74 is what the
 * original's own clamp adds to `autoHideAtY` (out/main.js:302219). 84 is the
 * other literal in the same expression. Taking them from the stylesheet rather
 * than retyping keeps the two halves of the clamp from drifting.
 */
const HIT_WIDTH = 56;
const HIT_HEIGHT = 74;
const EDGE_MARGIN = 84;

/**
 * Window options for both the ball and the panel.
 *
 * `autoShow: false` for both: the ball is positioned before it is shown, or it
 * flashes at the default corner first, and the panel is only shown on hover.
 * `backgroundColor: "#00000000"` is the transparent clear colour the original
 * passes as `"#0000"`.
 */
const WINDOW_OPTIONS = Object.freeze({
    width: 400,
    height: SIZES.floatHeight,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoShow: false,
    backgroundColor: "#00000000",
});

/**
 * Which corner of the ball the panel is placed against.
 *
 * The values are the original's (`e[e.LeftBottom=0]...`, out/suspension-
 * renderer/renderer.js), and the offset each one produces is copied from
 * `setFloatPanelDirection` below.
 */
const FloatPanelDirection = Object.freeze({
    LeftBottom: 0,
    LeftTop: 1,
    RightTop: 2,
    RightBottom: 3,
});

/** The original's two skins: `e[e.Default=0]="Default", e[e.Vip=1]="Vip"`. */
const SkinType = Object.freeze({
    Default: 0,
    Vip: 1,
});

/** Kernel task states, as the kernel defines them. */
const TASK_STATUS = Object.freeze({
    QUEUED: 0,
    DOWNLOADING: 1,
    PAUSED: 2,
    COMPLETED: 3,
    FAILED: 4,
});

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/**
 * Keep the ball inside the work area.
 *
 * This is the original's `verify suspension pos` (out/main.js:302219) with its
 * constants substituted. It is a translation, not a re-derivation, because the
 * asymmetry is deliberate: the horizontal test measures against
 * `autoHideAtX` (380) while the horizontal correction also subtracts the 84px
 * margin, and the vertical test and correction both use `autoHideAtY` (226) --
 * except the correction adds the 74px hit height instead of a symmetric 226.
 * "Fixing" it into something tidier would move the ball to a different corner
 * than the original picks.
 *
 * @param {{x:number, y:number}} pos        desired top-left, in DIP
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @returns {{x:number, y:number}}
 */
function clampToWorkArea(pos, workArea) {
    const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
    const result = { x: Math.round(pos.x), y: Math.round(pos.y) };

    if (pos.x + SIZES.autoHideAtX < area.x) {
        result.x = area.x - SIZES.autoHideAtX;
    } else if (pos.x + SIZES.autoHideAtX + EDGE_MARGIN > area.x + area.width) {
        result.x = area.x + area.width - EDGE_MARGIN - SIZES.autoHideAtX;
    }

    if (pos.y + SIZES.autoHideAtY < area.y) {
        result.y = area.y - SIZES.autoHideAtY;
    } else if (pos.y + SIZES.autoHideAtY + HIT_HEIGHT > area.y + area.height) {
        result.y = area.y + area.height - SIZES.autoHideAtY - HIT_HEIGHT;
    }

    return result;
}

/**
 * The offset from the ball's anchor to the panel's top-left, per direction.
 *
 * Straight from `setFloatPanelDirection` (out/suspension-renderer/renderer.js,
 * quoted in UI_SPEC_2 section 1.1b). The zero cases are kept explicit rather
 * than folded away so the four branches line up with the four enum values when
 * someone compares the two side by side.
 *
 * @param {number} direction  a FloatPanelDirection value
 * @param {{width:number, height:number}} size  the panel's size
 * @returns {{x:number, y:number}}
 */
function setFloatPanelDirection(direction, size) {
    const width = (size && size.width) || WINDOW_OPTIONS.width;
    const height = (size && size.height) || WINDOW_OPTIONS.height;
    const offset = { x: 0, y: 0 };

    switch (direction) {
        case FloatPanelDirection.LeftBottom:
            offset.x -= width;
            break;
        case FloatPanelDirection.LeftTop:
            offset.x -= width;
            offset.y -= height;
            break;
        case FloatPanelDirection.RightTop:
            offset.y -= height;
            break;
        case FloatPanelDirection.RightBottom:
        default:
            break;
    }

    return offset;
}

/**
 * Pick the direction from where the ball sits in the work area.
 *
 * The four directions are really "which way is there room": a ball on the left
 * half opens its panel to the right, one on the bottom half opens it upwards.
 * The name says where the panel goes, not where the ball is, which is why the
 * left-hand cases subtract the width.
 *
 * The point tested is the ball's own centre, not the window's: the ball sits at
 * the window's top-left corner and the window is 400px wide, so a window
 * centre would say "middle of the screen" for a ball in the corner.
 *
 * @param {{x:number,y:number,width:number,height:number}} ballBounds
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @returns {number}
 */
function chooseDirection(ballBounds, workArea) {
    const area = workArea || { x: 0, y: 0, width: 1920, height: 1080 };
    const centre = ballAnchor(ballBounds);

    const roomOnRight = centre.x < area.x + area.width / 2;
    const roomBelow = centre.y < area.y + area.height / 2;

    if (roomOnRight && roomBelow) return FloatPanelDirection.RightBottom;
    if (roomOnRight && !roomBelow) return FloatPanelDirection.RightTop;
    if (!roomOnRight && roomBelow) return FloatPanelDirection.LeftBottom;
    return FloatPanelDirection.LeftTop;
}

/** The panel's top-left for a direction, given the anchor it hangs from. */
function panelPosition(anchor, size, direction) {
    const offset = setFloatPanelDirection(direction, size);
    return { x: Math.round(anchor.x + offset.x), y: Math.round(anchor.y + offset.y) };
}

/**
 * Where the panel hangs from, in screen coordinates.
 *
 * The anchor is the ball's centre, not the window's corner: the ball window is
 * 400x262 and the ball is a 52x56 hexagon at `top: 10px; left: 0`, so the
 * window's corner is up to 200px away from the thing the panel should touch.
 */
function ballAnchor(ballBounds) {
    const ball = ballBounds || { x: 0, y: 0 };
    return {
        x: ball.x + SIZES.ballSize / 2,
        y: ball.y + SIZES.ballTop + SIZES.ballSize / 2,
    };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class SuspensionService {
    /**
     * @param {object} options
     * @param {object} options.windowManager            the shared registry
     * @param {function} [options.getDisplayForPoint]   (x, y) -> { workArea, scaleFactor }
     * @param {function} [options.getPrimaryWorkArea]   -> { x, y, width, height }
     * @param {function} [options.getMainWindowStates]  -> { minimized, visible, maximized, focused }
     * @param {function} [options.bringMainToTop]
     * @param {function} [options.hideMainWindow]
     * @param {function} [options.pauseAllTasks]
     * @param {function} [options.resumeAllTasks]
     * @param {function} [options.persistPosition]      (pos) -> void
     * @param {function} [options.loadPosition]         -> { x, y }
     * @param {function} [options.getVipInfo]           -> { isVip, vipType, ... }
     * @param {function} [options.log]
     * @param {string}   [options.page]                 the ball page
     * @param {string}   [options.panelPage]            the panel page
     */
    constructor(options) {
        const opts = options || {};
        this.windowManager = opts.windowManager;
        this.getDisplayForPoint =
            opts.getDisplayForPoint || (() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }));
        this.getPrimaryWorkArea =
            opts.getPrimaryWorkArea || (() => ({ x: 0, y: 0, width: 1920, height: 1080 }));
        this.getMainWindowStates =
            opts.getMainWindowStates ||
            (() => ({ minimized: false, visible: false, maximized: false, focused: false }));
        this.bringMainToTop = opts.bringMainToTop || (() => {});
        this.hideMainWindow = opts.hideMainWindow || (() => {});
        this.pauseAllTasks = opts.pauseAllTasks || (() => {});
        this.resumeAllTasks = opts.resumeAllTasks || (() => {});
        this.persistPosition = opts.persistPosition || (() => {});
        this.loadPosition = opts.loadPosition || (() => ({ x: null, y: null }));
        this.getVipInfo = opts.getVipInfo || (() => ({ isVip: false }));
        this.log = opts.log || (() => {});
        this.page = opts.page || path.join(__dirname, "..", "windows", "suspension", "index.html");
        this.panelPage =
            opts.panelPage || path.join(__dirname, "..", "windows", "suspension", "panel.html");

        /** The renderer's callbacks, keyed by the original's setter names. */
        this.callbacks = new Map();
        /** taskId -> last known kernel fields, merged rather than replaced. */
        this.tasks = new Map();
        /** The ball's position, once it has one. */
        this.position = { x: null, y: null };
        this.visible = false;
        this.panelVisible = false;
        this.skin = SkinType.Default;
        this.dpiFactor = 1;
        this.isVip = false;
        this.statusText = "";
        this._hidePanelTimer = null;
        /** The drag in progress, or null: { x, y } of the last requested spot. */
        this._drag = null;
    }

    // -----------------------------------------------------------------------
    // Window lifecycle -- members 1-3
    // -----------------------------------------------------------------------

    /**
     * Create the ball window and place it.
     *
     * Called once at boot. The window is created hidden, moved off-screen and
     * told to pass mouse events through before its page is loaded, so that the
     * 400x262 rectangle does not swallow clicks on the desktop for the moment
     * between creation and the first paint.
     *
     * @param {object} [initial] `{ x, y }` from the config file, either of
     *                           which may be null for "no saved position".
     */
    startSuspensionWindow(initial) {
        const config = initial || {};
        if (Number.isFinite(config.x) && Number.isFinite(config.y)) {
            this.position = { x: config.x, y: config.y };
        }

        const win = this.windowManager.openWindow(WINDOW_NAME, WINDOW_OPTIONS);
        if (win.__suspensionStarted) return win;
        win.__suspensionStarted = true;

        // Off-screen first: a transparent window shown before its page paints
        // appears as a solid rectangle for one frame at the default corner.
        win.setPosition(-999, -999);
        // "screen-saver" rather than plain alwaysOnTop: the normal level sits
        // under the taskbar, and the whole point of the ball is that it is
        // above it. The clamp keeps it inside `workArea`, so it does not fight
        // the start menu.
        win.setAlwaysOnTop(true, "screen-saver");
        this._setBallClickable(false);

        win.loadFile(this.page);
        win.once("ready-to-show", () => this._placeAtStartup());
        win.on("closed", () => {
            this.visible = false;
            this.panelVisible = false;
        });

        return win;
    }

    /** Show the ball without taking focus (member 1). */
    showSuspensionWindow() {
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (!win) return false;
        win.showInactive();
        this.visible = true;
        this._pushState();
        return true;
    }

    /** Hide the ball, and the panel with it (member 2). */
    hideSuspensionWindow() {
        this.hideFloatPanel();
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (win) win.hide();
        this.visible = false;
        return true;
    }

    /** Place the ball for the first time: saved spot, or the bottom-right. */
    _placeAtStartup() {
        const workArea = this.getPrimaryWorkArea();
        let target = this.position;

        if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
            const saved = this.loadPosition() || {};
            if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
                target = { x: saved.x, y: saved.y };
            } else {
                // Bottom-right, the corner the original ships the ball in: the
                // clamp's own arithmetic is what puts it there.
                target = {
                    x: workArea.x + workArea.width - SIZES.autoHideAtX - EDGE_MARGIN,
                    y: workArea.y + workArea.height - SIZES.autoHideAtY - HIT_HEIGHT,
                };
            }
        }

        this.position = clampToWorkArea(target, workArea);
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (win) {
            win.setPosition(this.position.x, this.position.y);
            win.showInactive();
        }
        this.visible = true;
        this.updateSuspensionState();
    }

    // -----------------------------------------------------------------------
    // Position -- members 13-15
    // -----------------------------------------------------------------------

    /**
     * Move the ball, clamping to the work area it lands on.
     *
     * `silent` is the original's third argument: a drag passes `false` so the
     * spot is remembered, and a programmatic move passes `true` so a temporary
     * position is not persisted.
     */
    setSuspensionWindowPos(x, y, silent) {
        const display = this.getDisplayForPoint(x, y);
        const pos = clampToWorkArea({ x: Number(x) || 0, y: Number(y) || 0 }, display.workArea);
        this.position = pos;

        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (win) win.setPosition(pos.x, pos.y);
        if (!silent) this.persistPosition(pos);
        return pos;
    }

    /** The monitor's scale factor for the ball's current position (member 14). */
    setDpiFactor(factor) {
        if (Number.isFinite(factor) && factor > 0) {
            this.dpiFactor = factor;
        } else {
            const at = this.position.x === null ? { x: 0, y: 0 } : this.position;
            this.dpiFactor = this.getDisplayForPoint(at.x, at.y).scaleFactor || 1;
        }
        this._pushState();
        return this.dpiFactor;
    }

    /**
     * The native window handle (member 15).
     *
     * The original passes this to `GetWindowRect` so its native addon can read
     * the window's rectangle. Nothing here consumes it yet, but the getter is
     * the seam that call would use, so it exists rather than throwing.
     */
    getHandle() {
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (!win || typeof win.getNativeWindowHandle !== "function") return null;
        return win.getNativeWindowHandle();
    }

    /** `{ x, y, show }` for `GetSuspensionConfig`. */
    getSuspensionConfig() {
        return { x: this.position.x, y: this.position.y, show: this.visible };
    }

    // -----------------------------------------------------------------------
    // The float panel
    // -----------------------------------------------------------------------

    /**
     * Show the panel beside the ball, without taking focus.
     *
     * `showInactive()` and not `show()` is the load-bearing call: the panel
     * exists to be read while the user is still working in another window, and
     * a panel that steals focus closes whatever menu the user had open.
     */
    showFloatPanel() {
        const panel = this.windowManager.openWindow(PANEL_WINDOW, WINDOW_OPTIONS);
        if (!panel.__panelLoaded) {
            panel.__panelLoaded = true;
            panel.setAlwaysOnTop(true, "screen-saver");
            panel.loadFile(this.panelPage);
        }

        const ball = this.windowManager.getWindow(WINDOW_NAME);
        const bounds = ball ? ball.getBounds() : { x: 0, y: 0, width: WINDOW_OPTIONS.width, height: WINDOW_OPTIONS.height };
        const display = this.getDisplayForPoint(bounds.x, bounds.y);
        const direction = chooseDirection(bounds, display.workArea);
        const anchor = ballAnchor(bounds);
        const wanted = panelPosition(anchor, { width: WINDOW_OPTIONS.width, height: WINDOW_OPTIONS.height }, direction);
        const pos = clampToWorkArea(wanted, display.workArea);

        panel.setPosition(pos.x, pos.y);
        panel.showInactive();
        this.panelVisible = true;
        return true;
    }

    /** Hide the panel (member 23's other half). */
    hideFloatPanel() {
        this._cancelHidePanel();
        const panel = this.windowManager.getWindow(PANEL_WINDOW);
        if (panel) panel.hide();
        this.panelVisible = false;
        return true;
    }

    /**
     * Hide the panel unless the pointer reaches it first.
     *
     * The ball and the panel are separate windows, so moving from one to the
     * other fires "leave" on the ball before it fires "enter" on the panel. A
     * delay is the only way to tell "moved to the panel" from "moved away":
     * without it the panel vanishes under the cursor that is trying to click
     * it.
     */
    _scheduleHidePanel() {
        this._cancelHidePanel();
        this._hidePanelTimer = setTimeout(() => {
            this._hidePanelTimer = null;
            this.hideFloatPanel();
        }, 250);
        if (this._hidePanelTimer.unref) this._hidePanelTimer.unref();
    }

    _cancelHidePanel() {
        if (this._hidePanelTimer) {
            clearTimeout(this._hidePanelTimer);
            this._hidePanelTimer = null;
        }
    }

    /**
     * Turn mouse pass-through on or off for the ball window.
     *
     * `transparent: true` does not make the transparent part click-through --
     * the whole 400x262 rectangle eats mouse events, which would hide the
     * desktop icons behind it. `setIgnoreMouseEvents(true, { forward: true })`
     * is the fix, and `forward: true` is what keeps `mousemove` reaching the
     * page so it can tell the main process when the pointer is over the ball.
     */
    _setBallClickable(on) {
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (win && typeof win.setIgnoreMouseEvents === "function") {
            win.setIgnoreMouseEvents(!on, { forward: true });
        }
    }

    // -----------------------------------------------------------------------
    // Callbacks -- members 16-26
    // -----------------------------------------------------------------------

    /** Register a renderer callback under one of the original's setter names. */
    _setCallback(name) {
        return (fn) => {
            this.callbacks.set(name, fn);
        };
    }

    _invoke(name, ...args) {
        const fn = this.callbacks.get(name);
        if (typeof fn !== "function") return;
        try {
            fn(...args);
        } catch (err) {
            this.log(`callback ${name} failed:`, (err && err.message) || err);
        }
    }

    setCreateCallback(fn) {
        this._setCallback("onCreate")(fn);
    }

    setRightClickDownCallback(fn) {
        this._setCallback("onRightClickDown")(fn);
    }

    setRightClickUpCallback(fn) {
        this._setCallback("onRightClickUp")(fn);
    }

    setLeftClickDownCallback(fn) {
        this._setCallback("onLeftClickDown")(fn);
    }

    setLeftClickUpCallback(fn) {
        this._setCallback("onLeftClickUp")(fn);
    }

    setLeftDBClickCallback(fn) {
        this._setCallback("onLeftDBClick")(fn);
    }

    setHoverCallback(fn) {
        this._setCallback("onHover")(fn);
    }

    setLeaveCallback(fn) {
        this._setCallback("onLeave")(fn);
    }

    setMoveCallback(fn) {
        this._setCallback("onMove")(fn);
    }

    setTrialTextShowCallback(fn) {
        this._setCallback("onTrialTextShow")(fn);
    }

    setTrialHoverAniShowCallback(fn) {
        this._setCallback("onTrialHoverAniShow")(fn);
    }

    // -----------------------------------------------------------------------
    // Actions from the renderer
    // -----------------------------------------------------------------------

    /**
     * Dispatch one `suspension-action` payload.
     *
     * The payload is `{ type, ... }` and the set of types is the gesture list
     * from UI_SPEC_2 section 1.4, plus the panel's own buttons. An unknown type
     * is logged rather than ignored, because a typo on either side of this
     * channel would otherwise look exactly like a ball that does nothing.
     */
    handleAction(action) {
        const a = action || {};
        switch (a.type) {
            case "leftClickDown":
                this._invoke("onLeftClickDown");
                // The original's `setLeftClickDownCallback` is
                // `showOrHideFloatPanel(false)`: pressing the ball puts the
                // panel away, because the click that follows is about the main
                // window.
                this.hideFloatPanel();
                break;
            case "leftClick":
                this._invoke("onLeftClickUp");
                this.showOrHideMainWindow();
                break;
            case "leftDBClick":
                this._invoke("onLeftDBClick");
                this.bringMainToTop();
                break;
            case "rightClickDown":
                this._invoke("onRightClickDown");
                break;
            case "rightClick":
                this._invoke("onRightClickUp");
                break;
            case "hover":
                this._setBallClickable(true);
                this._invoke("onHover");
                this.showFloatPanel();
                break;
            case "leave":
                this._setBallClickable(false);
                this._invoke("onLeave");
                this._scheduleHidePanel();
                break;
            case "move":
                this._invoke("onMove");
                this.hideFloatPanel();
                break;
            case "panelEnter":
                this._cancelHidePanel();
                break;
            case "panelLeave":
                this._scheduleHidePanel();
                break;
            case "drag":
                this._dragTo(a.x, a.y);
                break;
            case "dragEnd":
                this._endDrag(a.x, a.y);
                break;
            case "openTask":
                this.bringMainToTop();
                break;
            case "pauseAll":
                this.pauseAllTasks();
                break;
            case "resumeAll":
                this.resumeAllTasks();
                break;
            case "quit":
                this._invoke("onQuit");
                break;
            case "bubbleBtn":
                this._invoke("onBubbleBtn", a.index);
                break;
            default:
                this.log("unknown suspension action:", a.type);
        }
    }

    /** A drag in progress: move the window, but do not persist yet. */
    _dragTo(x, y) {
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return;
        this._drag = { x, y };
        // Unclamped while the pointer is down: clamping mid-drag makes the ball
        // stick to the edge and then jump when the pointer comes back.
        win.setPosition(Math.round(x), Math.round(y));
        this.hideFloatPanel();
    }

    /** The pointer went up: clamp, persist, and remember where it landed. */
    _endDrag(x, y) {
        const last = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : this._drag;
        this._drag = null;
        if (!last) return;
        this.setSuspensionWindowPos(last.x, last.y, false);
        this._invoke("onDragEnd", this.position);
    }

    /**
     * The ball's primary action: raise the main window, or put it away.
     *
     * The three branches are the original's `showOrHideMainWindow`
     * (out/suspension-renderer/renderer.js, quoted in UI_SPEC_2 section 1.1e):
     * a minimised window comes back, a window that is already up and in front
     * goes away, and anything else comes forward. Without the middle branch the
     * ball could only ever show the window, never dismiss it.
     */
    showOrHideMainWindow() {
        const states = this.getMainWindowStates();
        if (states.minimized) {
            this.bringMainToTop();
            return "restore";
        }
        if (states.visible && states.focused) {
            this.hideMainWindow();
            return "hide";
        }
        this.bringMainToTop();
        return "show";
    }

    // -----------------------------------------------------------------------
    // State aggregation -- members 9-12, 4-8
    // -----------------------------------------------------------------------

    /**
     * Merge one kernel event into the task table.
     *
     * Merged, not replaced, for the same reason the main renderer merges: a
     * detail event carries no name and a status event carries no size, so a
     * replace would drop the file name the moment progress arrived.
     */
    onKernelEvent(name, payload) {
        if (!payload || payload.taskId === undefined) return;
        if (name === "OnTaskRemoved") {
            this.tasks.delete(payload.taskId);
        } else {
            const current = this.tasks.get(payload.taskId) || { taskId: payload.taskId };
            this.tasks.set(payload.taskId, Object.assign(current, payload));
        }
        this.updateSuspensionState();
    }

    /** `updateDownloadState(!1)` -- the original passes a boolean (member 9). */
    updateDownloadState(isDowning) {
        if (typeof isDowning === "boolean") this.forceDowning = isDowning;
        return this.updateSuspensionState();
    }

    /** `setIsVipUser` (member 12). */
    setIsVipUser(isVip) {
        this.isVip = !!isVip;
        this.skin = this.isVip ? SkinType.Vip : SkinType.Default;
        return this.updateSuspensionState();
    }

    /** `updateTrialState` (member 11): carried through, not acted on. */
    updateTrialState(trial) {
        this.trial = trial || null;
        return this._pushState();
    }

    /** `setSuspensionWindowPos`'s silent sibling: a status line for the ball. */
    showConnectingTextWindow(text) {
        this.statusText = String(text || "");
        return this._pushState();
    }

    /** `showDownloadWindow` (member 4): the ball's downloading face. */
    showDownloadWindow() {
        return this._sendToBall({ type: "mode", mode: "down" });
    }

    /** `showNormalWindow` (member 5): the ball's idle or signed-out face. */
    showNormalWindow() {
        return this._sendToBall({ type: "mode", mode: "normal" });
    }

    /** `showVipWindow` (member 6). */
    showVipWindow() {
        return this.setSkin(SkinType.Vip);
    }

    /** `showVipChangeWindow` (member 7). */
    showVipChangeWindow() {
        return this._sendToBall({ type: "skin-change" });
    }

    /** Switch the ball's skin (UI_SPEC_2 section 1.1h). */
    setSkin(skin) {
        this.skin = skin === SkinType.Vip || skin === "vip" ? SkinType.Vip : SkinType.Default;
        return this._pushState();
    }

    // -----------------------------------------------------------------------
    // Bubble and animations -- member 27
    // -----------------------------------------------------------------------

    setBubbleText(text) {
        return this._sendToBall({ type: "bubble", field: "text", value: String(text || "") });
    }

    setBubbleRedText(text) {
        return this._sendToBall({ type: "bubble", field: "red", value: String(text || "") });
    }

    setBubbleEndText(text) {
        return this._sendToBall({ type: "bubble", field: "end", value: String(text || "") });
    }

    setBubbleBtnText(text) {
        return this._sendToBall({ type: "bubble", field: "button", value: String(text || "") });
    }

    showBubbleAni() {
        return this._sendToBall({ type: "bubble", field: "show" });
    }

    closeBubbleAni() {
        return this._sendToBall({ type: "bubble", field: "hide" });
    }

    showFloatArrowInAni() {
        return this._sendToBall({ type: "anim", name: "showFloatArrowInAni" });
    }

    showFloatChangeAni() {
        return this._sendToBall({ type: "anim", name: "showFloatChangeAni" });
    }

    stopFloatChangeAni() {
        return this._sendToBall({ type: "anim", name: "stopFloatChangeAni" });
    }

    // -----------------------------------------------------------------------
    // Pushing state out
    // -----------------------------------------------------------------------

    /**
     * Fold the task table into one summary and send it to both windows.
     *
     * The summary exists so the ball and the panel cannot disagree: both read
     * the same numbers from the same event, and neither has to know that a
     * detail event is what carries the speed. It travels as a `native-event`
     * because that is the channel the kernel's own events already use.
     */
    updateSuspensionState() {
        const tasks = Array.from(this.tasks.values());
        const active = tasks.filter((task) => Number(task.status) === TASK_STATUS.DOWNLOADING);

        let speed = 0;
        let total = 0;
        let done = 0;
        for (const task of tasks) {
            total += Number(task.totalSize) || 0;
            done += Number(task.completedSize) || 0;
            if (Number(task.status) === TASK_STATUS.DOWNLOADING) {
                speed += Number(task.downloadSpeed) || 0;
            }
        }

        const isDowning = typeof this.forceDowning === "boolean" ? this.forceDowning : active.length > 0;
        const finished = tasks.length > 0 && tasks.every((task) => Number(task.status) === TASK_STATUS.COMPLETED);
        const failed = tasks.some((task) => Number(task.status) === TASK_STATUS.FAILED);
        // Bytes, not a mean of percentages: a 10 MB file at 100% must not
        // outweigh a 4 GB file at 5% when the ball draws one arc for both.
        const progress = total > 0 ? Math.min(1, done / total) : finished ? 1 : 0;

        this.state = {
            tasks,
            activeCount: active.length,
            totalCount: tasks.length,
            speed,
            progress,
            isDowning,
            statusText: this.statusText || defaultStatusText(active.length, tasks.length, finished, failed),
            isVip: this.isVip || !!(this.getVipInfo() && this.getVipInfo().isVip),
            skin: this.skin,
            dpiFactor: this.dpiFactor,
        };

        this.windowManager.broadcast("native-event", {
            name: NATIVE_EVENTS.ON_SUSPENSION_STATE,
            payload: this.state,
        });
        return this.state;
    }

    /** Send one message to the ball page. */
    _sendToBall(message) {
        const win = this.windowManager.getWindow(WINDOW_NAME);
        if (win && !win.isDestroyed()) win.webContents.send("native-event", message);
        return message;
    }

    /** Re-broadcast the current summary without touching the task table. */
    _pushState() {
        return this.updateSuspensionState();
    }

    /** Bring the main window forward, for the panel's "open" button. */
    showMainWindow() {
        this.bringMainToTop();
        return true;
    }

    pauseAll() {
        this.pauseAllTasks();
        return true;
    }

    resumeAll() {
        this.resumeAllTasks();
        return true;
    }

    /** Drop every task record; used when the session changes. */
    reset() {
        this.tasks.clear();
        return this.updateSuspensionState();
    }
}

/** The wording the ball's status line falls back to. */
function defaultStatusText(activeCount, totalCount, finished, failed) {
    if (activeCount > 0) return `下载中 ${activeCount} 个任务`;
    if (totalCount === 0) return "暂无任务";
    if (failed) return "有任务失败";
    if (finished) return "全部完成";
    return "已暂停";
}

module.exports = {
    SuspensionService,
    WINDOW_NAME,
    PANEL_WINDOW,
    WINDOW_OPTIONS,
    SIZES,
    HIT_WIDTH,
    HIT_HEIGHT,
    EDGE_MARGIN,
    FloatPanelDirection,
    SkinType,
    TASK_STATUS,
    clampToWorkArea,
    setFloatPanelDirection,
    chooseDirection,
    panelPosition,
    ballAnchor,
    defaultStatusText,
};
