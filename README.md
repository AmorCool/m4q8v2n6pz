# ThunderX Rebuild

迅雷桌面客户端的复刻。当前状态：**骨架可跑，50 项自检全过**。

这里放的是**我们自己写的一份实现**，按原版客户端的行为契约重写。
不包含任何原版二进制，也不包含解包后的源码副本。

---

## 现在有什么

```
src/main/contract.js    IPC / API / 事件名的全量常量表（照抄原版字面值）
src/main/rpc.js         进程内 RPC 网格（保留原版的元组约定与事件语义）
src/main/login.js       登录三条路径 + 设备指纹 + token 交换
src/main/vip-token.js   VIP 加速凭据签发（密钥派生 + AES-128-ECB 封包）
src/main/kernel.js      下载内核门面（事件名与任务字段照抄）
src/main/index.js       启动编排，把上面几块接起来
scripts/smoke.js        50 项自检
config/app.json         应用配置
```

跑起来：

```bash
npm run lint     # 语法检查
npm test         # 50 项自检
npm start        # 启动
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
src/            客户端主进程代码
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
| 内核实体（真正的下载引擎） | **未开始** |
| 插件宿主 | 接口就绪，插件未移植 |
| 界面 | **未开始** |

---

## 下一步

按收益排序：

1. **接一个真实下载引擎**（aria2 子进程或 libtorrent）
   内核门面已经定义好了，只要实现 `engine` 接口就能跑通真实下载。
2. **移植 `VipDownload` 插件**（明文未混淆，86 KB）
   它调用的是已经实现好的那几个服务端函数。
3. **界面**（Electron 窗口 + 任务列表）
   事件名和字段都已经对齐，界面只需要订阅。

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
