/**
 * IPC contract layer -- the shared vocabulary of the client.
 *
 * Everything in this file is a literal copied from the original so that
 * plugins, preloads and renderers keep talking to each other unchanged.
 * None of it is invented; where the original has a typo or an odd constant,
 * the typo is preserved on purpose, because these strings are compared
 * character for character at runtime.
 *
 * Source of truth:
 *   plugins/User/0.2.20/index.js  (recovered via inline sourcemaps)
 *   plugins/*\/index.js           (plain bundles)
 *   out/main-renderer/renderer.js (VIP token / login orchestration)
 */

"use strict";

// ---------------------------------------------------------------------------
// Named pipe / socket names
// ---------------------------------------------------------------------------

/**
 * The client socket is derived from a prefix plus this GUID. The prefix is
 * normally the executable basename, so all three pieces together identify a
 * single client instance on the machine.
 */
const CLIENT_SOCKET_GUID = "{FD196984-2591-4588-AA6F-5C8AC1266290}";

/** Context name the server side registers itself under. */
const SERVER_CONTEXT_NAME = "{46105371-DE78-4442-B59F-FDA1D6D7D430}";

/** Third channel, used by the message channel / sync path. */
const THIRD_CHANNEL_GUID = "{A9C9D760-14E8-42CB-A3CB-9C0A0DDFD732}";

/** Used by the OAuth logout webview tabs. */
const OAUTH_LOGOUT_TAB_GUID = "{B284B653-0A8C-4E31-8CA6-A41679F30323}";

// ---------------------------------------------------------------------------
// Context names
// ---------------------------------------------------------------------------

/**
 * Every participant in the RPC mesh has a context name. The name is what
 * other participants use as the `dst` when addressing a call, so these are
 * part of the wire format, not just labels.
 */
const CONTEXTS = Object.freeze({
    MAIN_PROCESS: "main-process",
    MAIN_RENDERER: "main-renderer",
    LOGIN_RENDERER: "login-renderer",
    PRE_NEW_TASK_RENDERER: "pre-new-task-renderer",
    NEW_TASK_RENDERER: "new-task-renderer",
    MAIN_PAGE_WEBVIEW: "main-page-webview-renderer",
    VIP_DOWNLOAD_WEBVIEW: "vip-download-webview",
});

/** Legacy per-plugin login contexts. Login falls back to login2 / login3. */
const LOGIN_HOSTS = Object.freeze(["login", "login2", "login3"]);
const LOGIN_CHANNEL_HOSTS = Object.freeze(["channel", "channel2", "channel3"]);

// ---------------------------------------------------------------------------
// RPC action names
// ---------------------------------------------------------------------------

/**
 * The wire protocol is a flat set of action strings. `call_client_api` is the
 * request, and the callback variants carry the reply back.
 */
const ACTIONS = Object.freeze({
    CALL_CLIENT_API: "call_client_api",
    CALL_CLIENT_BY_ID: "call_client_by_id",
    CALL_CLIENT_BY_ID_CALLBACK: "call_client_by_id_callback",
    CALL_REMOTE_CLIENT_API: "call_remote_client_api",
    CALL_REMOTE_CONTEXT_BY_ID: "call_remote_context_by_id",
    FIRE_EVENT: "fire_event",
    ATTACH_EVENT: "attach_event",
    DETACH_EVENT: "detach_event",
    BROADCAST: "broadcast",
    CHECK_CLIENT_FUNCTION: "check_client_function",
    CHECK_CLIENT_FUNCTION_CALLBACK: "check_client_function_callback",
    REMOTE_CLIENT_CALLBACK: "remote_client_callback",
});

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * These are read at startup and change behaviour. They are the supported way
 * to run the client outside of a packaged install.
 */
const ENV = Object.freeze({
    /** "console" sends the log stream to stdout instead of a file. */
    OUTPUT: "TL_OUTPUT",
    /** Substring filter applied to module names in the log. */
    MODULE_FILTER: "TL_MODULE_FILTER",
    /** "development" disables webSecurity. */
    RUN_ENV: "RUN_ENV",
    /** Presence enables the async-remote logging; when unset every log call
     *  in that layer is replaced by a noop, which is why a debug session
     *  shows nothing at all unless this is set. */
    DEBUG_ASYNC_REMOTE: "DEBUG_ASYNC_REMOTE",
});

// ---------------------------------------------------------------------------
// Native server functions (renderer/plugin -> main process)
// ---------------------------------------------------------------------------

/**
 * Server functions are addressed by bare name. Every one listed here was
 * observed being called by a real plugin or renderer. They are grouped by
 * the subsystem that answers them.
 */
const SERVER_FUNCTIONS = Object.freeze({
    // --- identity / session -------------------------------------------------
    IS_LOGINED: "IsLogined",
    GET_USER_ID: "GetUserID",
    GET_SESSION_ID: "GetSessionID",
    GET_PEER_ID: "GetPeerID",
    GET_VIP_INFO: "GetVipInfo",
    GET_ALL_USER_INFO: "GetAllUserInfo",
    GET_DEVICE_ID: "GetDeviceIdOfWebSDKPlugin",
    GET_LOGIN_DEVICE_ID: "GetLoginDeviceID",
    GET_USER_INFO: "GetUserInfo",
    GET_THUNDER_VERSION: "GetThunderVersion",
    // The plugin calls this before it can build any xbase request; it is the
    // one call that has no sensible fallback, because it carries the OAuth2
    // client credentials.
    GET_INIT_USER_LOGIN_PARAM: "GetInitUserLoginParam",
    // ThunderPanPlugin wants a peer id of its own; it resolves to the same
    // value as GET_PEER_ID.
    GET_TP_PEER_ID: "GetTpPeerId",

    // --- login (the UI's entry points) ---------------------------------------
    //
    // The login screen talks to the client through the same transport as a
    // plugin, so its actions need names here rather than being hardcoded at
    // the call site. The read-only identity functions above already existed;
    // these are the ones that move a session, and LOGIN_WITH_KEY is the only
    // way a credential becomes one.
    LOGIN_WITH_KEY: "LoginWithKey",
    REFRESH_USER_INFO: "RefreshUserInfo",
    LOGOUT: "Logout",
    // The QR and phone paths are named so the UI can report which protocol is
    // missing instead of the call looking like a typo. See the handlers.
    GET_LOGIN_QRCODE: "GetLoginQRCode",
    CHECK_LOGIN_QRCODE: "CheckLoginQRCode",
    SEND_PHONE_CODE: "SendPhoneCode",
    LOGIN_WITH_PHONE: "LoginWithPhone",

    // --- renderer-hosted views ------------------------------------------------
    // Plugins do not create their own windows. They ask the main renderer to
    // mount a <webview> with their page in it, and read back [ok, message].
    CREATE_WEBVIEW: "CreateWebview",

    // --- registration -------------------------------------------------------
    REGISTER_WEB_EXTERNAL: "RegisterWebExternal",
    REGISTER_WEB_INTERNAL: "RegisterWebInternal",

    // --- vip / dcdn ---------------------------------------------------------
    ENABLE_DCDN_WITH_VIP_CERT: "EnableDcdnWithVipCert",
    UPDATE_DCDN_WITH_VIP_CERT: "UpdateDcdnWithVipCert",
    DISABLE_DCDN_WITH_VIP_CERT: "DisableDcdnWithVipCert",

    // --- task -----------------------------------------------------------------
    GET_DOWNLOADING_ACTIVE_TASK_ID: "GetDownloadingActiveTaskId",
    SELECT_CATEGORY_VIEW: "SelectCategoryView",
    GET_CONFIG_MODULES: "GetConfigModules",

    // --- task: mutations ------------------------------------------------------
    //
    // The original renderer holds the kernel object directly and calls
    // `deleteTask` / `startTask` on it, so it never needed these to exist as
    // server functions. This rebuild keeps the kernel in the main process --
    // which is where the engine lives and where the plugin contract already
    // puts it -- so the renderer needs a way to reach the same operations, and
    // these are it.
    //
    // The names are the ones the original's own task commands use
    // (`CreateNewTask`, `PauseTask`, `DeleteTask`, all read off the released
    // renderer bundle), so a name here means the same thing it means there.
    CREATE_NEW_TASK: "CreateNewTask",
    PAUSE_TASK: "PauseTask",
    RESUME_TASK: "ResumeTask",
    DELETE_TASK: "DeleteTask",
    GET_TASK_BASE_INFO: "GetTaskBaseInfo",
    GET_ALL_TASK_BASE_INFO: "GetAllTaskBaseInfo",

    // --- task: the new-task window --------------------------------------------
    //
    // The original ships this as a native window (`ThunderNewTask`) plus two
    // renderers, and the command names below are read off the released bundle
    // (IPC_CONTRACT.md:243-244, :256). Keeping the original names means the
    // window can later be split into `pre-new-task` and `new-task` without
    // touching the contract -- only which window answers would move.
    //
    // `PreDownload` is the magnet pre-parse step: a magnet link carries no
    // file list, so the file names have to be read back from the engine after
    // it has met a peer. `CreateNewTaskEx` is the create that carries the
    // user's file selection.
    CREATE_PRE_NEW_TASK_WINDOW: "CreatePreNewTaskWindow",
    PRE_DOWNLOAD: "PreDownload",
    PRE_DOWNLOADING: "PreDownloading",
    CREATE_NEW_TASK_EX: "CreateNewTaskEx",
    // The save directory is chosen by a native dialog, which only the main
    // process can open. One name with a `kind` argument rather than two names,
    // because the two dialogs differ only by their filter.
    PICK_DIRECTORY: "PickDirectory",

    // --- pan / cloud drive ----------------------------------------------------
    //
    // The first five are the original's own names, read off the recovered
    // ThunderPanPlugin (PAN_DIRECT_LINK_SPEC.md section 6): the plugin page
    // dispatches `drive/fetchBackFiles` to open the take-back popup, the popup
    // calls `IpcStartRetrieval`, and the two `ExternalFetchBack` entries are
    // the web/clipboard entry points. They are kept verbatim so a plugin that
    // still calls them lands on the same handlers.
    GET_FETCH_BACK_FILES: "GetFetchBackFiles",
    IPC_START_RETRIEVAL: "IpcStartRetrieval",
    EXTERNAL_FETCH_BACK: "ExternalFetchBack",
    EXTERNAL_FETCH_BACK_BY_ID: "ExternalFetchBackById",
    IPC_SET_RECENT_FOLDER: "IpcSetRecentFolder",

    // The browsing calls have no original counterpart: the plugin page talked
    // to the drive API from inside its own webview, so there was nothing to
    // name on this side. This rebuild moves the drive client into the main
    // process, so the window needs a name to reach it, and these are it. The
    // `CreatePanWindow` opener is the same convention as the new-task
    // window's `CreatePreNewTaskWindow`.
    PAN_LIST_FILES: "PanListFiles",
    PAN_DOWNLOAD_FILE: "PanDownloadFile",
    CREATE_PAN_WINDOW: "CreatePanWindow",

    // --- suspension (the floating ball) ---------------------------------------
    //
    // The first two names are the original's own. Its suspension renderer's
    // `showOrHideMainWindow` asks `GetMainWindowStates` and then calls
    // `BringMainWndToTop` (out/suspension-renderer/renderer.js, quoted in
    // UI_SPEC_2 section 1.1e), so a plugin or page that still calls them lands
    // on the same handlers.
    //
    // The original stores the ball's position through
    // `SetConfigValue("ConfigSuspension", "SuspensionX"/"SuspensionY", ...)`.
    // This rebuild has a config file rather than a config store, so the same
    // read and write get a name of their own instead of borrowing the
    // generic Get/SetConfigValue pair, which does not exist here.
    GET_MAIN_WINDOW_STATES: "GetMainWindowStates",
    BRING_MAIN_WND_TO_TOP: "BringMainWndToTop",
    SET_SUSPENSION_POSITION: "SetSuspensionPosition",
    GET_SUSPENSION_CONFIG: "GetSuspensionConfig",

    // --- settings (config store) ---------------------------------------------
    //
    // The read/write pair is the original's own: its suspension renderer calls
    // `SetConfigValue("ConfigSuspension", "SuspensionX", ...)` and the renderer
    // reads through `GetConfigValue` (SETTINGS_SEARCH_NOTIFY_SPEC.md section
    // 1.2, the `Config` module). Keeping the names means a page that was
    // written against the original reaches the same handlers.
    //
    // `SaveConfig` and `GetSettingsSchema` have no recovered counterpart. The
    // original's `Config.save` is internal and its schema is a bundled
    // constant, so a window there never had to ask for either; this build's
    // settings window is a separate page and does.
    GET_CONFIG_VALUE: "GetConfigValue",
    SET_CONFIG_VALUE: "SetConfigValue",
    SAVE_CONFIG: "SaveConfig",
    GET_SETTINGS_SCHEMA: "GetSettingsSchema",
    // Same convention as the new-task and pan openers: the window belongs to
    // the main process, so a page asks for it by name.
    CREATE_SETTINGS_WINDOW: "CreateSettingsWindow",

    // --- search (the address-bar dropdown) ------------------------------------
    //
    // The original runs the address bar in the main renderer and the dropdown in
    // a separate `search-renderer` window, and the two talk over these names
    // (SETTINGS_SEARCH_NOTIFY_SPEC.md section 2.3). `SearchTask` and
    // `SearchPanTask` are the original's own calls, answered here from the
    // kernel's task list and the cloud-drive client; `SearchMovie` (online
    // 影视联想) is deliberately absent because it needs the signed
    // `api-shoulei-ssl.xunlei.com` backend.
    //
    // The remaining four have no recovered counterpart: the original's panel
    // owned its own input and selection state, while this build's panel is
    // driven from the address bar, so the messages between the two windows need
    // names. They follow the `Create*Window` convention.
    SEARCH_TASK: "SearchTask",
    SEARCH_PAN_TASK: "SearchPanTask",
    SEARCH_INPUT: "SearchInput",
    SEARCH_KEY: "SearchKey",
    SEARCH_CLOSE: "SearchClose",
    SEARCH_PICK: "SearchPick",
    CREATE_SEARCH_WINDOW: "CreateSearchWindow",

    // --- plugin control -----------------------------------------------------
    SET_PLUGIN_STATUS: "SetPluginStatus",
    TRACK_EVENT: "TrackEvent",
});

// ---------------------------------------------------------------------------
// Native events (main process -> renderer/plugin)
// ---------------------------------------------------------------------------

const NATIVE_EVENTS = Object.freeze({
    ON_LOGIN_BEFORE: "onLoginBefore",
    ON_LOGIN_SUC: "onLoginSuc",
    ON_LOGIN_FAILED: "onLoginFailed",
    ON_GET_USER_INFO_FINISHED: "onGetUserInfoFinished",
    ON_LOGOUT: "onLogout",
    ON_USER_DETAIL_INFO_CHANGE: "onUserDetailInfoChange",
    // Delivered to the new-task window once its page is up. The prefill
    // (a link copied from the main window, or a magnet picked up from the
    // clipboard) has to wait for the page: the window is created before its
    // renderer exists, so sending at open time would reach nobody.
    ON_NEW_TASK_PREFILL: "onNewTaskPrefill",
    // The ball and its panel are two windows that both draw kernel state and
    // neither holds the kernel. The main process already forwards every kernel
    // event; it merges them into one summary and sends this as well, so the two
    // windows cannot disagree about what is downloading. It is a native event
    // rather than a second channel because it travels the same road -- see
    // electron-main's relay.
    ON_SUSPENSION_STATE: "onSuspensionState",
    // Fired after a stored value changed, so a settings page can stay in step
    // with a change made anywhere else. The original's spelling is preserved
    // character for character -- `OnConfigValueChanaged` (renderer.js:74541) --
    // because a listener that subscribed to the correct spelling would never
    // fire against the shipped client, and a typo that is compared by string is
    // part of the wire format rather than a mistake to fix.
    ON_CONFIG_VALUE_CHANGED: "OnConfigValueChanaged",
    // The search dropdown's three messages. They are addressed to the dropdown
    // window alone (not broadcast): the main window owns the address bar and
    // forwards the keyword and the arrow keys, and the panel answers with a
    // commit. `ON_SEARCH_COMMIT` goes the other way -- from the panel (or the
    // main window's Enter) to the main window, which is the only side that can
    // act on a result.
    ON_SEARCH_QUERY: "onSearchQuery",
    ON_SEARCH_KEY: "onSearchKey",
    ON_SEARCH_COMMIT: "onSearchCommit",
    // The clipboard poll lives in the main process (`electron.clipboard` is not
    // reachable from an isolated renderer), so the hit is delivered as an
    // event and the renderer raises the original's 剪贴板 toast.
    ON_CLIPBOARD_LINK: "onClipboardLink",
});

/** Download kernel events, forwarded verbatim to the JS side. */
const KERNEL_EVENTS = Object.freeze({
    TASK_INSERTED: "OnTaskInserted",
    TASK_COMPLETED: "OnTaskCompleted",
    TASK_REMOVED: "OnTaskRemoved",
    TASK_STATUS_CHANGED: "OnTaskStatusChanged",
    TASK_DETAIL_CHANGED: "OnTaskDetailChanged",
    TASK_DCDN_STATUS_CHANGED: "OnTaskDcdnStatusChanged",
    BT_SUB_FILE_DCDN_STATUS_CHANGED: "OnBtSubFileDcdnStatusChanged",
    BT_SUB_FILE_DETAIL_CHANGED: "OnBtSubFileDetailChanged",
    BT_SUB_FILE_FORBIDDEN: "OnBtSubFileForbidden",
});

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const ENDPOINTS = Object.freeze({
    // --- login ---------------------------------------------------------------
    LOGIN_BASE_URL: "/xluser.core.login/v3/",
    LOGIN_PATH_LOGINKEY: "loginkey",
    LOGIN_PATH_GETUSERINFO: "getuserinfo",
    LOGIN_PATH_LOGOUT: "logout",
    LOGIN_PATH_PING: "ping",
    LOGIN_PATH_SESSIONLOGIN: "sessionlogin",
    LOGIN_PATH_JUMPLOGIN: "jumplogin",
    // The three interactive paths, spelled exactly as the shipped bundle
    // spells them (main.js, quoted in LOGIN_PROTOCOL_SPEC.md sections 3 and 4).
    LOGIN_PATH_LOGIN: "login",
    LOGIN_PATH_SENDSMS: "sendsms",
    LOGIN_PATH_SMSLOGIN: "smslogin",
    /** The scan page the QR URL redirects to; GET, no body. */
    LOGIN_PATH_QRLOGIN: "qrlogin",

    /** vas ids requested with getuserinfo; the VIP flags ride along here. */
    LOGIN_VAS_ID: "2,14,33,34,35",

    /** Non-standard OAuth2 endpoint that turns a device-code token into a
     *  session: GET appid / token / appname / devicesign (spec section 2A). */
    SESSION_REGISTER: "/session/v1/register",

    // --- account center (OAuth2) ---------------------------------------------
    AUTH_SIGNIN: "/v1/auth/signin",
    AUTH_SIGNIN_WITH_PROVIDER: "/v1/auth/signin/with/provider",
    /** Session -> token exchange. The one path login actually depends on. */
    AUTH_SIGNIN_TOKEN: "/v1/auth/signin/token",
    AUTH_SIGNUP: "/v1/auth/signup",
    AUTH_SIGNUP_ANONYMOUSLY: "/v1/auth/signup/anonymously",
    AUTH_TOKEN: "/v1/auth/token",
    AUTH_DEVICE_CODE: "/v1/auth/device/code",
    AUTH_REVOKE: "/v1/auth/revoke",
    AUTH_VERIFICATION: "/v1/auth/verification",
    AUTH_VERIFICATION_VERIFY: "/v1/auth/verification/verify",
    AUTH_PROVIDER_TOKEN: "/v1/auth/provider/token",
    AUTH_PROVIDER_URI: "/v1/auth/provider/uri",

    USER_AUTHORIZE: "/v1/user/authorize",
    USER_ME: "/v1/user/me",
    USER_QUERY: "/v1/user/query",
    USER_PROFILE: "/v1/user/profile",
    USER_PROVIDER: "/v1/user/provider",
    USER_PROVIDER_BIND: "/v1/user/provider/bind",
    USER_DEVICE_AUTHORIZE: "/v1/user/device/authorize",
    USER_TRANS_BY_PROVIDER: "/v1/user/trans/by/provider",
    USER_SUDO: "/v1/user/sudo",
    USER_CONTACT: "/v1/user/contact",
    USER_PASSWORD: "/v1/user/password",

    // --- vip acceleration ----------------------------------------------------
    /** Token issuance. Query and status share the host, differ by path. */
    VIP_SPEED_HOST: "ali.pc-x.speed.auth.vip.xunlei.com",
    VIP_SPEED_PATH_QUERY: "/speed/speedup",
    VIP_SPEED_PATH_STATUS: "/speed/res_status",
    VIP_QUERYTAGS_URL: "https://soa-vip-ssl.xunlei.com/xlvip.common.mooseapi/querytags",

    // --- misc -----------------------------------------------------------------
    OAUTH_SIGNOUT_URL: "https://i.xunlei.com/xluser/oauth.html?sign_out=true",
    ACC_CENTER_URL: "https://i.xunlei.com/xluser/code-auth/",
});

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const PROTOCOL = Object.freeze({
    /** Request / response framing on the named pipe is newline-delimited JSON. */
    FRAME_DELIMITER: "\n",
    /** Server SDK config passes this string to the device signing routine. */
    DEVICE_SIGN_PREFIX: "div101.",
    /** For the query-string flavour of the VIP token request. */
    VIP_CLIENT_NAME: "xl_pc",
    /** Separate client name used by the plugin-host flavour. */
    VIP_ACCEPT: "application/json;version=1.3",
    VIP_ACCEPT_PLUGIN: "application/json; version=1.0",
    /** OAuth scope is plus-joined, not space-joined. */
    OAUTH_SCOPE: "user+pan",
    /** Hardcoded client id from the account center. */
    ACC_CENTER_CLIENT_ID: "XW5SkOhLDjnOZP7J",
    /** Provider string that tells the token endpoint the credential is a
     *  client-side session id rather than a password or auth code. */
    SESSION_TOKEN_PROVIDER: "access_end_point_token",
    /** The RFC 8628 grant type the device-code scan flow polls with. */
    DEVICE_CODE_GRANT: "urn:ietf:params:oauth:grant-type:device_code",
    REQUEST_ID_HEADER: "x-request-id",
    DEVICE_ID_HEADER: "x-device-id",
});

// ---------------------------------------------------------------------------
// Login credentials
// ---------------------------------------------------------------------------

/**
 * The values the shipped PC client is built with.
 *
 * appid/appkey are identifiers rather than secrets -- the original carries
 * them in plain sight (out/main-renderer/renderer.js `getInitData`, spec
 * section 9.1) and they are two of the four inputs to the device signature,
 * so a wrong value changes the client's identity. The OAuth2 pair is the
 * production tenant (spec section 9.2); the device-code and token endpoints
 * reject a request without it.
 *
 * These are defaults. A build can still override them through config, which
 * is why they are a named block rather than literals at the call sites.
 */
const LOGIN = Object.freeze({
    APPID: "0",
    APPKEY: "4af30ad6c6b0c02c4d8df3ded2cb79b8",
    APP_NAME: "PC-com.xunlei.thunderx",
    CLIENT_ID: "XW-G4v1H72tgfJym",
    CLIENT_SECRET: "Qbaferw2knfQKqxa25EYJGtZ2_6755CMwzXBN3ctW54",
    API_ORIGIN: "https://xluser-ssl.xunlei.com",
    /** The QR page is served from a different host than the API; the device
     *  code's verification URI is rewritten onto this one before encoding. */
    QRLOGIN_HOST: "misc-xl9-ssl.xunlei.com",
});

// ---------------------------------------------------------------------------
// VIP acceleration tuning
// ---------------------------------------------------------------------------

/**
 * Copied from the shipped plugin config. These govern when trial
 * acceleration is offered and how aggressively the token is refreshed.
 */
const VIP_CONFIG = Object.freeze({
    TOKEN_EXPIRE_ADVANCE_SECOND: 300,
    TOKEN_EXPIRE_MIN_SECOND: 20,
    TOKEN_DEFAULT_QUERY_INTERVAL: 300,
    ENABLE_TRY_MIN_SIZE: 209715200,      // 200 MB
    ENABLE_TRY_MAX_PROGRESS: 40,         // percent
    FILE_ENABLE_TRY_MIN_SIZE: 52428800,  // 50 MB
    TRY_INTERVAL: 1800,                  // seconds
    TRY_MAX_PROGRESS: 20,                // percent
    TRY_MAX_SIZE: 1073741824,            // 1 GB
});

// ---------------------------------------------------------------------------
// User status machine
// ---------------------------------------------------------------------------

const USER_STATUS = Object.freeze({
    init: 0,
    loggedIn: 1,
    loggingIn: 2,
    loggedOut: 3,
    loggingOut: 4,
    anonymouslyLoggingIn: 5,
    anonymouslyLoggedIn: 6,
    failed: 7,
});

/** vasType -> human readable tier. */
const VIP_TYPE_MAP = Object.freeze({
    2: "normal",
    3: "platinum",
    5: "super",
});

module.exports = {
    CLIENT_SOCKET_GUID,
    SERVER_CONTEXT_NAME,
    THIRD_CHANNEL_GUID,
    OAUTH_LOGOUT_TAB_GUID,
    CONTEXTS,
    LOGIN_HOSTS,
    LOGIN_CHANNEL_HOSTS,
    ACTIONS,
    ENV,
    SERVER_FUNCTIONS,
    NATIVE_EVENTS,
    KERNEL_EVENTS,
    ENDPOINTS,
    PROTOCOL,
    LOGIN,
    VIP_CONFIG,
    USER_STATUS,
    VIP_TYPE_MAP,
};
