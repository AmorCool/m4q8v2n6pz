/**
 * Settings schema -- the declarative form the settings window renders.
 *
 * Source of truth: the original's `main-renderer/renderer.js:41973-42769`,
 * where `SettingInit.conf.sechema` (the interface tree) and
 * `SettingInit.initConf`'s `formData` (the default values) sit next to each
 * other. Both are copied here into one list so a control's label, its storage
 * path and its default value cannot drift apart the way two parallel tables
 * would.
 *
 * What was dropped from the original shape, and why:
 *
 *   - the Vue component fields (`confCheckbox` and the other twelve `conf-*`
 *     tags). The original resolves those through `generator-view`; this build
 *     has its own renderer, so the tag becomes a plain `type` string.
 *   - the i18n indirection. The original looks labels up in a locale table;
 *     the recovered labels are already Chinese, which is the only locale this
 *     build ships.
 *
 * Every `name` is `${section}-${key}` exactly as the original writes it
 * (`SettingInit.formData`), because `Config.setValue(section, key, value)`
 * splits on the first hyphen and a rename here would silently write to the
 * wrong section. `splitName` below is the one place that split is done.
 *
 * The file is dual-mode on purpose: the main process `require`s it (to merge
 * defaults into `profiles/config.json`), and a page can also load it as a
 * plain script and read `window.SettingsSchema`. Neither side keeps a copy.
 *
 * Types the renderer understands:
 *   checkbox        on/off
 *   checkboxInput   on/off plus a dependent number/text input (children[0])
 *   checkboxSelect  on/off plus a dependent select (children[0])
 *   radio           a row of exclusive options
 *   select          a dropdown
 *   input           free text
 *   number          numeric input (min/max/step)
 *   textarea        multi-line text
 *   directory       text input plus a "浏览" button (PickDirectory)
 *   file            text input plus a "选择" button (PickDirectory kind=file)
 *   list            an array value edited as a comma/line list (rare)
 *   text            a non-editable note
 *
 * `unsupported: true` marks a control the rebuild cannot honour (the browser
 * takeover block needs the BHO helper and its local HTTP service, neither of
 * which exists here). The renderer greys those out rather than hiding them,
 * which is what the spec asks for: "整块（接管设置分类）可以砍掉或置灰".
 */

"use strict";

/** A radio/select option: stored value plus the label shown next to it. */
const opt = (value, label) => ({ value: String(value), label: label });

/** 1..n as select options, for the numeric dropdowns the original uses. */
function range(min, max) {
    const out = [];
    for (let n = min; n <= max; n += 1) out.push(opt(n, String(n)));
    return out;
}

/**
 * The eight top-level categories, in the original's order.
 * Evidence: renderer.js:41973-42769 (the `sechema` array).
 */
const SETTINGS_SCHEMA = [
    {
        id: "basic",
        label: "基本设置",
        items: [
            {
                name: "ConfigNormalSession-ConfigNormal_AutoRun",
                label: "开机启动迅雷",
                type: "checkbox",
                default: true,
            },
            {
                name: "Others-AntiDisturb",
                label: "开启免打扰模式",
                type: "checkbox",
                default: true,
            },
            {
                name: "BossKey-BossKeySwitch",
                label: "启用老板键",
                type: "checkboxInput",
                default: false,
                children: [
                    {
                        name: "BossKey-BossKeyName",
                        label: "快捷键",
                        type: "input",
                        default: "Alt+D",
                    },
                ],
            },
            {
                name: "TaskDefaultSettings-NewTaskDlgWithoutMainWnd",
                label: "新建任务时显示主界面",
                type: "checkbox",
                default: true,
            },
            {
                name: "ConfigNet-ConfigNet_Type",
                label: "下载模式",
                type: "radio",
                default: "1",
                options: [opt(1, "全速下载"), opt(0, "限速下载")],
                // The speed-limit fields only make sense under 限速, so they
                // ride as children and the renderer hides them otherwise.
                children: [
                    {
                        name: "ConfigNet-ConfigNet_Custom_DownloadSpeedChk",
                        label: "限制下载速度",
                        type: "checkbox",
                        default: true,
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_MaxDownloadSpeed",
                        label: "最大下载速度",
                        type: "number",
                        default: "1024",
                        min: 1,
                        max: 102400,
                        unit: "KB/s",
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_UploadSpeedChk",
                        label: "限制上传速度",
                        type: "checkbox",
                        default: true,
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_MaxUploadSpeed",
                        label: "最大上传速度",
                        type: "number",
                        default: "1024",
                        min: 1,
                        max: 102400,
                        unit: "KB/s",
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_Time_Switch",
                        label: "启用限速时段",
                        type: "checkbox",
                        default: false,
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_Time_Begin_Hour",
                        label: "开始时间",
                        type: "select",
                        default: "0",
                        options: range(0, 23),
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_Time_Begin_Minute",
                        label: "开始分钟",
                        type: "select",
                        default: "0",
                        options: range(0, 59),
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_Time_End_Hour",
                        label: "结束时间",
                        type: "select",
                        default: "23",
                        options: range(0, 23),
                    },
                    {
                        name: "ConfigNet-ConfigNet_Custom_Time_End_Minute",
                        label: "结束分钟",
                        type: "select",
                        default: "59",
                        options: range(0, 59),
                    },
                ],
            },
        ],
    },

    {
        id: "pan",
        label: "云盘设置",
        items: [
            {
                name: "ThunderPanPlugin-defaultSavePath",
                label: "默认添加目录",
                type: "select",
                default: "我的云盘",
                options: [opt("我的云盘", "我的云盘")],
            },
            {
                name: "ThunderPanPlugin-lastUsePath",
                label: "自动修改为上次使用的目录",
                type: "checkbox",
                default: true,
            },
            {
                name: "ThunderPanPlugin-defaultDownloadPath",
                label: "下载到本地",
                type: "directory",
                default: "C:\\迅雷下载",
            },
            {
                name: "ThunderPanPlugin-useDefault",
                label: "下载时不再询问",
                type: "checkbox",
                default: false,
            },
            {
                name: "ThunderPanPlugin-MaxUploadTaskNum",
                label: "同时上传任务数",
                type: "select",
                default: "2",
                options: range(1, 10),
            },
            {
                name: "ThunderPanPlugin-MaxDownloadTaskNum",
                label: "同时下载任务数",
                type: "select",
                default: "5",
                options: range(1, 10),
            },
            {
                name: "ThunderPanPlugin-StartCloudStopDownload",
                label: "开始云播时自动暂停下载",
                type: "checkbox",
                default: true,
            },
            {
                name: "ThunderPanPlugin-SetVODCachePath",
                label: "开启智能缓存",
                type: "checkbox",
                default: true,
            },
            {
                name: "ThunderPanPlugin-ShellContextmenu",
                label: '本地文件右键菜单显示"上传到迅雷云盘"',
                type: "checkbox",
                default: true,
            },
        ],
    },

    {
        id: "monitor",
        label: "接管设置",
        // The whole block depends on the BHO helper and the browser extension
        // (ThunderHelper.node plus the 5021 HTTP service, renderer.js:72986).
        // This build has neither, so the controls are shown disabled rather
        // than dropped -- a user can see the feature exists and why it is off.
        unsupported: true,
        unsupportedReason: "需要浏览器接管组件，本版本未提供",
        items: [
            {
                name: "Monitor-MonitorClipBoard",
                label: "接管剪切板",
                type: "checkbox",
                default: true,
            },
            {
                name: "Motitor-MotitorAll",
                label: "接管所有浏览器",
                type: "checkbox",
                default: true,
            },
            {
                name: "Monitor-WatchTraditionLink",
                label: "接管下载类型：传统下载",
                type: "checkbox",
                default: true,
            },
            {
                name: "Monitor-ConfigWatch_Bt",
                label: "BT 下载",
                type: "checkbox",
                default: true,
            },
            {
                name: "EMuleGenericSettings-EMuleWatchLink",
                label: "eMule 下载",
                type: "checkbox",
                default: true,
            },
            {
                name: "MagnetGenericSettings-MagnetWatchLink",
                label: "磁力链接下载",
                type: "checkbox",
                default: true,
            },
            {
                name: "Monitor-ExtendNames",
                label: "下载文件拓展名",
                type: "textarea",
                // The original's `getDefaultExtendNames()`; the recovered list
                // is the common download extensions it hands the BHO.
                default: "torrent,magnet,ed2k,thunder,flashget,qqdl",
            },
            {
                name: "Monitor-ShortcutMonitor",
                label: "快捷键接管",
                type: "checkbox",
                default: true,
            },
        ],
    },

    {
        id: "download",
        label: "下载设置",
        items: [
            {
                name: "TaskDefaultSettings-OpenSilenceDownload",
                label: "一键下载",
                type: "checkbox",
                // Stored as 0/1 rather than a boolean; the renderer keeps the
                // numeric form so the original's readers still understand it.
                default: 0,
                valueType: "number",
            },
            {
                name: "TaskDefaultSettings-DefaultPath",
                label: "下载目录",
                type: "directory",
                default: "",
            },
            {
                name: "TaskDefaultSettings-UseLastCatalog",
                label: "自动修改为上次使用的目录",
                type: "checkbox",
                default: true,
            },
            {
                name: "TaskDefaultSettings-OrignHostThreads",
                label: "原始地址线程数",
                type: "select",
                default: "5",
                options: range(1, 10),
            },
            {
                name: "TaskDefaultSettings-MaxResourceLimit",
                label: "限制全局最大同时下载资源数",
                type: "checkboxInput",
                default: false,
                children: [
                    {
                        name: "TaskDefaultSettings-MaxResourceCount",
                        label: "数量",
                        type: "number",
                        default: "500",
                        min: 1,
                        max: 9999,
                    },
                ],
            },
            {
                name: "TaskDefaultSettings-AwayModeEnabled",
                label: '启用"离开模式"',
                type: "checkbox",
                default: false,
            },
            {
                name: "TaskDefaultSettings-OpenFile",
                label: "下载完成后自动打开",
                type: "checkbox",
                default: false,
            },
        ],
    },

    {
        id: "task",
        label: "任务管理",
        items: [
            {
                name: "ConfigNormalSession-ConfigNormal_AutoStartUnFinishedTask",
                label: "启动迅雷后自动开始未完成任务",
                type: "checkbox",
                default: false,
            },
            {
                name: "ConfigNormalSession-ConfigNormal_MaxRunningTaskCount",
                label: "同时下载的最大任务数",
                type: "select",
                default: "5",
                options: range(1, 50),
            },
            {
                name: "ConfigNormalSession-ConfigNormal_AutoSlowTask2Tail",
                label: "自动将低速任务移动至列尾",
                type: "checkbox",
                default: false,
            },
            {
                name: "ConfigNoLimitDownload-TaskCountAutoAdd",
                label: "全局下载速度低于阈值时自动增加同时下载任务数",
                type: "checkboxInput",
                default: false,
                children: [
                    {
                        name: "ConfigNoLimitDownload-TaskCountAutoAddRate",
                        label: "阈值",
                        type: "number",
                        default: "100",
                        min: 1,
                        max: 102400,
                        unit: "KB/s",
                    },
                ],
            },
            {
                name: "ConfigNoLimitDownload-OpenNoLimitDownload",
                label: "优先下载小于指定大小的任务",
                type: "checkboxSelect",
                default: false,
                children: [
                    {
                        name: "ConfigNoLimitDownload-NoLimitDownloadFileSize",
                        label: "大小",
                        type: "select",
                        default: "30",
                        options: [opt(10, "10 MB"), opt(30, "30 MB"), opt(50, "50 MB"), opt(100, "100 MB"), opt(500, "500 MB")],
                    },
                ],
            },
            {
                name: "ConfigNormalSession-ConfigNormal_AutoDeleteNotExistFile",
                label: '自动删除"文件不存在"的任务',
                type: "checkbox",
                default: false,
            },
        ],
    },

    {
        id: "notify",
        label: "提醒",
        items: [
            {
                name: "ConfigMsg-ConfigMsg_Finish",
                label: "下载完成时右下角弹窗提示",
                type: "checkbox",
                default: true,
            },
            {
                name: "ConfigMsg-ConfigMsg_FailSuggest",
                label: "下载失败时右下角弹窗提示",
                type: "checkbox",
                default: true,
            },
            {
                name: "ConfigMsg-ConfigMsg_PlayWaveWhileFinish",
                label: "下载完成后播放提示音",
                type: "checkbox",
                default: true,
                children: [
                    {
                        name: "ConfigMsg-ConfigMsg_WavePath",
                        label: "提示音文件",
                        type: "file",
                        default: "../../download-complete.wav",
                    },
                ],
            },
            {
                name: "ConfigMsg-ConfigMsg_TodayRecommend",
                label: "显示今日推荐弹窗",
                type: "checkbox",
                default: true,
            },
            {
                name: "UserCommunitySet-radio_id_",
                label: "接收消息通知",
                type: "checkbox",
                default: true,
                // The original suffixes this key with the signed-in user id
                // (`radio_id_<userid>`) when a session exists; the renderer
                // appends it through `userScoped`.
                userScoped: true,
            },
            {
                name: "UserCommunitySet-radio_addNetDiskMessage_id_",
                label: "云盘添加完成和失败时右下角弹窗通知",
                type: "checkbox",
                default: true,
                userScoped: true,
            },
        ],
    },

    {
        id: "float",
        label: "悬浮窗",
        items: [
            {
                name: "ConfigFloatPanel-FloatPanelValue",
                label: "显示悬浮窗",
                type: "radio",
                default: "0",
                options: [opt(0, "总是显示"), opt(1, "下载时显示"), opt(2, "隐藏")],
            },
        ],
    },

    {
        id: "advanced",
        label: "高级设置",
        items: [
            {
                name: "BtGenericSettings-AutoBTNewTask",
                label: "下载种子文件后自动打开新建面板",
                type: "checkbox",
                default: true,
            },
            {
                name: "BtGenericSettings-AssocTorrent",
                label: "启动时关联 BT 种子文件(.torrent)",
                type: "checkbox",
                default: true,
            },
            {
                name: "BtGenericSettings-ConfigBt_SetPortType",
                label: "BT 监听端口",
                type: "radio",
                default: "0",
                options: [opt(0, "自动分配"), opt(1, "手动指定")],
                children: [
                    {
                        name: "BtGenericSettings-ConfigBt_Manul_TcpPort",
                        label: "端口号",
                        type: "number",
                        default: "15000",
                        min: 1024,
                        max: 65535,
                    },
                ],
            },
            {
                name: "DiskCache-DiskCacheSelect",
                label: "下载磁盘缓存",
                type: "radio",
                default: "256",
                options: [opt(128, "128 MB"), opt(256, "256 MB"), opt(512, "512 MB")],
            },
            {
                name: "ConfigNet-ConfigNet_OpenMirrorImageIncreaseSpeed",
                label: "开启镜像服务器加速",
                type: "checkbox",
                default: true,
            },
            {
                name: "ConfigNet-ConfigNet_OpenXunleiP2PIncreaseSpeed",
                label: "开启迅雷 P2P 加速",
                type: "checkbox",
                default: true,
            },
            {
                name: "ProxySetting-ConfigProxy_Type",
                label: "下载代理设置",
                type: "radio",
                default: "0",
                options: [opt(0, "不使用代理"), opt(1, "使用 IE 代理"), opt(2, "自定义代理")],
                children: [
                    {
                        name: "ProxySetting-ConnectType_Hub",
                        label: "迅雷服务器连接",
                        type: "select",
                        default: "直接连接",
                        options: [opt("直接连接", "直接连接"), opt("使用代理", "使用代理")],
                    },
                    {
                        name: "ProxySetting-ConnectType_Http",
                        label: "HTTP 连接",
                        type: "select",
                        default: "直接连接",
                        options: [opt("直接连接", "直接连接"), opt("使用代理", "使用代理")],
                    },
                    {
                        name: "ProxySetting-ConnectType_Ftp",
                        label: "FTP 连接",
                        type: "select",
                        default: "直接连接",
                        options: [opt("直接连接", "直接连接"), opt("使用代理", "使用代理")],
                    },
                    {
                        name: "ConnectType-ProxyName",
                        label: "代理服务器",
                        type: "input",
                        default: "",
                        hint: "host:port，例如 127.0.0.1:7890",
                    },
                ],
            },
            {
                name: "CompletedTaskPlay-LanuchMediaPlayer",
                label: "下载完成视频播放关联",
                type: "radio",
                default: "1",
                options: [opt(0, "播放组件"), opt(1, "迅雷影音"), opt(2, "系统默认")],
            },
            {
                name: "DownloadAndPlay-LanuchMediaPlayer",
                label: "边下边播播放器",
                type: "select",
                default: "0",
                options: [opt(0, "播放组件"), opt(1, "迅雷影音"), opt(2, "系统默认")],
            },
            {
                name: "GenericSettings-AnimationLevel",
                label: "动画等级",
                type: "select",
                default: "1",
                options: [opt(0, "关闭"), opt(1, "流畅"), opt(2, "华丽")],
            },
            {
                name: "Bookmark-ShowBookmarkBar",
                label: "显示书签栏",
                type: "checkbox",
                default: true,
            },
            {
                name: "SearchConfig-EnablePanSearch",
                label: "地址栏搜索包含云盘文件",
                type: "checkbox",
                default: true,
                // An addition of this build, and flagged as one: the original's
                // `SearchConfigNS` module exists (renderer.js:50945) but its
                // keys were not recovered, and the two sources this build can
                // actually serve (local tasks, cloud drive) need a way to be
                // turned off. Local search is always on because it is a local
                // read; the drive half is a network call and needs a session.
            },
            {
                name: "PathAndCategory-historyDownloadPaths",
                label: "下载目录历史",
                type: "list",
                default: [],
                hidden: true,
            },
        ],
    },
];

/**
 * Split a schema `name` into its storage path.
 *
 * `Config.setValue(section, key, value)` is addressed as two arguments while
 * the schema carries one hyphen-joined string, so this is the join between
 * them. Splitting on the FIRST hyphen is what the original does: keys such as
 * `radio_addNetDiskMessage_id_` contain no hyphen, but a future key could, and
 * splitting on the last one would then pick the wrong section.
 *
 * @param {string} name
 * @returns {{section: string, key: string}}
 */
function splitName(name) {
    const text = String(name || "");
    const at = text.indexOf("-");
    if (at < 0) return { section: text, key: "" };
    return { section: text.slice(0, at), key: text.slice(at + 1) };
}

/** Flatten the tree (categories -> items -> children) into one item list. */
function flattenItems(schema) {
    const out = [];
    const walk = (items) => {
        for (const item of items || []) {
            out.push(item);
            if (item.children) walk(item.children);
        }
    };
    for (const category of schema || SETTINGS_SCHEMA) walk(category.items);
    return out;
}

/**
 * `{ "section.key": default }` for every control, which is the shape
 * `ConfigStore` merges over the file on disk.
 *
 * Children are included even when they are `hidden`, because a hidden control
 * is still a stored key the rest of the client reads.
 */
function defaultValues(schema) {
    const out = {};
    for (const item of flattenItems(schema)) {
        const { section, key } = splitName(item.name);
        if (!section || !key) continue;
        out[`${section}.${key}`] = item.default;
    }
    return out;
}

/** Every category's item count, for the schema-coverage report and tests. */
function countKeys(schema) {
    return flattenItems(schema).length;
}

/**
 * A copy of the schema with `section` and `key` filled in on every item.
 *
 * The settings page is a separate window and receives the schema over the
 * transport, so it would otherwise have to repeat `splitName` -- and two
 * implementations of "split on the first hyphen" is exactly the kind of
 * duplication that drifts. Doing it once here means the page only ever sees
 * the two halves it needs.
 *
 * A copy, not the constant itself: the transport serialises it anyway, but
 * annotating in place would mutate the module's own table for every later
 * reader.
 */
function annotate(schema) {
    const walk = (items) => (items || []).map((item) => {
        const { section, key } = splitName(item.name);
        const copy = Object.assign({}, item, { section, key });
        if (item.children) copy.children = walk(item.children);
        return copy;
    });
    return (schema || SETTINGS_SCHEMA).map((category) =>
        Object.assign({}, category, { items: walk(category.items) })
    );
}

const api = {
    SETTINGS_SCHEMA,
    splitName,
    flattenItems,
    defaultValues,
    countKeys,
    annotate,
    range,
    opt,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.SettingsSchema = api;
