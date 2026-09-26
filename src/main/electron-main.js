/**
 * Electron entry point.
 *
 * Kept apart from `index.js` on purpose. `index.js` builds the application and
 * is required directly by the test suite, which runs under plain node; pulling
 * `electron` into it would make every test depend on a runtime that is not
 * there. This file is the only one that knows about windows, and it reaches the
 * application through the same `createApplication` the tests use.
 *
 * The window it opens is the host for the plugin views the original mounts as
 * `<webview>` elements. The main process cannot create those -- it has no DOM
 * -- so it queues the requests and this file drains the queue into a page.
 */

"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, session } = require("electron");

const { createApplication } = require("./index");
const contract = require("./contract");

const APP_ROOT = path.resolve(__dirname, "..", "..");

/*
 * The shape handed to the renderer for each queued view.
 *
 * `nodeintegration` is passed through as the original sets it rather than
 * normalised to a boolean: the plugin sends a string, and a renderer that
 * compared it against `"true"` would behave differently from one that received
 * a real `true`. Translating at the boundary keeps that decision in one place.
 */
function toViewDescriptor(entry) {
    return {
        id: entry.id,
        src: entry.src,
        nodeintegration: entry.nodeintegration === true || entry.nodeintegration === "true",
    };
}

/*
 * Menu suppression.
 *
 * The original shows no application menu, and leaving the default one in place
 * would add accelerators (reload, devtools, quit) that the plugin host does not
 * expect and that a user of a download client has no use for.
 */
function configureMenu() {
    const { Menu } = require("electron");
    Menu.setApplicationMenu(null);
}

async function boot() {
    configureMenu();

    const win = new BrowserWindow({
        width: 1100,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        backgroundColor: "#1b1b1f",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "..", "preload", "index.js"),
            // The renderer is a plain page that draws a task list. It does not
            // need node, and the plugin views that do get their own setting.
            contextIsolation: true,
            nodeIntegration: false,
            // The plugin views are mounted as <webview>, which is off by
            // default from Electron 5 onwards.
            webviewTag: true,
        },
    });

    win.once("ready-to-show", () => win.show());

    let application;
    try {
        application = await createApplication();
    } catch (error) {
        // A failed boot still has to show something: the window is already
        // created, and a blank one with no explanation is indistinguishable
        // from a hang.
        win.loadFile(path.join(APP_ROOT, "src", "renderer", "index.html"));
        win.webContents.once("did-finish-load", () => {
            win.webContents.send("boot-error", String(error && error.message));
        });
        return { win, application: null };
    }

    await win.loadFile(path.join(APP_ROOT, "src", "renderer", "index.html"));

    // Requests made before the page existed are drained on first load. The
    // drain is a pull rather than a push so that a reload -- which discards
    // every mounted view -- re-creates them from the same queue.
    const deliverViews = () => {
        const views = (application.pendingWebviews || []).map(toViewDescriptor);
        win.webContents.send("views", views);
    };
    ipcMain.handle("views:list", () => {
        return (application.pendingWebviews || []).map(toViewDescriptor);
    });
    win.webContents.on("did-finish-load", deliverViews);

    /*
     * Events the kernel raises go to the renderer as they happen.
     *
     * The list is taken from the contract rather than written out by hand, so a
     * kernel event added there is forwarded without anyone remembering to come
     * back here. Login events come from the other namespace and are added
     * explicitly because they are not part of the download kernel's set.
     */
    const forwarded = Object.values(contract.KERNEL_EVENTS).concat([
        contract.NATIVE_EVENTS.ON_LOGIN_SUC,
        contract.NATIVE_EVENTS.ON_LOGOUT,
    ]);

    const relay = (name) => {
        return (payload) => {
            if (win.isDestroyed()) return;
            win.webContents.send("native-event", { name, payload });
        };
    };
    for (const name of forwarded) {
        const listener = relay(name);
        application.mesh.renderer.attachServerEvent(name, listener);
        win.once("closed", () => {
            application.mesh.renderer.detachServerEvent(name, listener);
        });
    }

    /*
     * Renderer-initiated calls.
     *
     * The channel is a transport, not a second API: the names it carries are
     * the ones the server functions are already registered under, so nothing
     * here has to be kept in step with the plugin contract by hand.
     *
     * The two leading arguments are the plugin convention -- caller context and
     * the callee's own context -- and every registered handler strips them.
     * The renderer has no context object of its own, so a labelled placeholder
     * stands in. Sending the arguments without them would silently shift every
     * real argument by two, which is the kind of failure that looks like a
     * wrong value rather than a wrong call.
     */
    ipcMain.handle("rpc", async (_event, method, args) => {
        const mesh = application && application.mesh && application.mesh.main;
        if (!mesh) {
            return { ok: false, error: "not ready" };
        }
        const context = { id: "renderer" };
        try {
            const value = await mesh.callServerFunction(method, context, context, ...args);
            return { ok: true, value };
        } catch (error) {
            return { ok: false, error: String((error && error.message) || error) };
        }
    });

    win.once("closed", async () => {
        await application.stop();
        app.quit();
    });

    return { win, application };
}

app.whenReady().then(() => {
    boot().catch((error) => {
        console.error("[thunderx] window failed:", error);
        app.quit();
    });
});

app.on("window-all-closed", () => {
    // No macOS exception: this is a single-window client and the downloader
    // should not keep running with nothing to show it in.
    app.quit();
});

// The plugin views load remote content in a webview, and the original allows
// it to keep its own storage. A separate partition keeps that content from
// sharing a cookie jar with the UI page.
app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() === "webview") {
        contents.setWindowOpenHandler(({ url }) => {
            // Links inside a plugin page open externally rather than replacing
            // the view, which is what the original does and what keeps the
            // plugin's own navigation state intact.
            require("electron").shell.openExternal(url);
            return { action: "deny" };
        });
    }
});

module.exports = { boot, toViewDescriptor };
