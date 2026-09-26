# 下载引擎：aria2 替换方案

用户决定用 aria2 做下载内核。这份档案记录**为什么可行、怎么接、以及对不齐的地方**。

对应代码：`_thunder_git/src/main/engine-aria2.js`
对应构建：`_aria2_x/`（独立仓库 `AmorCool/aria2-cross`）

---

## 1. 结论先行

原版迅雷的下载内核是 `DownloadSDK.dll` + `DownloadSDKServer.exe` 一套私有实现
（见 `SDK_AND_CONTAINER.md`），无法复刻。aria2 能覆盖**协议层**，但覆盖不了
**P2SP 私有索引**和 **VIP 带宽池** —— 这两个是服务端资产。

| 能力 | aria2 | 说明 |
|---|---|---|
| HTTP/HTTPS | ✓ | |
| FTP | ✓ | |
| BitTorrent | ✓ | DHT / magnet / tracker 齐全 |
| Metalink | ✓ | |
| 多线程分片 | ✓ | Turbo 补丁后无连接数上限 |
| 断点续传 | ✓ | session 文件 |
| RPC 控制 | ✓ | JSON-RPC 2.0 |
| P2SP 私有索引 | ✗ | 服务端资产 |
| VIP 加速（DCDN） | ✗ | 服务端产品 |
| 离线下载 | ✗ | 服务端资产 |

⇒ **能复刻的是"下载器"，复刻不了的是"迅雷的下载网络"。**

---

## 2. Turbo 补丁（`_aria2_x/patch/`）

"无限制版"的全部秘密就是 4 个补丁，**纯 C++ 改动，跨平台通用**。

| 补丁 | 改动 | 效果 |
|---|---|---|
| `0001` | `max-connection-per-server` 上限 `16` → `-1` | 单服务器连接数无上限 |
| `0001` | `min-split-size` 下限 `1M` → `1K` | 分片更细 |
| `0001` | `piece-length` 下限 `1M` → `1K` | 同上 |
| `0002` | 3 处 `DL_ABORT_EX` → `DL_RETRY_EX` | 慢速/断连/TLS 失败改为重试 |
| `0003` | 新增 `--retry-on-400/403/406/unknown` | 4xx 可重试 |
| `0004` | `--no-want-digest-header` 默认 true | 规避不支持该头的服务器 |

**已验证**：4 个补丁全部干净应用到 aria2 1.37.0 官方 tarball，且效果确实落地
（`OptionHandlerFactory.cc` 里 `1, -1`、`1_k`、`A2_V_TRUE`；`prefs.cc` 里 4 个新
PrefPtr）。

---

## 3. 任务模型映射

```
迅雷                               aria2
------------------------------    ------------------------------------------
task（一个下载）                  ？一个 gid；BT 种子对应多个
taskId（字符串，我们生成）          gid（十六进制字符串，aria2 生成）
任务内多文件进度                    GID 上的 files[]
"加速中"（DCDN）                   无对应物
```

### 3.1 taskId 与 gid 的关系

**taskId 是我们自己的、稳定的**；gid 不稳定（aria2 重启就变）。所以维护两张表：

```js
this.gidByTask = new Map();   // 我们的 taskId -> gid
this.taskByGid = new Map();   // gid -> 我们的 taskId
```

对外**只暴露 taskId**，gid 只在这个模块内部用。

### 3.2 addTask 是同步返回的

```js
addTask(spec) {
    const taskId = `task-${Date.now()}-${++this.taskCounter}`;
    this.emit("task-inserted", { taskId, status: QUEUED, ... });
    this._addToAria2(taskId, spec, options).catch(...);   // 异步补 gid
    return taskId;                                        // 立刻返回
}
```

**为什么**：内核和调用方会立刻存这个 id。等 RPC 回来再返回会把整条调用链
变成异步，而原版是同步的。

---

## 4. 字段翻译（易错点全在这）

aria2 的数值字段**全都是字符串**，这是最容易踩的坑。

```js
totalLength: "1000"    →   Number(...)  →  1000
```

不转的后果：`"1000" + 1 === "10001"`，UI 上数字就废了。

| 迅雷字段 | aria2 来源 | 处理 |
|---|---|---|
| `taskId` | 我们自己生成 | |
| `gid` | `gid` | |
| `status` | `status` 字符串 | 查 `ARIA2_STATUS_MAP`，未知回退 `QUEUED` |
| `taskType` | 有无 `bittorrent` 块 | BT → `2`，否则 `1` |
| `infoId` | `infoHash` | **必须大写** |
| `btTitle` | `bittorrent.info.name` | |
| `files[].fileSize` | `files[].length` | 字符串转数字 |
| `files[].fileName` | `files[].path` | 取 basename |
| `progress` | 自算 | `total > 0 ? completed/total : 0` |
| `downloadSpeed` | `downloadSpeed` | 字符串转数字 |
| `etaSeconds` | `eta` | **速度为 0 时置 null** |
| `errorCode` | `errorCode` | 字符串转数字 |
| `bAcclerating` | 无 | 由 VIP 路径填，默认 false |
| `dcdnFileIndex` | 无 | 同上，默认 -1 |

### 4.1 `infoId` 为什么必须大写

客户端**用 infoId 去重**（同一个种子加两次要识别出来）。aria2 给的可能是小写，
不上大写就会**重复添加**而不是被识别。

### 4.2 `etaSeconds` 为什么要判速度

aria2 在速度为 0 时会返回一个**巨大哨兵值**（`4294967295`）。直接透传，UI 会显示
公元 50000 年。

```js
const etaSeconds = speed > 0 && Number.isFinite(eta) && eta > 0 ? eta : null;
```

### 4.3 `progress` 为什么要判 0

磁力链接在拿到 metadata 前 `totalLength === 0`。`0/0` 是 `NaN`，UI 会显示 "NaN%"。

---

## 5. 状态映射

```js
const ARIA2_STATUS_MAP = {
    active:  TASK_STATUS.DOWNLOADING,   // 1
    waiting: TASK_STATUS.QUEUED,        // 0
    paused:  TASK_STATUS.PAUSED,        // 2
    complete:TASK_STATUS.COMPLETED,     // 3
    error:   TASK_STATUS.FAILED,        // 4
    removed: TASK_STATUS.FAILED,        // 4
};
```

未知状态**回退到 `QUEUED` 而不是抛错** —— aria2 将来加新状态不该让客户端崩。

---

## 6. 进程模型

```
Electron 主进程
  └─ Aria2Engine
       └─ spawn(aria2c)  ← 子进程，通过 JSON-RPC 通信
            └─ 127.0.0.1:<随机端口>
```

**为什么用子进程而不是链接静态库**：

1. aria2 是 **GPLv3**，跑独立进程是最干净的边界处理（这也是 iOS 侧同时出
   可执行文件的原因）
2. 下载器是**最容易被系统杀掉、最容易卡死**的组件，独立进程崩了不带 UI 一起走

### 6.1 端口是随机分配的

```js
server.listen(0, "127.0.0.1", ...)  // 让 OS 分配
```

写死端口会导致两个实例冲突。绑 0 再读回来是**唯一无竞态**的做法。

### 6.2 鉴权

aria2 的 JSON-RPC 用 `token:` 前缀传 secret，secret 是启动时随机生成的
24 字节 hex：

```js
params: [`token:${this.secret}`, ...params]
```

---

## 7. 轮询而不是通知

aria2 支持 WebSocket 推送，这里用**轮询**：

```js
this.pollInterval = 1000;   // 1 秒
```

**理由**：
- `tellActive` + `tellWaiting` + `tellStopped` **一次批量拿全部任务**，是 1 个 RTT
- 通知模式需要第二个客户端和一套新 framing，1 秒间隔下 UI 上看不出差别

### 7.1 只在"UI 关心的字段"变化时发事件

aria2 **每次轮询都会报一个新的 `downloadSpeed`**，直接比对整个对象会导致每秒
都发事件。

```js
const changed = !previous ||
    previous.status !== mapped.status ||
    previous.completedSize !== mapped.completedSize ||
    previous.downloadSpeed !== mapped.downloadSpeed ||
    previous.connections !== mapped.connections;
```

---

## 8. aria2 启动参数

```js
"--max-connection-per-server=-1",   // Turbo 补丁；原版会被夹到 16
"--min-split-size=1K",              // Turbo 补丁
"--retry-on-400=true",              // Turbo 补丁 0003
"--max-tries=0",                    // 无限重试
"--continue=true",
"--save-session=...", "--input-file=...",   // 断点续传
"--force-save=true",
"--seed-time=0",                    // 下载客户端不做种
"--follow-torrent=mem",
"--quiet=true", "--summary-interval=0",
```

**注意**：这些 Turbo 参数**只有本仓库编出来的 aria2 认**。所以引擎只搜
**随 App 打包的二进制**，不走 PATH —— 用户自己装的 aria2 会静默把连接数夹到 16，
而这是个看不出来的性能差异。

### 8.1 aria2 的搜索顺序

```js
config.aria2Path                                  // 显式配置
<APP_ROOT>/bin/aria2c[.exe]                       // 打包位置
<APP_ROOT>/vendor/aria2/aria2c[.exe]
process.resourcesPath/bin/aria2c[.exe]            // Electron 打包后
```

**都找不到就用 stub** —— App 照常启动，UI 可达。这是刻意的降级，不是失败。

---

## 9. DCDN / VIP 的处理

aria2 **没有对应能力**。做法是**记录 + 发事件**，让内核的账本保持真实：

```js
enableDcdn(taskId, fileIndex, cert)   → _dcdn.set(...) + emit("task-dcdn-status-changed")
disableDcdn(taskId)                   → _dcdn.delete(...) + emit(...)
```

**不假装实现了加速**。UI 需要那个"加速中"角标，所以标志位要有；但真实速度提升
是服务端产品，客户端复刻不出来。

---

## 10. iOS / Windows 构建要点

见 `_aria2_x/README.md`，这里只记三个**踩过的坑**：

### 10.1 OpenSSL 交叉编译到 MinGW 必须用 `--cross-compile-prefix`

```sh
./Configure --cross-compile-prefix=x86_64-w64-mingw32- --prefix=... mingw64
```

**只给 target 名不给 prefix** → configure 能过，链接必挂。来自上游
`mingw-build-memo`（嗯，上游这个文件叫 "memo"，拼写如此）。

### 10.2 Ubuntu 的 mingw-w64 默认是 win32 线程模型

win32 模型**没有 `std::thread`**。aria2 用了，所以链接会报一堆 undefined
`std::thread` 符号 —— 报错和代码毫无关系，极难联想。

```sh
sudo update-alternatives --set x86_64-w64-mingw32-gcc /usr/bin/x86_64-w64-mingw32-gcc-posix
```

### 10.3 解压器必须按 URL 后缀选，不能"依次试"

```sh
# ✗ 错的
curl ... | tar -xJ || curl ... | tar -xz || curl ... | tar -xj

# ✓ 对的
case "$url" in
    *.tar.xz)  flag="-J" ;;
    *.tar.gz)  flag="-z" ;;
    *.tar.bz2) flag="-j" ;;
esac
curl -o "$archive" "$url" && tar -x "$flag" -f "$archive"
```

**为什么**：`tar -J` 对着 gzip 流会**先消费掉一部分再失败**，后续尝试读到的是
截断数据，最后一次什么都没有。curl 于是报
`(23) Failure writing output to destination` —— 指向网络，实际是解压器的错。
接着构建继续跑进**空目录**，`make install` 报 "No rule to make target"。

**这个坑我实际踩了**（CI 第二轮），所以记下来。

---

## 11. 复刻优先级

| 项 | 状态 | 说明 |
|---|---|---|
| 协议层（HTTP/FTP/BT/磁力） | ✅ | aria2 全覆盖 |
| 多线程 + Turbo | ✅ | 补丁已验证 |
| 断点续传 | ✅ | session 文件 |
| 任务模型映射 | ✅ | 14 项测试 |
| 事件契约 | ✅ | 名字与字段对齐 |
| RPC 控制 | ✅ | JSON-RPC 2.0 |
| P2SP 私有索引 | ❌ | 服务端资产 |
| VIP 带宽池 | ❌ | 服务端资产 |
| 离线下载 | ❌ | 服务端资产 |
