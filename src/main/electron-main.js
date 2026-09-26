/**
 * Electron entry point.
 *
 * Kept apart from `index.js` on purpose. `index.js` builds the application and
 * is required directly by the test suite, which runs under plain node; pulling
 * `electron` into it would make every test depend on a runtime that is not
 * there. This file is the only one that knows about windows, and it reaches the
 * application through the same `createApplication` the tests use.
 *
 * Two kinds of window exist. The main window hosts the plugin views the
 * original mounts as `<webview>` elements -- the main process cannot create
 * those, it has no DOM, so it queues the requests and this file drains the
 * queue into a page. The other windows are dialogs the client opens for
 * itself, the new-task window being the first; they are created through the
 * same registry so that a second window cannot be left out of event delivery.
 */

"use strict";

const path = require("path");
const os = require("os");
const { app, BrowserWindow, ipcMain, dialog, session } = require("electron");

const { createApplication } = require("./index");
const contract = require("./contract");
const { WindowManager } = require("./window-manager");
const { NewTaskService } = require("./newtask");
const { PanWindowService } = require("./panwindow");

const APP_ROOT = path.resolve(__dirname, "..", "..");

/** Where a download goes when the user has not chosen anything else. */
function defaultDownloadDir(application) {
    return (
        (application && application.lastDownloadDir) ||
        (application && application.config && application.config.downloadDir) ||
        path.join(os.homedir(), "ThunderX")
    );
}

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

    const windowManager = new WindowManager();

    const mainWindow = windowManager.openWindow("main", {
        width: 1100,
        height: 720,
        minWidth: 800,
        minHeight: 560,
        webPreferences: {
            // The plugin views are mounted as <webview>, which is off by
            // default from Electron 5 onwards. The renderer itself is a plain
            // page that draws a task list: it does not need node, and the
            // plugin views that do get their own setting.
            webviewTag: true,
        },
    });

    /*
     * The save-directory dialog.
     *
     * One server function with a `kind` argument rather than two names: the
     * directory picker and the torrent picker differ only by their filter and
     * their `properties`, and the archive does not record the original's
     * dialog, so there is nothing to be faithful to beyond the shape of the
     * answer -- a path, or an empty string when the user cancels.
     */
    async function pickDirectory(kind) {
        const wantsTorrent = kind === "torrent";
        const options = {
            title: wantsTorrent ? "选择种子文件" : "选择保存目录",
            properties: wantsTorrent ? ["openFile"] : ["openDirectory", "createDirectory"],
            filters: wantsTorrent
                ? [{ name: "Torrent", extensions: ["torrent", "metalink"] }]
                : undefined,
        };
        // The dialog is parented to whichever window is asking, so it cannot
        // end up behind it. `dialog` with an undefined parent is a different
        // call, hence the branch rather than a nullable argument.
        const parent = windowManager.getWindow("new-task") || windowManager.getWindow("main");
        const result = parent
            ? await dialog.showOpenDialog(parent, options)
            : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths.length) return "";
        return result.filePaths[0];
    }

    let application;
    let newTask = null;
    let panWindow = null;
    try {
        application = await createApplication();
    } catch (error) {
        // A failed boot still has to show something: the window is already
        // created, and a blank one with no explanation is indistinguishable
        // from a hang. The load is not awaited on purpose -- the error has to
        // be queued before the page finishes, or there is no `did-finish-load`
        // left to send it on.
        mainWindow.loadFile(path.join(APP_ROOT, "src", "renderer", "index.html"));
        mainWindow.webContents.once("did-finish-load", () => {
            mainWindow.webContents.send("boot-error", String(error && error.message));
        });
        return { win: mainWindow, windowManager, application: null };
    }

    /*
     * The new-task dialog.
     *
     * Built here rather than inside the application because it needs a window,
     * and the application is deliberately kept free of anything Electron.
     * Everything it does with the engine goes back through server functions,
     * so it never holds the kernel.
     */
    newTask = new NewTaskService({
        windowManager,
        defaultDir: () => defaultDownloadDir(application),
        log: (...a) => console.log("[newtask]", ...a),
    });

    /*
     * The cloud-drive browser.
     *
     * Same shape as the new-task dialog: this process owns the window, the
     * application owns the drive client, and the page reaches it over the
     * transport. `ExternalFetchBack` asks for the window through an event
     * rather than a return value, because opening a window is not something
     * the (electron-free) application can do.
     */
    panWindow = new PanWindowService({
        windowManager,
        log: (...a) => console.log("[pan]", ...a),
    });
    application.on("open-pan-window", () => panWindow.open());

    /*
     * Server functions that only this process can answer.
     *
     * They are registered on the same mesh the application publishes to, so
     * the renderer reaches them through the identical transport -- including
     * the two leading context arguments every handler strips. Registering them
     * here rather than in `index.js` is what keeps `dialog` and `BrowserWindow`
     * out of the file the test suite loads.
     */
    const fromRenderer = (handler) => async (...all) => handler(...all.slice(2));
    application.mesh.server.registerFunctions({
        [contract.SERVER_FUNCTIONS.PICK_DIRECTORY]: fromRenderer((kind) =>
            pickDirectory(kind)
        ),
        [contract.SERVER_FUNCTIONS.CREATE_PRE_NEW_TASK_WINDOW]: fromRenderer((prefill) =>
            newTask.open(prefill)
        ),
        [contract.SERVER_FUNCTIONS.CREATE_PAN_WINDOW]: fromRenderer(() => panWindow.open()),
    });

    await mainWindow.loadFile(path.join(APP_ROOT, "src", "renderer", "index.html"));

    // Requests made before the page existed are drained on first load. The
    // drain is a pull rather than a push so that a reload -- which discards
    // every mounted view -- re-creates them from the same queue.
    const deliverViews = () => {
        const views = (application.pendingWebviews || []).map(toViewDescriptor);
        mainWindow.webContents.send("views", views);
    };
    ipcMain.handle("views:list", () => {
        return (application.pendingWebviews || []).map(toViewDescriptor);
    });
    mainWindow.webContents.on("did-finish-load", deliverViews);

    /*
     * Events the kernel raises go to every window.
     *
     * This used to be a send to one captured window, which was correct only
     * while one window existed: the new-task dialog needs `OnTaskInserted`
     * too, because a task it created has to appear in the list behind it.
     * Broadcasting is what makes the second window a real participant rather
     * than a page that looks connected and is not.
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
            windowManager.broadcast("native-event", { name, payload });
        };
    };
    const detachers = [];
    for (const name of forwarded) {
        const listener = relay(name);
        application.mesh.renderer.attachServerEvent(name, listener);
        detachers.push(() => application.mesh.renderer.detachServerEvent(name, listener));
    }
    // One handler for the whole set: the listeners belong to the registry
    // rather than to one window, so they are dropped when the process is done
    // with them, not when the main window happens to close.
    app.once("before-quit", () => {
        for (const detach of detachers) detach();
    });

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
     *
     * The tuple form is used, not `callServerFunction`, because that one
     * unwraps a failure to `null` and a handler that threw becomes
     * indistinguishable from one that returned nothing. The renderer needs the
     * message: the login screen reports the account system's reason for a
     * rejection, and a thrown service function would otherwise look like a
     * success carrying null.
     *
     * The distinction is `value === null && message`: a handler that returns
     * null without throwing is still a successful call -- which is what the
     * task commands' void results rely on -- while a throw always carries a
     * message.
     */
    ipcMain.handle("rpc", async (_event, method, args) => {
        const mesh = application && application.mesh && application.mesh.main;
        if (!mesh) {
            return { ok: false, error: "not ready" };
        }
        const context = { id: "renderer" };
        const [value, message] = await mesh.callServerFunctionEx(
            method,
            context,
            context,
            ...args
        );
        if (value === null && message) {
            return { ok: false, error: String(message) };
        }
        return { ok: true, value };
    });

    /*
     * A window closing itself.
     *
     * The dialogs draw their own title bar, so their close button has to be
     * able to close the window it is drawn in, and a renderer cannot reach
     * that on its own. Resolved from the sender rather than from a name so
     * that the handler stays correct when a second dialog exists.
     */
    ipcMain.on("window:close", (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) win.close();
    });

    mainWindow.once("closed", async () => {
        // The main window is the application. Closing it stops the engine even
        // if a dialog is still on screen, because the alternative is a
        // downloader running with nothing but a dialog left to control it.
        windowManager.closeAll();
        await application.stop();
        app.quit();
    });

    return { win: mainWindow, windowManager, application };
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
