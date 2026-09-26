# VIP 加速链路（完整还原）

用户点名要求的功能。这里记录**客户端侧**可完整还原的部分。所有结论都有文件与行号可查。

判定原则写在最前，避免再犯上次的错：**VIP 加速不是"服务器端资产不可对齐"**。
客户端持有凭据（`vipCert`）、构造请求、加密打包、下发内核——这些全在本地 JS 里，明文。

---

## 0. 一句话结论

```
账号 API 返回 vipList[0].vasType
  → 客户端映射成 viptype 字符串
  → 写入内核 setGlobalExtInfo("isvip=1,viptype=platinum,...")
  → 插件向 ali.pc-x.speed.auth.vip.xunlei.com/speed/speedup 申请 vipCert
  → vipCert 交给内核 enableDcdnWithVipCert(taskId, index, vipCert)
  → 内核走 DCDN 通道下载
```

复刻要做的三件事：
1. 拿到账号的 VIP 字段（登录已还原，见 `LOGIN_CHAIN.md`）
2. 原样实现 token 签发请求（host/query/header/body 全部已知）
3. 把结果交给下载内核（我们自己的内核，接口签名照抄）

---

## 1. VIP 判定：从账号 API 到内核

### 1.1 读取位置
`resources/app/out/main-renderer/renderer.js`

### 1.2 映射表

```
vasType → vipType
    2 → "normal"
    3 → "platinum"
    5 → "super"
```

`vipList[0].vipLevel` 直接作为 `viplevel`。

### 1.3 写给内核

```js
ThunderKernel.setUserInfo(userId, "");
ThunderKernel.setGlobalExtInfo(
    `isvip=${i},viptype=${n},viplevel=${o},userchannel=${e}`,
    false
);
```

未登录时：

```js
ThunderKernel.setUserInfo("", "");
// 全局扩展信息置零
// isvip=0,viptype=,viplevel=0
```

注意 `setGlobalExtInfo` 第二个参数是 `false`。这个布尔值不是"是否持久化"，
而是透传给内核的一个开关位，复刻时要保留原值。

---

## 2. DCDN 加速三件套

```js
ThunderKernel.enableDcdnWithVipCert(virtualTaskId, fileIndex, vipCert)
ThunderKernel.updateDcdnWithVipCert(virtualTaskId, fileIndex, vipCert)
ThunderKernel.disableDcdnWithVipCert(virtualTaskId, fileIndex)
```

语义：
- `enable` — 为某个子文件开一条 DCDN 加速通道，凭据是 `vipCert`
- `update` — 换新凭据（token 会过期，见 §4）
- `disable` — 关闭该子文件的加速通道

`fileIndex` 是**子文件下标**，BT 任务里每个文件可以单独加速。这解释了为什么
`Task` 里既有 `dcdnFileIndex` 又有 `vipSizeList`（按文件维度的加速统计）。

### 2.1 RPC 桥接路径

```
VipDownload 插件
  → client.callServerFunction("EnableDcdnWithVipCert", taskId, vipCert, index)
  → 主进程
  → ThunderKernel.enableDcdnWithVipCert(...)
  → DownloadSDK
```

**注意参数顺序**：`Task` 上的方法签名是 `(taskId, fileIndex, vipCert)`，
而 RPC 上的顺序是 `(taskId, vipCert, index)`。中间有一层换序。
复刻时如果直接照抄会传反。

### 2.2 `Task` 上的 VIP 字段

```
vipCert                 凭据本体
dcdnFileIndex           当前加速的子文件下标
vipSpeed                会员加速速度
vipSizeList             按文件的加速量
bAcclerating            是否加速中（原文就是这个拼写）
shiftChannelSize        通道切换量
vipDownloadSizeCur      当前会员下载量
serverResourceInfos     Map，服务端资源信息
nTotalAvailablePeer     可用 peer 总数
dispatchStrategy        调度策略
XLDownloadStrategy      下载策略
```

`bAcclerating` 的拼写错误是原样保留的。复刻时不要"修正"它——如果它出现在
序列化结构里，改了就匹配不上。

---

## 3. VIP 加速 token 签发（核心）

### 3.1 端点

```
host  = ali.pc-x.speed.auth.vip.xunlei.com
path  = /speed/speedup     查询/申请 token
      = /speed/res_status  查询已有 token 状态
```

### 3.2 请求构造（`renderer.js` @2729618）

```js
const [userId, peerId, vipInfo] = await Promise.all([
    client.callServerFunction("GetUserID"),
    client.callServerFunction("GetPeerID"),
    client.callServerFunction("GetVipInfo")
]);

const timestamp = Math.floor(Date.now() / 1000);

const query =
    `client_name=xl_pc` +
    `&client_version=${clientVersion}` +
    `&release_version=1.0.0` +
    `&client_sequence=123456` +
    `&r=${timestamp}` +
    `&verify_type=1` +
    `&isgroup=0` +
    `&isvip=${vipInfo.isVip}`;

const key = deriveKey(userId, timestamp);
const payload = { peer_id: peerId, task_infos: taskInfos };
if (infohash) {
    payload.infohash = infohash;
    payload.bt_title = btTitle;
}
const body = encryptHttpBuffer(payload, key);

const headers = {
    Authorization: `Basic ${Buffer.from(`${userId}:${trialVerifyInfo}`).toString("base64")}`,
    Accept: "application/json;version=1.3"
};

const resp = await request({
    method: "post",
    url: `http://ali.pc-x.speed.auth.vip.xunlei.com/speed/speedup?${query}`,
    data: body,
    headers
});

const token = VipTaskHttpPackageNS.praseTokenBuffer(userId, timestamp, resp.data, false);
```

### 3.3 另一条路径 `queryImpl`（`renderer.js` @3935254）

```js
const seq = ++this.sequence;
const userId  = await client.callServerFunction("GetUserID");
const session = verify || await client.callServerFunction("GetSessionID");
const now     = Date.now();
const verifyType = e.verifyType;

const uriParam = this.getUriParam(seq, now, verifyType);

this.host    = "ali.pc-x.speed.auth.vip.xunlei.com";
this.retries = 2;
this.timeout = 20000;
this.path    = (status ? "/speed/res_status?" : "/speed/speedup?") + uriParam;

const sessiontype = e.sessiontype;
const appid = e.appid;

this.auth   = HttpJsonCryptoNS.getAuthorization(userId, session, sessiontype, appid);
this.accept = HttpJsonCryptoNS.getAccept();
this.body   = await VipTaskHttpPackageNS.createTokenBuffer(e, this.mGcidTaskMap, status);

return this.postTokenRequest(e, status);
```

两条路径的差别：
- 第一条用 `trialVerifyInfo`（试用凭据）做 Basic 认证
- 第二条用 `sessionid` + `getAuthorization(...)` 生成认证头

`retries = 2`、`timeout = 20000` 是硬编码。`sequence` 在实例上自增，
同一次会话里连续请求要递增——这是防重放，复刻时不能省。

---

## 4. Token 生命周期

来自 `VipDownload.Config`（**明文常量**，`plugin/VipDownload/4.8.0/index.js`）：

```js
VipDownload: {
    TokenExpireAdvanceSecond: 300,       // 提前 300 秒刷新
    TokenExpireMinSecond: 20,            // 剩余不足 20 秒视为已过期
    TokenDefaultQueryInterval: 300,      // 默认 300 秒查一次
    EnableTryMinSize: 209715200,         // 200 MB 以上才给试用加速
    EnableTryMaxProgress: 40,            // 进度超 40% 不再给试用
    FileEnableTryMinSize: 52428800,      // 单文件 50 MB 门槛
    TryInterval: 1800,                   // 试用间隔 30 分钟
    TryMaxProgress: 20,                  // 试用进度上限 20%
    TryMaxSize: 1073741824,              // 试用单次上限 1 GB
    TryFailDispearDelay: 5,              // 试用失败提示 5 秒后消失
    TryFinishDispearDelay: 1800,         // 试用完成提示 1800 秒后消失
    TryFinishClickDispearDelay: 180,
    NewSkinPeerid: [],
    WarnStylePeerid: [],
    BeforeBaotuanXgtStylePeerid: []
}
```

刷新逻辑：拿到 token 后按 `expires_in` 记到期时间，在到期前
`TokenExpireAdvanceSecond`（300 秒）发起刷新；如果剩余时间已经小于
`TokenExpireMinSecond`（20 秒），直接当作过期立刻重取。

**试用加速的门槛**是三层 AND：
- 任务总大小 ≥ 200 MB
- 单文件大小 ≥ 50 MB
- 当前进度 ≤ 40%

且试用本身还有限制：单次 ≤ 1 GB、进度不超 20%、两次试用间隔 ≥ 30 分钟。

---

## 5. 加密函数族（★ 已全部解出）

**没有硬骨头了。** 全部算法都是明文，位置在
`resources/app/out/main-renderer/renderer.js` @2732xxx（模块 `i(550)` / `i(551)`）。

### 5.1 密钥派生（`getKey`）

```js
e.getKey = function (userId, random) {
    let s = CLIENT_NAME + THUNDER_VERSION_NUMBER + userId + random;
    s = md5(s);
    return s.substr(0, 16).toUpperCase();
};
```

其中：

```js
CLIENT_NAME             = "xl_pc"       // 硬编码
THUNDER_VERSION_NUMBER  = 纯数字版本号，来自 VipPluginHelper
```

> `VipDownloadTokenQuery` 模块里还有一份**等价的本地实现**（@2731700）：
> ```js
> function t(e, t) {           // e=userId, t=random
>     let i = "xl_pc" + buildVersion + e + t;
>     return md5(i).substr(0, 16).toUpperCase();
> }
> ```
> 这里 `buildVersion` 的取法是**读 `Thunder.exe` 的文件版本号，取最后一段**：
> ```js
> const exePath = join(__rootDir, "../../Thunder.exe");
> const parts = ThunderHelper.getFileVersion(exePath).split(".");
> const buildVersion = parts[parts.length - 1];       // 最后一段
> ```
> 例如版本 `12.1.2.2662` → `buildVersion = "2662"`。
>
> 必须取**纯数字字符串**。同一段代码在拼 query 时用的是
> `r.default.thunderVersionNumber`（`VipPluginHelper` 给的数值），
> 拼 key 时用的是本地读到的后缀。**两处取值可能不同**——
> 复刻时要保证两处都能对上，最稳的做法是让它们都等于那个 build 号。

**密钥就是 AES-128 的 16 字节 key**，因为 `substr(0,16)` 恰好是 16 个
ASCII 字符（hex 大写 → 每字符 1 字节）。

### 5.2 加密算法（`encryptBuffer` / `decryptBuffer`）

```js
e.encryptBuffer = function (buf, key) {
    let out = null;
    try {
        let cipher = crypto.createCipheriv("aes-128-ecb", key, "");
        out = Buffer.concat([cipher.update(buf), cipher.final()]);
    } catch (e) { log.warning("encryptBuffer", e); }
    return out;
};

e.decryptBuffer = function (buf, key) {
    let out = null;
    try {
        let decipher = crypto.createDecipheriv("aes-128-ecb", key, "");
        out = Buffer.concat([decipher.update(buf), decipher.final()]);
    } catch (e) { log.warning("decryptBuffer", e); }
    return out;
};
```

**`aes-128-ecb`，IV 为空字符串。**

三点要注意：
1. **ECB 模式**——没有 IV，没有链接，每个 16 字节块独立加密
2. **key 是 16 个 ASCII 字符**（就是 §5.1 的 `substr(0,16).toUpperCase()`），
   不是 hex 解码后的 16 字节
3. **空 IV**：Node 的 `createCipheriv` 在 ECB 模式下接受 `""` 也能跑

复刻时用任何语言的 AES-128-ECB + PKCS#7 padding 都能对上
（Node 默认就是 PKCS#7）。

### 5.3 HTTP 封装（`HttpJsonCryptoNS`）

```js
e.encryptHttpBuffer = function (obj, key) {
    const jsonStr = JSON.stringify(obj);          // 1. 序列化
    const buf = Buffer.from(jsonStr);             // 2. 转 bytes
    return ToolsUtilitiesAWNS.encryptBuffer(buf, key);   // 3. AES 加密
};

e.decryptHttpBuffer = function (buf, key) {
    const dec = ToolsUtilitiesAWNS.decryptBuffer(buf, key);
    if (!dec) return null;
    const str = dec.toString();
    try { return JSON.parse(str); } catch (e) { log.warning(e); }
    return null;
};
```

即 **JSON → UTF-8 bytes → AES-128-ECB**。请求和响应同一套。

### 5.4 请求体构造（`createTokenBuffer`，@2731731）

```js
e.createTokenBuffer = function (taskInfo, gcidSubMap, isStatusQuery) {
    const files = [];
    for (let i = 0; i < taskInfo.files.length; ++i) {
        const f = taskInfo.files[i];
        files.push({
            url:        f.url,
            filename:   f.fileName,
            gcid:       f.gcid,
            cid:        f.cid,
            filesize:   f.fileSize,
            refer_url:  f.refUrl,
            cookies:    "",
            file_index: taskInfo.taskType === 2 ? f.subId : undefined,
            tokeninfo:  taskInfo.oldTokens ? taskInfo.oldTokens[i] : ""
        });
        gcidSubMap.set(f.gcid, f.subId);
    }

    const payload = {
        peer_id:     await client.callServerFunction("GetPeerID"),
        infohash:    taskInfo.infoId,
        bt_title:    taskInfo.btTitle,
        task_infos:  files,
        extra_infos: { bt_token_mode: 1 }        // 固定值
    };

    const key = getKey(taskInfo.userId, taskInfo.random);
    return HttpJsonCryptoNS.encryptHttpBuffer(payload, key);
};
```

要点：
- `file_index` **仅当 `taskType === 2`（BT）时才有值**，否则是 `undefined`
  （`JSON.stringify` 会直接把它整个丢掉）
- `cookies` 恒为 `""`
- `extra_infos.bt_token_mode` 恒为 `1`
- `peer_id` 是**异步取的**（`callServerFunction("GetPeerID")`）
- 同时往 `gcidSubMap` 里塞 `gcid → subId` 映射，供后续解析响应时回填

### 5.5 响应解析（`praseTokenBuffer`，@2730116）

```js
e.praseTokenBuffer = function (userId, random, respBuf, isStatusQuery) {
    const name = isStatusQuery ? "praseStatusBuffer" : "praseTokenBuffer";
    log.information(`-->${name}`);

    const key = getKey(userId, random);
    const obj = HttpJsonCryptoNS.decryptHttpBuffer(respBuf, key);

    let out = null;
    if (obj) {
        out = obj;
        out.detailMessage = obj.message;      // 字段改名
        out.message       = obj.simple_msg;
    }
    log.information(`<--${name}`);
    return out;
};
```

**注意字段改名**：响应里原本是 `message`（详细信息）和 `simple_msg`（简短信息），
解析后 `detailMessage` 装原 `message`、`message` 装原 `simple_msg`。
上层读的是改名后的。复刻时这一步不能省。

### 5.6 认证头（`getAuthorization` / `getAccept`）

```js
e.getAuthorization = function (userId, sessionOrToken, sessiontype, appid) {
    let s = userId + ":" + sessionOrToken;
    if (sessiontype) s = s + ":" + sessiontype;
    if (appid)       s = s + ":" + appid;
    return s;
};

e.getAccept = function () {
    return "application/json; version=1.0";
};
```

`getAuthorization` 只是**冒号拼接**，不加密。但注意：

- 主渲染进程那份（@2729618）把结果包了 `Basic base64(...)`
- 这里（@3935254）直接当字符串用，由 `request` 层决定怎么放进 header

`Accept` 头有两个版本：这里 `"application/json; version=1.0"`，
主渲染进程那份是 `"application/json;version=1.3"`（无空格，版本不同）。
**两条路径的 Accept 不一致**，复刻时跟随各自路径。

### 5.7 URI 查询串（`getUriParam`）

```js
e.getUriParam = function (sequence, timestamp, verifyType) {
    let s = "client_name="    + CLIENT_NAME +
            "&client_version=" + THUNDER_VERSION_NUMBER +
            "&client_sequence="+ sequence +
            "&r="              + timestamp +
            "&isvip="          + Number(vipHelper.isVip);
    if (verifyType !== undefined) s += "&verify_type=" + verifyType;
    return s;
};
```

对照主渲染进程那份的更完整版本（多了 `release_version`、`isgroup`），
说明**两个模块各自维护了一份 query 拼装**，字段不完全一致。
复刻时按你实际走的路径抄对应那份。

### 5.8 其他工具函数

```js
genarateMd5(str)                     // createHash("md5").digest("hex")，注意拼写
encryptSha1Buffer(buf)               // sha1 hex
encryptHmacBuffer(algo, key, data, enc = "hex")   // createHmac
calculateFileMd5Ex(path)             // 异步算文件 MD5
```

`genarateMd5` 的拼写错误（generate → genarate）是原样保留的，
调用点也是这么写的。

### 5.9 收尾：完整调用链

```
userId                      ← client.callServerFunction("GetUserID")
random(时间戳/随机数)         ← 调用方传入
peerId                      ← client.callServerFunction("GetPeerID")
key = md5("xl_pc" + buildNo + userId + random)[0:16].upper()
payload = { peer_id, infohash, bt_title, task_infos, extra_infos:{bt_token_mode:1} }
body    = AES-128-ECB(JSON.stringify(payload), key)
query   = client_name=xl_pc&client_version=..&client_sequence=..&r=..&isvip=..
Authorization = Basic base64(userId + ":" + trialVerifyInfo)

POST http://ali.pc-x.speed.auth.vip.xunlei.com/speed/speedup?{query}
     Accept: application/json;version=1.3
     body: {body}

resp    = AES-128-ECB⁻¹(respBuf, key) → JSON
vipCert = { ...resp, detailMessage: resp.message, message: resp.simple_msg }
```

---

## 6. 事件表

`VipDownload:download-kernel-helper` 向 JS 层抛的事件：

```js
taskInserted              = "OnTaskInserted"
taskCompleted             = "OnTaskCompleted"
taskRemoved               = "OnTaskRemoved"
taskStatusChanged         = "OnTaskStatusChanged"
taskDetailChanged         = "OnTaskDetailChanged"
taskDcdnStatusChanged     = "OnTaskDcdnStatusChanged"
btSubFileDcdnStatusChanged= "OnBtSubFileDcdnStatusChanged"
btSubFileDetailChanged    = "OnBtSubFileDetailChanged"
btSubFileForbidden        = "OnBtSubFileForbidden"
```

复刻内核时，这 9 个事件名要保持字面一致——上层 UI 是按字符串订阅的。

---

## 7. 跨端调用契约

`main-renderer` 通过 webview 上下文 `"vip-download-webview"` 调插件
（`renderer.js` @1086789）：

```js
const VIP_WEBVIEW = "vip-download-webview";

getVipTaskInfo(taskId) {
    return client.callRemoteClientFunction(VIP_WEBVIEW, "GetVipTaskInfo", taskId)
        .then(r => r[0]);
}
getVipSubTaskInfo(taskId, index) {
    return client.callRemoteClientFunction(VIP_WEBVIEW, "GetVipSubTaskInfo", taskId, index)
        .then(r => r[0]);
}
getVipSpeedColor(taskId) {
    return client.callRemoteClientFunction(VIP_WEBVIEW, "GetVipSpeedColor", taskId)
        .then(r => r[0]);
}
```

注意返回值是**数组**，要取 `[0]`。这是 RPC 框架的约定（见 `IPC_CONTRACT.md`）。

插件侧把这些注册成原生函数：

```js
NativeCallNS.registerNativeFunction([
    { functionName: "GetVipTaskInfo",     nativeFunc: ... },
    { functionName: "GetVipSubTaskInfo",  nativeFunc: ... },
    { functionName: "GetVipLabelConfig",  nativeFunc: ... },
    { functionName: "ClickTryAcclerateBtn", nativeFunc: ... }
]);
```

`ClickTryAcclerateBtn` 又是个拼写错（Acclerate 少一个 e）。同上，别改。

---

## 8. 探测与错误文案

`renderer.js` @6451022：

```js
// 成功
"会员加速服务连接成功（耗时：" + ms + "毫秒）"
// 失败
"会员加速服务连接失败"
"tcp连接失败（" + address + ":80）"
```

探测方式是裸 TCP 连 **80 端口**（`tcpConnectAW(host, 80)`），不是 HTTP。
复刻验收时用同样方式探测即可。

---

## 9. 用户标签接口

```js
const url = "https://soa-vip-ssl.xunlei.com/xlvip.common.mooseapi/querytags"
    + `?sessionid=${sessionId}`
    + `&userid=${userId}`
    + "&tags=usedToBeDLVip&platform=xlx";

const usedToBeDLVip = resp.data.result.usedToBeDLVip;
const isNewUser = (usedToBeDLVip == 1) ? 0 : 1;
```

用于区分新老用户——影响试用加速的发放策略。

---

## 10. 相关 API 域名全清单

### VIP 相关
```
http://ali.pc-x.speed.auth.vip.xunlei.com            VIP 加速授权（核心）
http://media.info.client.xunlei.com/VipDownloadConfig.json      插件配置
http://media.info.client.xunlei.com/VipPluginSwitchConfig.json  插件开关
http://act.vip.xunlei.com/vip/2018/ssi/vipiconData.js
http://advertpay.vip.xunlei.com/xl11/advertisement
http://download.code.lixian.vip.xunlei.com/errcode
http://msg.vip.xunlei.com/coin/GetSignCoin
http://msg.vip.xunlei.com/xl9/GetcashNum
http://msg.vip.xunlei.com/xlact/NewUser
http://msg.vip.xunlei.com/xlact/conf
https://msg-vip-ssl.xunlei.com/individuation/Clinetreport
https://dy1-vip-ssl.xunlei.com/cashfund/Userfund
https://msg-vip-ssl.xunlei.com/xlact/conf
https://soa-vip-ssl.xunlei.com/xlvip.common.mooseapi/querytags
```

### 账号/登录相关
```
https://xluser-ssl.xunlei.com/certification/v1/isauth     用户鉴权
https://xluser-ssl.xunlei.com/xluser.core.login/v3/*     登录接口族
```

### 统计相关
```
https://analysis-acc-ssl.xunlei.com/analysis-report/v1/
```

---

## 11. 复刻优先级

| 步骤 | 依赖 | 说明 |
|---|---|---|
| 1. VIP 字段读取 | 登录链路 | `GetVipInfo` / `GetLoginVipInfo` 返回 `vipList` |
| 2. 写内核 | 我们自己的内核 | 照抄 `setGlobalExtInfo` 格式串 |
| 3. token 签发 | `deriveKey` + `encryptHttpBuffer` | **唯一的硬骨头**，算法未落地 |
| 4. token 解析 | `praseTokenBuffer` | 输出 `vipCert` |
| 5. 下发内核 | 内核接口 | 注意 RPC 参数换序 |
| 6. 刷新定时器 | 常量表 | 纯逻辑，好写 |
| 7. 事件转发 | 9 个事件名 | 照抄字面 |

只有第 3、4 步需要继续逆向。其余都是"照着契约写"。
