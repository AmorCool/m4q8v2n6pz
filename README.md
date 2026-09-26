# ThunderX Rebuild

迅雷桌面客户端的复刻。当前状态：**窗口能开、任务表能画、77 项自检全过**。

这里放的是**我们自己写的一份实现**，按原版客户端的行为契约重写。
不包含任何原版二进制，也不包含解包后的源码副本。

---

## 现在有什么

```
src/main/contract.js        IPC / API / 事件名的全量常量表（照抄原版字面值）
src/main/rpc.js             进程内 RPC 网格（保留原版的元组约定与事件语义）
src/main/login.js           登录三条路径 + 设备指纹 + token 交换
src/main/vip-token.js       VIP 加速凭据签发（密钥派生 + AES-128-ECB 封包）
src/main/kernel.js          下载内核门面（事件名与任务字段照抄）
src/main/engine-aria2.js    aria2 子进程 + JSON-RPC 驱动（见下）
src/main/plugin-host.js     原版插件宿主（不改一行跑原版插件）
src/main/index.js           启动编排，把上面几块接起来
src/main/electron-main.js   唯一的 Electron 入口（窗口、IPC、事件转投）
src/preload/index.js        具名桥（不是转发 ipcRenderer）
src/renderer/               任务表 + 插件视图宿主
scripts/smoke.js            77 项自检
scripts/fetch-engine.js     从 aria2-cross 的 release 拉引擎二进制
config/app.json             应用配置
```

跑起来：

```bash
npm run lint          # 语法检查
npm test              # 80 项自检
npm run engine:fetch  # 拉 aria2c 到 bin/（可选，不拉就回落桩引擎）
npm start             # 开窗口
```

`npm start` 需要 Electron。**只有 `src/main/electron-main.js` 知道 Electron 的存在**，
`index.js` 保持纯 Node，所以自检和无头启动都不依赖它：

```bash
npm run start:headless
```

启动输出：

```
[info] [app] starting, version 12.1.2.2662
[info] [app] device sign computed
[info] [app] started
[thunderx] device sign: div101.<machineId><base64(md5)>
[thunderx] peer id    : <40 hex>
```

---

## 下载引擎：aria2

下载由 **aria2c 子进程**承担，走 JSON-RPC 驱动。用独立进程而不是链接进去，
是为了把 GPL 留在进程边界外面，同时下载器崩了也不会带走界面。

**怎么接上**：跑 `npm run engine:fetch`，它会从 `AmorCool/aria2-cross` 的
release 资源里取对应平台的二进制放进 `bin/`。那个仓库是私有的，所以这条命令
需要一个 token —— 从 `GITHUB_TOKEN` / `GH_TOKEN` 环境变量取，或者回落到
`gh auth token`。都没有时会明说，而不是报一句"仓库还没有 release"（未认证访问
私有仓库，GitHub 答的是 404）。

也可以手工放到下面任意一个位置。

```
bin/aria2c(.exe)                    # 仓库根下，最省事
vendor/aria2/aria2c(.exe)
<resourcesPath>/bin/aria2c(.exe)    # 打包后
```

或者写进 `config/app.json`：

```json
{ "aria2Path": "D:/tools/aria2c.exe" }
```

找不到就自动回落到内置桩引擎，应用照常启动（`npm test` 里有一项专门测这个）。
桩引擎**也会发事件** —— 一个沉默的桩看起来像事件管道坏了，而不是像少了个引擎。

**自动认到的旗标**（需要 Turbo 构建，原版 aria2 会拒绝）：

```
--max-connection-per-server=16   上限由补丁解除，16 是取值不是上限
--split=16
--min-split-size=1K
--retry-on-400 / --retry-on-403 / --retry-on-unknown
```

`-1` **不能**写在这两个连接数选项上。补丁改的是选项处理器里的**上限**
（`NumberOptionHandler(..., "1", 1, 16, 'x')` 的最后一个数字），不是让 `-1`
变成一个合法取值 —— 传 `-1` 时 aria2 直接拒绝启动：

```
errorCode=28 max-connection-per-server must be greater than or equal to 1
```

补丁解除上限的意义是**任务可以要求更多**，引擎自己的默认不擅自加码。

这些旗标来自打补丁的 aria2 源码树，见 `_aria2_x/`。自检里有一项断言旗标名
和补丁后的选项表一致，另一项断言取值合法。

---

## 三个关键还原点

复刻里唯一需要动脑的部分，都已经解出来了。其余都是照着契约写。

### 1. VIP 加速密钥派生

```
key = md5("xl_pc" + buildNo + userId + random)[0:16].toUpperCase()
```

`buildNo` 是纯数字构建号（`12.1.2.2662` → `2662`）。
结果恰好 16 个 ASCII 字符，直接当 AES-128 的 key 用。

`src/main/vip-token.js` 的 `deriveKey()`。

### 2. VIP 加速加密

```
AES-128-ECB，IV = ""（空）
```

请求体：`JSON → UTF-8 bytes → AES`。
响应：`AES⁻¹ → UTF-8 → JSON`，然后字段改名
（`message → detailMessage`，`simple_msg → message`）。

自检里有一条专门验证 ECB 特性：同样的 16 字节明文块加密两次，
密文必须相同。这条断言如果是 CBC 就会失败。

### 3. 登录 token 交换

```
POST /v1/auth/signin/token
{
  provider:      "access_end_point_token",
  signin_token:  <sessionid>,
  client_id:     <clientId>,
  client_secret: <clientSecret>
}
→ { access_token, refresh_token, expires_in }
```

`refresh_token` 缺失时用 `sessionid` 自己兜底。

---

## 目录说明

```
src/main/       客户端主进程代码
src/preload/    渲染层桥
src/renderer/   界面（任务表 + 插件视图宿主）
scripts/        自检与工具
config/         应用配置
docs/           逆向档案（格式、契约、链路）
.github/        CI
```

---

## 当前完成度

| 模块 | 状态 |
|---|---|
| IPC 契约常量表 | 完成 |
| RPC 网格（元组约定 + 事件语义） | 完成 |
| 设备指纹（`div101.` 格式） | 完成 |
| 登录三条路径 | 完成 |
| Session → OAuth2 token 交换 | 完成 |
| VIP 凭据签发（含加密） | 完成 |
| 内核门面 + 事件转发 | 完成 |
| 下载引擎（aria2 子进程 + Turbo 旗标） | **完成，已跑通真实下载** |
| 任务增删改查的 RPC | 完成 |
| 界面（窗口 + 任务表 + 插件视图宿主） | 完成 |
| 插件宿主 | 接口就绪，插件未移植 |
| 打包（安装包） | **未开始** |

「已跑通真实下载」是指自检里那一项：起一个回环 HTTP 服务，用真实 `aria2c`
下 512 KiB 随机数据，逐字节比对。引擎的启动、加任务、轮询、完成事件和关闭
都在这一项里走过。没有 `bin/` 时它会明确说跳过，而不是假装测过。

---

## 下一步

按收益排序：

1. **打包**（electron-builder + NSIS）
   界面能开，引擎能下，缺的是把两者和 `bin/aria2c.exe` 装成一份可分发的产物。
2. **移植 `VipDownload` 插件**（明文未混淆，86 KB）
   它调用的是已经实现好的那几个服务端函数，视图会挂进现有的 `#views` 容器。
3. **插件进程隔离**
   原版插件跑在独立进程，`process.exit()` 只结束插件；同进程会带走整个应用。

---

## 注意

- 所有常量、事件名、字段名的**拼写错误都是故意的**（如 `bAcclerating`、
  `genarateMd5`、`ClickTryAcclerateBtn`）。这些字符串在运行时被逐字比较，
  改了就接不上。
- `protocolVersion` 在网页 SDK 里是 `300`、在客户端插件里是 `301`。
  **不要统一**。
- VIP token 的 RPC 参数顺序 `(taskId, cert, index)` 与内核的
  `(taskId, index, cert)` 不同，换序发生在服务端函数包装层。
  自检里有一条专门验证这个。
- **调一个没注册的方法名不会抛错**，`callServerFunction` 会 resolve 成 `null`
  （元组是 `[null, message]`，unwrap 后就是 `null`）。所以「没这个方法」和
  「方法返回空」在渲染层长得一样 —— 渲染层因此显式列出自己的 void 操作，
  而不是靠返回值判断成功。自检里有两条 pin 住这个行为。
- **渲染层调服务端函数时，前两个参数是 `(调用方 context, 自身 context)`**，
  和插件一样。少传这两个会让所有真实参数**左移两位** —— 这种错看起来像"值不对"
  而不是"调用不对"。`electron-main.js` 的 `rpc` handler 里传了一个占位 context。
- 任务操作的名字在 contract 里，形如 `CreateNewTask` / `PauseTask` / `ResumeTask` /
  `DeleteTask`。**原版没有这些 server function** —— 它的渲染层直接持有内核对象
  调进程内方法。本复刻把内核放在主进程，所以补了这组。名字取自原版自己的
  任务命令（见 `docs/IPC_CONTRACT.md` §8）。
