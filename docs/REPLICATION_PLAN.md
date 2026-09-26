# 迅雷 12.1.2.2662 复刻路线图

## 0. 一句话结论

`Thunder.exe` + `XDASKernel.dll` = **一个被改名的完整 Electron 14 运行时**。
复刻不需要逆向任何加密运行时 —— **换一个标准 Electron 14 就能顶掉这两样**。
真正需要自己写的是：JS 外壳（可读，直接照着重写）+ 7 个 `.node` 插件（接口已全部枚举）
+ 下载引擎（用开源方案替换）。

## 1. `XDASKernel.dll` 的导出构成（1524 个，实测）

| 类别 | 数量 | 说明 |
|---|---|---|
| `napi_*` | **136** | **完整 N-API v8 实现** |
| `uv_*` | 274 | libuv 全量 |
| `v8@@` | 320 | V8 C++ API |
| `v8_inspector` | 47 | V8 调试器（DevTools 协议） |
| `node@@` | 18 | Node 内部 |
| zlib（`inflate_*`/`deflate_*`/`crc32`/`adler32`） | ~60 | zlib 静态链入 |
| 入口 | — | **`RunMain`**、`node_module_register`、`GetHandleVerifier`、`IsSandboxedProcess` |

### ★ 为什么这条最关键

`RunMain` 是 **Electron 主进程的标准入口符号**。

复刻的含义：
1. `Thunder.exe` 只做一件事 —— `LoadLibrary("XDASKernel.dll")` 然后调 `RunMain`。
2. `XDASKernel.dll` 就是 `electron.exe` 改名 + 重导出。
3. `.node` 插件通过 `GetProcAddress` 从宿主拿 `v8::*`、`napi_*`、`uv_*`。

**⇒ 复刻可以直接用官方 Electron 14 发行版。** `.node` 只要重新编译
（或改成 N-API —— 因为宿主本来就有 136 个 `napi_*`，N-API 路径完全走得通）。

## 2. 复刻的三个层次

### 第 1 层：Electron 外壳 —— 可完整复刻（工作量：中）

| 文件 | 大小 | 复刻方式 |
|---|---|---|
| `resources/app/package.json` | 147 B | 直接写 |
| `out/main.js` | 368 KB | webpack 产物；**读源码逻辑后自己重写** |
| `out/common-preload.js` | 3.4 KB | 已经解混淆，直接照抄契约 |
| `out/plugin-boot.js` | 69 KB | 插件引导，自己实现 |
| `out/plugin-preload.js` | 50 KB | 同上 |
| `out/*-renderer/` | 10 个 | Vue 2 单页，自己写 |

技术栈（从 manifest 反推，28 个包）：
**Vue 2.5 + Vuex 3 + TypeScript decorator + Babel + webpack**。
UI 库用 `@xunlei/thunder-ui-vue 0.53.3`（私有，需要自己实现等价组件）。

### 第 2 层：7 个 `.node` 插件 —— 按接口重写（工作量：中高）

接口已全部枚举，见 `ARCHITECTURE.md` 第 3 节。逐模块：

| 模块 | 成员数 | 难度 | 复刻建议 |
|---|---|---|---|
| `ThunderHelper` | ~70 | 中 | Win32 系统调用包装 → 直接用 Node 内置模块 + 少量原生补充 |
| `ThunderNewTask` | 4 | 低 | 原生窗口，可用 Electron 的 `BrowserWindow` 替换 |
| `ThunderSuspensionWindow` | 27 | **高** | GDI+ 自绘悬浮球 → 用 Electron 透明无边框窗口 + Canvas 重写 |
| `ThunderKernel` | 106 | **高** | 下载内核门面，见第 3 层 |
| `ThunderMsgChannel` | 小 | 低 | Electron `ipcMain`/`ipcRenderer` 直接替代 |
| `WeakReferences` | 1 | 低 | 只是个 leak monitor，可省 |
| `XDASEnhancerAddon` | 小 | 低 | 埋点，可省 |

**工具链要求**（如果要生成 ABI 兼容的 `.node`）：
- 32 位 MSVC（`machine=0x014c`）
- Electron 14 头文件（V8 9.2 / NODE_MODULE_VERSION 80）
- 或者改用 N-API —— 宿主已导出 136 个 `napi_*`，**推荐这条**

### 第 3 层：下载引擎 —— 只能替换（工作量：高）

`resources/bin/SDK/` 是真正的下载引擎，2.9 MB 的 `DownloadSDK.dll` + 一整套 P2P：

```
DownloadSDK.dll (2.9MB)   DownloadSDKProxy.dll   DownloadSDKServer.exe
TcpImpl.dll     (2.8MB)   XUdt.dll               XLReImport.dll
P2PBase/P2PCommonObjects/P2PFramework/P2PIO/P2PStat/P2PTarget.dll
XLLiveUDownload.dll       XLTaskUpgrade.dll      ProxyVerifier.dll
libcurl.dll  libeay32.dll  ssleay32.dll  minizip.dll
XLFileAssistant.exe  upnp.exe
```

这是迅雷的核心竞争力（P2SP / XUdt 打洞 / DHT / 离线加速），**没有源码，不要尝试逆向**。

**替换方案**：
| 原能力 | 开源替代 |
|---|---|
| HTTP/FTP 多线程下载 | `aria2`（JSON-RPC 控制，最成熟） |
| BT / Magnet | `libtorrent`（`Transmission` 可做无界面后端） |
| eMule | `aMule` 的 `amuled` |
| P2P 打洞 / UPnP | `libtorrent` 自带 + `miniupnpc` |
| 任务数据库 | `better-sqlite3`（因为 JS 侧本来就是直连 SQLite） |

**接口对齐**：把开源引擎包一层适配器，实现 `ThunderKernel.node` 那 106 个成员里
真正被调到的那部分（`createP2spTask` / `createBtTask` / `startTask` / `queryTaskInfo` /
`beginTransaction` / `execSqlite` …）。

## 3. 复刻的推荐做法（按顺序）

1. **先做能跑起来的空壳**：标准 Electron 14 工程 + `main.js` 骨架 +
   复刻 `common-preload.js` 的三条契约（`GlobalDataNS` / `performanceMonitorReporter` / `xlDesktopApplicationSolution`）。
2. **用 N-API 重写 `ThunderHelper`**：它是所有模块的共同依赖，且成员最规整。
   窗口类成员可以先用 Electron `BrowserWindow` 顶，系统信息类用 Node `os` + `child_process` 顶。
3. **`ThunderKernel` 换成 aria2/libtorrent 适配器**，成员名严格对齐。
4. **渲染进程自己写**：10 个 renderer 用 Vue 3 或纯前端重写，不必照抄 Vue 2。
5. **`ThunderSuspensionWindow` 放最后**：它是纯装饰性最强、价值最低的部分。

## 4. 必须精确匹配的东西（否则跑不起来）

```js
// 1. 路径推导 —— 三段目录，正斜杠
GlobalDataNS.getRootDir()     // <install>/resources/app
GlobalDataNS.getProfilesDir() // <install>/profiles   (经 ../../../ 从 rootDir 上来)

// 2. 全局单例，两种进程不同的挂载点
"browser" === process.type ? global.xlDesktopApplicationSolution
                           : window.xlDesktopApplicationSolution
// .GetPerformanceMonitorReport().initPerformanceMonitor(name, opts)

// 3. 原生模块注册协议
//    每个 .node 必须导出 _register_<模块名>_ 和 node_register_module_v80
//    Node 会调用后者，它内部再调前者

// 4. 进程环境变量
//    TL_OUTPUT=console  控制日志输出方式
//    TL_MODULE_FILTER   控制加载哪些模块
//    RUN_ENV=development 关闭 webSecurity
```

## 5. 已知的坑

- **32 位**：全部 PE32。现代 Node/Electron 生态基本已放弃 32 位。
  如果换成 64 位 Electron，所有 `.node` 必须重新编译 —— 反正都要重写，影响不大。
- **`XDASKernel.dll` 不是可选依赖**：`Thunder.exe` 的导入表直接指向它，
  且它含有 V8 导出表。**换成标准 Electron 时，`.node` 的导入表必须重新生成**。
- **插件声明 Electron 9 但跑在 14 上**（`^9.2.1` vs 源码路径显示 14）。
  复刻时统一用 14，不要被 `devDependencies` 误导。
- **`@xunlei/*` 私有包拿不到**：`thunder-ui-vue`、`async-remote`、`node-net-ipc`
  这些需要自己实现。其中 `async-remote`（三端 RPC）是骨架，值得优先复刻。
