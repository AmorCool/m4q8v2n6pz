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

    /** vas ids requested with getuserinfo; the VIP flags ride along here. */
    LOGIN_VAS_ID: "2,14,33,34,35",

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
    REQUEST_ID_HEADER: "x-request-id",
    DEVICE_ID_HEADER: "x-device-id",
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
    VIP_CONFIG,
    USER_STATUS,
    VIP_TYPE_MAP,
};
