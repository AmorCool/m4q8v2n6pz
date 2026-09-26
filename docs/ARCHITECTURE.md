# 架构对照

原版分成三层，复刻保持同样的分层，但把原生层换成 JS 实现。

---

## 层对照

```
                    原版                          复刻
─────────────────────────────────────────────────────────────────
第 1 层   Electron 14 外壳（XDASKernel.dll）   src/main/index.js
          14 个渲染进程                          （先单进程，后续按需拆）
          205 个业务模块

第 2 层   7 个 N-API 插件（.node）              src/main/kernel.js（门面）
          ThunderKernel / ThunderHelper 等       + 可替换的 engine

第 3 层   DownloadSDK.dll                      engine 接口
          DownloadSDKServer.exe（独立进程）      （aria2 / libtorrent 待接入）
```

---

## 为什么可以换掉第 2、3 层

`ThunderKernel.node` 是一个 **N-API 插件**，它对 JS 侧只暴露一组函数名。
只要函数名、参数顺序、事件名一致，底下怎么实现都行。

复刻把这个边界画在 `src/main/kernel.js`：

```js
class ThunderKernel extends EventEmitter {
    setUserInfo(userId, token)
    setGlobalExtInfo(info, flag)
    applyVipInfo(vipInfo, userChannel)      // 便利方法，拼格式串

    addTask(spec) -> taskId
    removeTask(taskId)
    startTask(taskId) / pauseTask(taskId)
    getTask(taskId) / getAllTasks()

    enableDcdnWithVipCert(taskId, fileIndex, cert)
    updateDcdnWithVipCert(taskId, fileIndex, cert)
    disableDcdnWithVipCert(taskId, fileIndex)
}
```

底下挂一个 `engine`，接口只有 9 个方法：

```
addTask(spec)  removeTask(id)  start(id)  pause(id)
setUserInfo(uid, tok)  setGlobalExtInfo(str, flag)
enableDcdn(id, idx, cert)  updateDcdn(...)  disableDcdn(...)
```

事件从 engine 回抛，`kernel.js` 负责改写成原版的事件名。

---

## 第 1 层：外壳

原版 14 个渲染进程：

```
main-renderer            主界面（6.5 MB bundle，205 个模块）
login-renderer           登录窗
pre-new-task-renderer    新建任务（解析阶段）
new-task-renderer        新建任务（确认阶段）
bt-task-renderer         BT 任务详情
dropdown-file-renderer   下拉文件列表
embedded-browser-renderer 内嵌浏览器
message-box-renderer     消息框
modifier-userinfo-renderer 用户信息编辑
notification-renderer    通知
personal-info-renderer   个人中心
search-renderer          搜索
suspension-renderer      悬浮窗
suspension-xdas-renderer 悬浮窗（统计）
retry-login-renderer     重试登录
```

复刻先做**单进程**，因为这些渲染进程之间靠 RPC 通信、没有共享内存，
拆开只是性能优化，不影响正确性。

`rpc.js` 的 `createMesh()` 已经把 7 个上下文节点建好了：

```
server          服务端（回答函数调用）
main-process    主进程
main-renderer   主界面
login-renderer  登录
vip-download-webview    VIP 插件宿主
pre-new-task-renderer   新建任务
new-task-renderer       新建任务确认
main-page-webview       主页面 webview
```

---

## 第 2 层：插件

原版 7 个 N-API 插件（PE32 / VS2015 / 未剥离 PDB）：

| 插件 | 大小 | 作用 |
|---|---|---|
| `ThunderKernel.node` | 1.28 MB | 内核桥（106 个成员） |
| `ThunderHelper.node` | 1.04 MB | 基础工具，所有插件都依赖 |
| `ThunderSuspensionWindow.node` | 1.63 MB | 悬浮窗 |
| `ThunderNewTask.node` | 183 KB | 新建任务 |
| `ThunderMsgChannel.node` | 179 KB | 消息通道 |
| `XDASEnhancerAddon.node` | 258 KB | 统计增强 |
| `WeakReferences.node` | 103 KB | 弱引用辅助 |

JS 插件（`resources/app/plugins/`）：

```
ThunderXLogin        登录窗（明文 bundle，208 KB 源码）
User                 用户/token（含 sourcemap，可还原 314 个源文件）
VipDownload          VIP 加速 UI（明文未混淆，86 KB）
VipPluginController  VIP 插件控制（217 KB）
ThunderPanPlugin     云盘（3.4 MB）
XmpPlugin            媒体播放
Centertip            提示
ThunderXWebXDAS      统计
```

`index.js` 的 `loadPlugin()` 定义了插件装载契约：

```js
const entry = require(path.join(pluginPath, manifest.main));
const registered = await entry({
    contract,
    log,
    client,                    // RPC 节点
    registerFunctions,         // 注册自己
    callServerFunction,        // 调服务端
});
```

---

## 第 3 层：下载内核

原版 `SDK/` 目录 28 个 DLL，按协议分：

```
Http.dll        240 KB    → 复刻用 Node fetch / undici
Ftp.dll         168 KB    → basic-ftp
P2PBase.dll     1.26 MB   → libtorrent 或 aria2
P2PFramework.dll 483 KB   → 同上
XUdt.dll        634 KB    → 放弃（迅雷私有协议）
XLLiveUDownload.dll 129 KB → 放弃（直播下载）
upnp.exe        133 KB    → nat-upnp
DownloadSDK.dll 2.98 MB   → 整体替换
```

进程模型：

```
原版：主进程 → DownloadSDKProxy.dll → DownloadSDKServer.exe（独立进程）
复刻：主进程 → engine（同进程或子进程）
```

---

## 数据流：一次 VIP 加速下载

```
1. 用户新建 BT 任务
   UI → kernel.addTask(spec) → taskId

2. 下载开始，需要加速
   VipDownload 插件 → callServerFunction("EnableDcdnWithVipCert", taskId, cert, index)

3. 但先要有 cert
   ↓ vip-token.js
   userId   ← GetUserID
   peerId   ← GetPeerID
   isVip    ← GetVipInfo
   key      = md5("xl_pc" + buildNo + userId + timestamp)[0:16].upper()
   body     = AES-128-ECB(JSON({peer_id, infohash, bt_title, task_infos}), key)
   POST http://ali.pc-x.speed.auth.vip.xunlei.com/speed/speedup?<query>
   cert     = decrypt(resp) 并改名 message/simple_msg

4. cert 交给内核
   ↑ kernel.enableDcdnWithVipCert(taskId, index, cert)

5. 内核事件回抛
   engine.emit("task-dcdn-status-changed") → kernel → "OnTaskDcdnStatusChanged"
   → 渲染进程更新 UI
```

第 3 步的那个换序要注意：RPC 收 `(taskId, cert, index)`，
内核要 `(taskId, index, cert)`。换序在 `index.js` 的服务端函数里做。

---

## 已知的取舍

| 原版能力 | 复刻状态 |
|---|---|
| HTTP / FTP / BT / 磁力 | 可做，用现成库 |
| P2SP 私有加速 | 不可做（服务端索引） |
| 离线下载 | 不可做（服务端能力） |
| UDT 传输 | 放弃 |
| 直播下载 | 放弃 |
| 调度器配置（`.xta`） | 跳过，自己写简单调度 |
| 网络探测（NCE） | 可选，不影响功能 |

---

## 与档案的对应

详细证据在 `docs/`：

```
docs/IPC_CONTRACT.md          通信契约（GUID、上下文名、动作名）
docs/LOGIN_CHAIN.md           登录全链路（含源码位置）
docs/VIP_ACCELERATION.md      VIP 加速全链路（含加密算法）
docs/SDK_AND_CONTAINER.md     SDK 目录与 XLTP 容器格式
docs/ARCHITECTURE.md          三层架构总览
docs/MODULE_MAP.md            主界面 205 个模块分组
docs/BOOT_CHAIN.md            启动链证据
docs/NATIVE_EVIDENCE.md       PE 头 / PDB / 导入表
docs/REPLICATION_PLAN.md      复刻路线图
```
