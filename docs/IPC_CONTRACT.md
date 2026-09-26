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

### 3.1 ★ 纠正确认（第二轮实测，2026-09-26）

上面「第一个参数是服务名」的说法**不准确**。`plugin-boot.js` 里的真实实现是：

```js
// 来自 out/plugin-boot.js
callServerFunction(e, ...t) {
    let n = null, r = yield this.callServerFunctionEx(e, ...t);
    return r && (n = r[0]), n;
}
callServerFunctionEx(e, ...t) {
    return this.internalCallServerFunctionEx(this.client, e, ...t);
}

// 底层发送：{rid, method: e, args: t}
s = (t, n) => { t ? (r([null, t])) : r([n, void 0]) };
```

⇒ 真实语义只有三条：

1. **`e` 是「函数名」，不是「模块名」。** 没有二级分派、没有命名空间。
   `callServerFunction("Log", "plugin-boot", "information", ...)` 是把
   `"plugin-boot"` 当作 **args[0]** 传给一个名叫 `Log` 的注册函数。
2. **`callServerFunction` 返回裸值**（内部取 `r[0]`）；**`callServerFunctionEx` 返回元组**。
   翻过来写会把字符串 `"from-plugin"` 变成 `"f"` —— 这种错很安静，必须两种形态都实现。
3. **元组约定确认**：底层回调 `t ? [null, t] : [n, undefined]`，
   即失败给 `[null, errMessage]`、成功给 `[value, undefined]`。与 `callRemoteClientFunction` 一致。

注册侧语义（同文件实测）：

```js
this.apis = Object.assign({}, this.apis, e);   // 合并，不是替换整个集合
```

⇒ 同名覆盖、其余保留。

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

## 8. 任务操作命令名（★ 2026-09-26 补）

从 `E:\Thunder\Program\resources\app\out\` 的发布包里读出。**这批名字在复刻时必须照抄** ——
它们既是渲染层的命令名，也是主进程要注册的 server function 名。

### 8.1 为什么原版没有把这些做成 server function

原版**渲染层直接持有内核对象**。在 `main-renderer/renderer.js` 里实测到的是
**进程内方法调用**，不是 RPC：

```js
ThunderKernel.deleteTask(...)      // 进程内
ThunderKernel.startTask(...)       // 进程内
ThunderKernel.getTaskBaseInfo(...) // 进程内
```

⇒ 复刻如果把内核放在主进程（`_thunder_git` 就是这么做的），
**必须自己把这组操作暴露成 server function**，否则渲染层无路可走。

### 8.2 任务相关命令名全表

```
CreateNewTask        CreateNewTaskEx      CreatePreNewTaskWindow
CreateTaskDirectly   CreateTaskBase
CreateMagnetTask     CreateBtTask          CreateEmuleTask
CreateGroupTask      CreateDownloadAndPlayTask

DeleteTask           DestroyTaskBase       DestroyBtTask
DestroyEmuleTask     DestroyMagnetTask     DestroyGroupTask

PauseTask            PauseAll              Continue
ReDownload           CancelDownloadCompleteTask
CompletedTaskPlay

BatchFindBtTask      BatchFindEmuleTask    BatchFindGroupTask
AutoBTNewTask        PreDownload           PreDownloading
DetailSaveTask       MoveTask              LoadTaskBasic
```

### 8.3 容易误判成命令名的枚举值

下面这些**是枚举成员，不是 RPC 方法名** —— 搜到它们时不要当成接口：

| 名字 | 实际身份 |
|---|---|
| `DeleteTask` | `TaskStopReason` 枚举：`Manual=0, PauseAll=1, DeleteTask=2, TaskJammed=3` |
| `LoadTaskBasic` | 某个 reason 枚举：`LoadTaskBasic=0, Create=1, Complete=2` |
| `MoveTask` | 某个 reason 枚举：`LowSpeed=4, MaxDownloadReduce=5, MoveTask=6` |

⇒ `DeleteTask` **同时**是命令名和枚举成员。判断方法：看它在
`callServerFunction("...")` 里还是在一个 `e[e.X = n] = "X"` 的映射里。

### 8.4 上下文常量（照抄）

```js
DownloadKernel.TaskStatus            // 任务状态
DownloadKernel.TaskType              // 任务类型
DownloadKernel.TaskError             // 错误码
DownloadKernel.TaskStopReason        // 见 8.3
DownloadKernel.CategroyViewID        // 注意原版拼写就是 Categroy（漏了 o）
DownloadKernel.Downloading
DownloadKernel.CategoryManager       // 分类管理
DownloadKernel.CategoryView
DownloadKernel.TaskManager           // 任务集合
DownloadKernel.ThunderKernel         // 内核对象本体
```

`CategroyViewID` 的拼写错误是**原版就有的**，复刻时若改名会导致对比日志对不上。

---

## 9. 复刻顺序建议

1. **先照抄常量层**：三个 GUID、上下文名表、`ThunderChannelList` 常量。
2. **实现 `node-net-ipc` 等价物**：Node `net.createServer` + Windows named pipe 即可。
3. **实现 `async-remote` 的 `client`**：`callServerFunction` / `callRemoteClientFunction` /
   `registerFunctions` / `start` / `Communicator`（含"第一个 listener 有处理权"的语义）。
4. **最后接 Electron 原生 ipc**：常量照抄，handler 自己写。

这一层做完，7 个 `.node` 才有地方挂 —— 因为 `plugin-boot.js` / `plugin-preload.js`
里所有 `client.callServerFunction(...)` 都依赖它。
