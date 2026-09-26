/**
 * Preload bridge.
 *
 * The renderer is context-isolated, so this is the only thing it can reach out
 * with. It exposes a small, named surface rather than forwarding `ipcRenderer`
 * wholesale: a renderer that could send arbitrary channel names would have the
 * same reach as one with node integration, which defeats the point of
 * isolating it.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("thunderx", {
    /** Every view the plugins asked for, including any queued before load. */
    listViews: () => ipcRenderer.invoke("views:list"),

    /** Views are also pushed, again after a reload re-creates them. */
    onViews: (callback) => {
        const listener = (_event, views) => callback(views);
        ipcRenderer.on("views", listener);
        return () => ipcRenderer.removeListener("views", listener);
    },

    /** Engine and login events, already relayed by the main process. */
    onNativeEvent: (callback) => {
        const listener = (_event, envelope) => callback(envelope);
        ipcRenderer.on("native-event", listener);
        return () => ipcRenderer.removeListener("native-event", listener);
    },

    /** Shown when the application failed to boot at all. */
    onBootError: (callback) => {
        const listener = (_event, message) => callback(message);
        ipcRenderer.on("boot-error", listener);
        return () => ipcRenderer.removeListener("boot-error", listener);
    },

    /** Call a server function by the same name the plugin contract uses. */
    rpc: (method, ...args) => ipcRenderer.invoke("rpc", method, args),

    /*
     * Close the window this page is in.
     *
     * The dialogs draw their own title bar, so their close button has to be
     * able to close the window it is drawn in. A renderer cannot do that
     * itself, and the alternative -- `window.close()` -- is not reliable for a
     * window the page did not open. The main process resolves the window from
     * the sender, so this stays correct with more than one dialog.
     */
    closeWindow: () => ipcRenderer.send("window:close"),
});
