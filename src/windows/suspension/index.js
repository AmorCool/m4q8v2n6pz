/**
 * The ball page.
 *
 * It draws one number -- the download percentage -- and turns pointer gestures
 * into messages. It holds no task table of its own: the main process merges the
 * kernel's events into one summary and sends it as `onSuspensionState`, so the
 * ball and the panel cannot show different progress for the same download.
 *
 * The gestures are the reason this page exists at all. A `transparent: true`
 * window still eats mouse events over its whole 400x262 rectangle, so the main
 * process keeps `setIgnoreMouseEvents(true, { forward: true })` on and waits to
 * be told when the pointer is over the ball. `forward: true` is what makes that
 * possible: it delivers `mousemove` to this page even while clicks pass
 * through, and the page answers with `hover` / `leave` as the pointer crosses
 * the hit rectangle.
 *
 * Dragging is computed here rather than in the main process because the screen
 * and viewport coordinates are both available in the event, and their
 * difference is the window's own origin. The main process only has to
 * `setPosition`; the clamp on release is its job, not this one's.
 */

"use strict";

const bridge = window.thunderx || {};

const $ = (id) => document.getElementById(id);

/** Send one action to the main process. */
function send(type, extra) {
    if (typeof bridge.suspensionAction !== "function") return;
    bridge.suspensionAction(Object.assign({ type }, extra || {}));
}

const state = {
    /** Whether the pointer is currently over the hit rectangle. */
    inside: false,
    dragging: false,
    /** True once the pointer has moved far enough to count as a drag. */
    moved: false,
    /** { screenX, screenY, originX, originY } at mouse-down. */
    start: null,
    /** The last position a drag asked for. */
    last: null,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Draw the arc and the percentage.
 *
 * `progress` is a 0..1 fraction of bytes across every task, which is what the
 * main process sends -- a fraction of bytes rather than a mean of percentages,
 * because the ball draws one arc for all of them.
 */
function render(summary) {
    const data = summary || {};
    const progress = Number(data.progress);
    const fraction = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;

    const ring = $("ring");
    if (ring) {
        // The path is normalised to 100 units, so the offset is the missing
        // percentage and nothing else.
        ring.style.strokeDashoffset = String(100 - fraction * 100);
    }

    const percent = $("percent");
    if (percent) percent.textContent = `${Math.round(fraction * 100)}%`;

    document.body.dataset.mode = data.isDowning ? "down" : "normal";
    document.body.dataset.skin = data.skin === 1 ? "vip" : "default";
}

/** The bubble card's four settable pieces (the original's setBubble* members). */
function applyBubble(message) {
    const field = message && message.field;
    const bubble = $("bubble");
    if (!bubble) return;

    if (field === "show") {
        bubble.classList.remove("is-hidden");
        return;
    }
    if (field === "hide") {
        bubble.classList.add("is-hidden");
        return;
    }

    const target = field === "red" ? $("bubble-red") : field === "button" ? $("bubble-btn") : $("bubble-text");
    if (!target) return;
    if (field === "button") {
        target.textContent = message.value;
        target.classList.toggle("is-hidden", !message.value);
    } else if (field === "red") {
        target.textContent = message.value;
        target.classList.toggle("is-hidden", !message.value);
    } else {
        target.textContent = message.value;
    }
}

/** Re-trigger a CSS animation by name (the original's show*Ani members). */
function replayAnimation(name) {
    const ball = $("ball");
    if (!ball) return;
    // Clear first and force a reflow. Writing the same attribute value again
    // does not restart a running animation, which is the whole point of
    // replaying it.
    delete ball.dataset.animation;
    void ball.offsetWidth;
    ball.dataset.animation = name;
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** Whether a viewport point is inside the ball's hit rectangle. */
function isInsideBall(x, y) {
    const hit = $("hit");
    if (!hit || typeof hit.getBoundingClientRect !== "function") return false;
    const rect = hit.getBoundingClientRect();
    if (!rect) return false;
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

function onMouseDown(event) {
    if (event.button !== 0) return;
    /*
     * Stop the press from becoming a native drag or a text selection.
     *
     * Either one takes the pointer capture away from the page, and with it the
     * `mousemove` stream the drag is built on: the window would never move and
     * the gesture would look like a dead ball. Nothing here is draggable and
     * the body is `user-select: none`, but relying on that is relying on a
     * stylesheet staying correct.
     */
    if (typeof event.preventDefault === "function") event.preventDefault();

    state.dragging = true;
    state.moved = false;
    state.last = null;
    // The window's origin, in the same coordinate space as `setPosition`:
    // screen minus viewport is where the viewport starts on screen.
    state.start = {
        screenX: event.screenX,
        screenY: event.screenY,
        originX: event.screenX - event.clientX,
        originY: event.screenY - event.clientY,
    };
    send("leftClickDown");
}

function onMouseMove(event) {
    if (state.dragging) {
        const dx = event.screenX - state.start.screenX;
        const dy = event.screenY - state.start.screenY;
        if (!state.moved && Math.abs(dx) + Math.abs(dy) > 3) state.moved = true;
        if (state.moved) {
            state.last = {
                x: Math.round(state.start.originX + dx),
                y: Math.round(state.start.originY + dy),
            };
            send("drag", state.last);
        }
        return;
    }

    const inside = isInsideBall(event.clientX, event.clientY);
    if (inside !== state.inside) {
        state.inside = inside;
        send(inside ? "hover" : "leave");
    }
}

function onMouseUp() {
    if (!state.dragging) return;
    state.dragging = false;
    if (state.moved && state.last) {
        send("dragEnd", state.last);
    } else {
        // A press that did not move is a click, and the main process decides
        // what it means from the main window's own state.
        send("leftClick");
    }
    state.moved = false;
    state.start = null;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init() {
    const hit = $("hit");
    if (hit) {
        hit.addEventListener("mousedown", onMouseDown);
        hit.addEventListener("dblclick", () => send("leftDBClick"));
        hit.addEventListener("contextmenu", (event) => {
            // The menu itself is a native one; the page only says where it was
            // asked for.
            event.preventDefault();
            send("rightClick");
        });
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    // `mouseleave` on the document is the only reliable signal that the pointer
    // left the window: once it is over the panel window, this page receives no
    // more moves at all.
    document.addEventListener("mouseleave", () => {
        state.inside = false;
        send("leave");
    });

    const bubbleBtn = $("bubble-btn");
    if (bubbleBtn) {
        // Index 4 is the button position the original registers with
        // `setBubbleBtnText` and reports back through `clickBubble(4)`.
        bubbleBtn.addEventListener("click", () => send("bubbleBtn", { index: 4 }));
    }

    if (typeof bridge.onNativeEvent === "function") {
        bridge.onNativeEvent((envelope) => {
            const message = envelope || {};
            if (message.name === "onSuspensionState") {
                render(message.payload);
                return;
            }
            // The bubble and animation members travel the same channel as the
            // summary; only the summary has a `name` the contract defines.
            if (message.type === "bubble") applyBubble(message);
            else if (message.type === "anim") replayAnimation(message.name);
            else if (message.type === "skin-change") document.body.dataset.skin = "vip";
            else if (message.type === "mode") document.body.dataset.mode = message.mode;
        });
    }
}

init();
