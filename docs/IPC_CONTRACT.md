# 跨进程通信契约（复刻的骨架）

迅雷不用 Electron 自带的单层 `ipcMain`/`ipcRenderer`，而是叠了**三层**通信：

```
第 3 层  @xunlei/async-remote    三端 RPC（主/渲染/插件），带 callServerFunction 抽象
第 2 层  @xunlei/node-net-ipc   本机命名管道 socket，服务端 + 多客户端
第 1 层  Electron ipcMain/ipcRenderer  原生通道（ThunderChannelList 常量表）
```

复刻时**第 1 层必须照抄**（渲染进程直接依赖），第 2/3 层要自己实现等价物。

---

## 1. 命名管道地址（硬编码 GUID，一字不能改）

```js
// 客户端连接用的 pipe 名模板
const tmp = os.tmpdir();
let sock = path.join(tmp,
    `${prefix}-xunlei-node-net-ipc-{FD196984-2591-4588-AA6F-5C8AC1266290}.sock`);

if (process.platform === "win32") {
    sock = sock.replace(/^\//, "").replace(/\//g, "-");
    sock = "\\\\.\\pipe\\" + sock;
}

// prefix 默认 = path.basename(process.execPath, ".exe")
//             = "Thunder"
```

得到实际地址：

```
\\.\pipe\C:-Users-<user>-AppData-Local-Temp-Thunder-xunlei-node-net-ipc-{FD196984-2591-4588-AA6F-5C8AC1266290}.sock
```

### 三个 GUID 的用途

| GUID | 用途 |
|---|---|
| `{FD196984-2591-4588-AA6F-5C8AC1266290}` | **客户端连接通道**（socket 名后缀） |
| `{46105371-DE78-4442-B59F-FDA1D6D7D430}` | **服务端上下文名** `xunlei-node-net-ipc-server-{...}` |
| `{A9C9D760-14E8-42CB-A3CB-9C0A0DDFD732}` | 第三通道（另一个服务端/事件总线） |

前两个在 `main.js`、`plugin-boot.js` 里完全一致 ⇒ **改一个就必须同步改所有进程**。

## 2. 上下文名（`Context` 名字表）

```js
serverContextName     = "xunlei-node-net-ipc-server-{46105371-...-FDA1D6D7D430}"
mainProcessContext    = "main-process"
mainRendererContext   = "main-renderer"
```

`main.js` 里出现的全部上下文名：

```
main-process
main-renderer
login-renderer
pre-new-task-renderer
new-task-renderer
main-page-webview-renderer
```

每个 Electron 渲染进程都会用**自己的名字**注册进这套 IPC。
复刻时必须保持这套命名，否则进程之间找不到对方。

## 3. RPC 调用形态（`async-remote`）

```js
// 主进程 → 渲染进程 / 插件
client.callRemoteClientFunction(targetContext, "FunctionName", ...args)

// 渲染进程 / 插件 → 主进程
client.callServerFunction("ModuleName", "functionName", ...args)
```

实测调用点：

```js
// plugin-boot.js
client.callServerFunction("Log", "plugin-boot", "information", ...msg)
client.callServerFunction("SetPluginStatus", name, "loaded")

// main.js
client.callRemoteClientFunction(CommonIPCBase.mainProcessContext, "SetPosition", n, r)
client.start({ name: CommonIPCBase.mainProcessContext })
client.registerFunctions({ SetTrayImage: (e, ...a) => {...}, FlashTray: (...) => {...} })
```

⇒ `callServerFunction(<模块>, <方法>, ...参数)` 的第一个参数是**服务名**，
是字符串拼接而非枚举 —— 复刻时要注意大小写完全一致（如 `Log` 大写、`SetPluginStatus` 驼峰）。

## 4. Electron 原生通道常量表（`ThunderChannelList`）

渲染进程直接 `ipcRenderer.send(f.ThunderChannelList.channelXXX)`，
所以这张表**必须逐个照抄常量字符串**。实测到的成员：

```
channelRMProcessSend                = RM_PROCESS_SEND（推测）
channelRMGetBrowserStartType
channelMRGetBrowserStartTypeResult
channelRMNewTaskSetBTInfo
channelRMXXX / channelMRXXX         （RM = Renderer→Main，MR = Main→Renderer）

e.channelRMSetEnvironmentVariable   = "RM_SET_ENVIRONMENT_VARIABLE"
e.channelMREmbedPlayerPos           = "MR_EMBED_PLAYER_POSITION"
e.channelRMUpdateLogEnviroment      = "RM_UPDATE_LOG_ENVIRONMENT"
e.channelMRUpdateLogEnviroment      = "MR_UPDATE_LOG_ENVIRONMENT"
e.channelRMBrowserMsg               = "MR_INDIVIDUATION_BROWSER_MSG"
```

**命名规律**：`channelRM*` = 渲染→主，`channelMR*` = 主→渲染，值是 SCREAMING_SNAKE_CASE。
（注意源码里 `Enviroment` 是拼错的，照抄时保留。）

## 5. `CommonIPCBase` 命名空间

```
CommonIPCBase.Communicator          消息监听/分发器（listeners: Map<name, Set>）
CommonIPCBase.mainProcessContext    "main-process"
```

`Communicator` 的行为（从代码读出）：

```js
// 分发：第一个 listener 的返回值作为结果，其余只做通知
emit(msg) {
    const name = msg.name;
    if (!this.listeners.has(name)) return;
    let result, first = true;
    for (const fn of this.listeners.get(name)) {
        if (first) { first = false; result = fn(msg); }
        else fn(msg);
    }
    return result;
}
```

⇒ **第一个注册者拥有"处理权"，后续注册者只被通知**。这是个不常见的设计，复刻时要保留语义。

## 6. 环境变量契约

```
TL_OUTPUT            "console" 时日志走 stdout，否则走文件
TL_MODULE_FILTER     控制加载哪些模块（默认 "all"）
RUN_ENV              "development" 时关闭 webSecurity
DEBUG_ASYNC_REMOTE   设置后 async-remote 的 traceback/info/warn/error 才生效
```

`DEBUG_ASYNC_REMOTE` 的行为很明确：**不设置时，async-remote 的全部日志函数被替换成空函数**。

```js
if (!process.env.DEBUG_ASYNC_REMOTE) {
    const noop = function () {};
    t.traceback = t.time = t.timeEnd = t.trace = t.info
        = t.warn = t.error = t.log = t.assert = noop;
}
```

## 7. 埋点接口（`PerformanceMonitorUtilNS` / `xlstat4`）

```js
// 底层（ThunderHelper.node 的 xlstat4 导出）
xlstat4.trackEvent(key, attr1, attr2, cost1, cost2, cost3, cost4, extDataStr, cookie)

// 上层包装
PerformanceMonitorUtilNS.trackEvent(...)                  → 上报
PerformanceMonitorUtilNS.trackXdasProfileStatEvent(...)   → 上报到 "xdas_profile_stat"
PerformanceMonitorUtilNS.setBugreportCustomInfo(str)
PerformanceMonitorUtilNS.setBugreportSilentMode()
PerformanceMonitorUtilNS.formatBussinessName(name)        → 从 URL 推导业务名
```

`trackEvent` 实现里有个细节 —— **它会先把参数塞进 `global.b`**：

```js
global.b = { key, attr1, attr2, cost1, cost2, cost3, cost4, extDataStr, cookie };
return xlstat4.trackEvent(key, attr1, attr2, cost1, cost2, cost3, cost4, extDataStr, cookie);
```

⇒ `global.b` 是**给崩溃转储用的**（崩溃时能读到最近一次埋点参数）。复刻时如果不需要崩溃上报，可以省。

## 8. 复刻顺序建议

1. **先照抄常量层**：三个 GUID、上下文名表、`ThunderChannelList` 常量。
2. **实现 `node-net-ipc` 等价物**：Node `net.createServer` + Windows named pipe 即可。
3. **实现 `async-remote` 的 `client`**：`callServerFunction` / `callRemoteClientFunction` /
   `registerFunctions` / `start` / `Communicator`（含"第一个 listener 有处理权"的语义）。
4. **最后接 Electron 原生 ipc**：常量照抄，handler 自己写。

这一层做完，7 个 `.node` 才有地方挂 —— 因为 `plugin-boot.js` / `plugin-preload.js`
里所有 `client.callServerFunction(...)` 都依赖它。
