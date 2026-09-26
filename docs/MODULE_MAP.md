# 主界面（main-renderer）功能地图

从 `main-renderer/renderer.js`（6.5 MB）里 `getLogger("<name>")` 反推出来 ——
每个业务模块都为自己起了一个 logger 名，这等价于一份**模块清单**。

**共 205 个模块。** 这是复刻时的工作量基线。

---

## 按功能域分组

### 1. 下载内核与任务管理（核心，约 40 个）

```
DownloadKernel.*                       11 个
    ThunderKernel         TaskManager      CategoryManager
    CategoryView          Category         TaskUserData
DownloadMgr              DownloadStore        DownloadDataManager
DownloadList             DownloadCategory     DownloadKernelManager
download-dispatch        download-jammed      download-detect-tools
sdk-download             task-helper          task filter
TaskCtrlHelper           TaskChart
TaskDetail               task-detail          task-detail-Attribute
task-detail-FileList     task-detail-ZipFileList
dltab_detail_detail
DownloadMode             groupStore           GroupAccelerate
DownloadPanel            DownloadPanel.DownloadingItem
DownloadPanel.ToolBarVipButton
download-panel-thunderPanTask                download-tool-bar
Thunder.TaskOperator
```

### 2. 浏览器 / Tab / 内嵌网页（约 10 个）

```
Thunder.MainRenderer.Tabs / TabsBrowser / view.tabs
Browser                  Browser.Support      Browser.Config.Helper
BrowserConfigGuide       EmbeddedBrowserManagerNs
EmbeddedNativeFunction   Thunder.Main.Renderer.Embedded.Browser
XlTab.view               address-bar          main-body
book-marks-store         home-page
```

### 3. 登录 / 账号（约 12 个）

```
login-helper  login-area  login-option  login-prompt
CommonLoginHelper        PhoneAuth            ScanCode
scancode      Sign        UserHelper
NativeFunction.Login     plugin-function-Login
```

### 4. VIP / 会员（约 15 个）

```
xmp-vip-plugin-helper    xmp-vip-download-kernel-helper
xmp-vip-fs-utilities     xmp-vip-json-crypto   xmp-vip-tools-utilities
vip-renewicon            vip-label-config      vip-plugin-switch-config
vip-stat-utilities       XmpPlayTry            XmpUnionNS
VipDownload:token-query  track-stat-xmp-vip
StartCloudStopDownload   ThunderUnionYunFetchBackNS
```

### 5. 广告 / 推广（约 10 个）—— 迅雷的主要收入来源

```
ad-platform-vue      adplatform-manager   AdPlatform
AdHelperNS           AdFunctionalTips     AdLeftBottomHelper
AdMarketTips         AdWebPageTips        GetCoinPrizeToast
Activity             News-Popup           WebPageTip
```

### 6. 浏览器辅助功能

```
Thunder.ContextMenu / ConTextMenu / MenuContextHelper / MenuSkinNS
ClipBoardNS          History            HistoryDataNS
SubtiteManager       SubtiteManager     ThunderBirdKey
BaiduDWZ             FetchRes           url / url.helper
WallpaperManager     GetSkinInfo        common/skin
```

### 7. 播放 / 预览（边下边播）

```
Thunder-Preview      Preview-Data       video-state
DownloadAndPlayHelper [DownloadAndPlayNS]
FileMediaInfoOss
```

### 8. 社区 / 评论

```
Community  CommunityStore  CommunityNaviteFunction
comment    comment-input
ShouleiSync  ShouleiShareLink  ShouleiInstallImg
SyncMsgHelper
```

### 9. 设置 / 配置

```
Config  ConfigHandler  config-modules  config-remote-global
SettingConfigHelper  setting-conf  setting-center-view  conf-select
ErrorCodeConfig(errorcode-config)   BHOConfig  BHOConfigHttpServer
BindConfigNS  UploadConfig
```

### 10. 插件系统

```
Thunder.plugin-loader    plugin-function    plugin-ui
plugin-ui-webview        plugin-updater     ScheduleTaskPluginFunction
ConfigRemoteGlobalPluginFunction
NotificationPluginFunction
```

### 11. 通知 / 提示

```
notification  NotificationHelper  NotificationNaviteFunction
ToastNotifyManager  pop-mutual  msg-queue  run-prompt
magnet-listener
```

### 12. 原生能力桥（`NativeFunction.*`）—— 需要 `.node` 支持的部分

```
NativeFunction.Login       NativeFunction.TaskInfo
NativeFunction.TaskInfoHistory
DKNativeFunction           SkinNaviteFunction
CommunityNaviteFunction    ConfigNaviteFunction
ConfigRemoteGlobalNaviteFunction
EmbeddedNativeFunction     NotificationNaviteFunction
```

### 13. 其它

```
PrivateSpace  Thunder.PrivateSpaceHelper      ← 私人空间（加密）
diskimage-helper                              ← 镜像挂载
quit-create-shortcut  quit-promises           ← 退出清理
Sign  Thunder.ShouldLogin                     ← 登录态判断
XLStat  statCoreEvent  async-remote-call      ← 埋点 / RPC
MainRendererHelper  system-buttons  tool-bar  StatusBar
main-top-search  search-renderer              ← 搜索
Axios.Helper  Thunder.shub[-http].http-session  ← HTTP
```

## 主进程侧（`main.js`，15 个模块）

```
Thunder.Main                      主进程入口
ThunderNewTask / main-thundernewtask   新建任务窗口
RoundRectWindow                   圆角窗口管理
Thunder.base.tools-utilities      工具
Thunder.base.fs-utilities         文件系统
Thunder.Util / async-remote-call  RPC
HistoryDataNS                     历史数据
SearchWindows                     搜索窗
path-selector                     路径选择
LoginUI                           登录 UI
main-suspension                   悬浮窗
GetSkinInfo                       皮肤
XLStat                            埋点
```

## 复刻工作量估算

| 类别 | 模块数 | 占比 | 说明 |
|---|---|---|---|
| 下载核心 | 40 | 20% | **必须实现**，对接替换后的引擎 |
| 浏览器/Tab | 10 | 5% | Electron `BrowserView` / `webContents` 直接做 |
| 登录/账号 | 12 | 6% | 需要自己的账号后端 |
| VIP/会员 | 15 | 7% | 商业功能，复刻时可省 |
| 广告 | 10 | 5% | **建议省掉** |
| 设置/配置 | 12 | 6% | 配置中心，必做 |
| 插件系统 | 9 | 4% | 架构骨架，必做 |
| 通知/提示 | 8 | 4% | 基础 UI，必做 |
| 播放/预览 | 6 | 3% | 可选 |
| 社区/评论 | 8 | 4% | 可省 |
| 原生桥 | 10 | 5% | 接口层，必做 |
| 其它 | 65 | 31% | 分散 |

**结论**：复刻一个"能用"的迅雷，核心是 **下载核心 40 + 原生桥 10 + 配置 12 + 插件系统 9 + 通知 8 ≈ 80 个模块**，
其余 125 个是增值/运营功能，可以不做。

## 需要注意的一点

`getLogger` 名字是**开发者随手起的**，有重复语义（`ConTextMenu` 拼写错误 vs `Thunder.ContextMenu`、
`SubtiteManager` 疑似 `SubtitleManager` 拼错、`Shoulei*` 疑似 `Shoulei` 拼音）。
复刻时不必照抄命名，但可以据此判断**模块划分的粒度**。
