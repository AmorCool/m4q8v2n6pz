# 登录链路（完整还原）

用户明确要求"包含登录"。这里是从设备指纹到 token 交换的**全链路**，
所有结论都来自明文 JS 或已解出的 sourcemap 源码。

**重大发现**：`plugins/User/0.2.20/index.js` 内嵌 **334 份 sourcemap**，
`_unmap.py` 全部解出，落盘 314 个源文件到 `_thunder_src/User/`。
其中 `dist/main/modules/User/xbaseTokenRequest.js` 是**未压缩的 TypeScript
编译产物**——登录逻辑直接就是可读源码，不是逆向出来的。

---

## 0. 三条独立的登录路径

别把它们搞混，这是理解登录的关键：

| 路径 | 位置 | 用途 | 产物 |
|---|---|---|---|
| **A. 网页登录** | `ThunderXLogin/qLogin.min.js` | 弹窗账号/扫码登录 | `sessionid` + `userid` |
| **B. Session 换 Token** | `User/dist/main/modules/User/xbaseTokenRequest.js` | 把 sessionid 换成 OAuth2 access_token | `access_token` |
| **C. 匿名登录** | 同 B | 未登录状态下拿一个匿名身份 | 匿名 `sub` |

A 是"人登录"，B 是"把登录结果变成 API 凭据"，C 是"没人登录时也要能下载"。

---

## 1. 路径 A：网页登录（`ThunderXLogin`）

### 1.1 服务器列表与轮询

`qLogin.min.js`：

```js
SERVER_LOGIN: [
    "xluser-ssl."  + DOMAIN,
    "xluser2-ssl." + DOMAIN,
    "xluser3-ssl." + DOMAIN
]
```

失败后按顺序切下一台。`index.js` 里对应的数组是：

```js
var V = ["login", "login2", "login3"];   // 主机名前缀
var K = ["channel", "channel2", "channel3"];
```

即首选中 `login.xunlei.com`，退到 `login2` / `login3`。

### 1.2 API 基址

```js
baseUrl: "/xluser.core.login/v3/"
```

完整端点：

| 方法 | 端点 | 作用 |
|---|---|---|
| `loginkey` | `{base}loginkey` | 用 loginKey 换 cookie 登录态 |
| `getuserinfo` | `{base}getuserinfo` | 拉用户资料 |
| `logout` | `{base}logout` | 注销 |
| `ping` | `{base}ping` | 保活（30 万毫秒一次） |
| `sessionlogin` | `{base}sessionlogin` | session 登录 |
| `jumplogin` | `{base}jumplogin` | 跳转登录 |

请求体格式：`application/x-www-form-urlencoded` 与 cookie 双模式，
由 `format` 参数决定（`"json"` / `"cookie"` / `"jsonp"`）。

### 1.3 `loginkey` —— 主登录请求

`index.js`：

```js
const url = `https://${V[t]}.xunlei.com/xluser.core.login/v3/loginkey`;

const body = Object.assign({}, Q, {          // Q 是基础参数包
    devicesign: E,                            // 设备指纹
    userName:   j.userid,
    loginKey:   j.loginkey
});

axios({ url, method: "post", data: body }).then(res => {
    if (res.status == 200) {
        if (res.data.errorCode == "0") {
            // 成功
        } else {
            // 失败
        }
    } else {
        retry(t + 1);                         // 换下一台服务器
    }
});
```

重试上限 3 次。

### 1.4 响应字段映射（重要）

登录响应是**短字段名**，客户端映射成长名后存 cookie：

```js
const fieldMap = {
    errorCode:    "blogresult",
    errorDesc:    "errdesc",
    userID:       "userid",
    loginKey:     "loginkey",
    nickName:     "usernick",
    sessionID:    "sessionid",
    userName:     "usrname",
    userNewNo:    "usernewno",
    account:      "score",
    verifyType:   "VERIFY_KEY",
    errorIsRetry: "error_retry"
};
```

映射后逐项 `store.set(...)` 落盘。

`VERIFY_KEY` 就是 VIP token 请求里那个 `trialVerifyInfo` 的来源 —— 两条链路在这里接上了。

### 1.5 基础参数包 `Q`

```js
Q = {
    appid:              "",
    appName:            "",
    deviceModel:        hostname(),          // 初始为机器名
    deviceName:         BrowserType,
    OSVersion:          "",                  // 初始空
    netWorkType:        "NONE",
    providerName:       "NONE",
    sdkVersion:         "v4.5.11",
    clientVersion:      "",
    protocolVersion:    "301",               // 注意：不是 300
    devicesign:         "",
    platformVersion:    "0",
    fromPlatformVersion:"0",
    format:             "json",
    timestamp:          Date.now(),
    creditkey:          ""
}
```

`initconfig` 读出来后回填：

```js
Q.appid           = cfg.appid;
Q.appName         = cfg.appName;
Q.deviceModel     = (cfg.platformVersion === "0") ? "PC" : "LINUX";
Q.platformVersion = cfg.platformVersion;
Q.fromPlatformVersion = cfg.platformVersion;
Q.clientVersion   = cfg.clientVersion;
Q.OSVersion       = cfg.osversion;
```

注意 `qLogin.min.js` 里 `baseParams2` 的 `protocolVersion` 是 `"300"`，
而 `index.js` 的 `Q.protocolVersion` 是 `"301"`。**两个不同的值**——
网页 SDK 用 300，客户端插件用 301。不要统一。

### 1.6 平台映射表

```js
{ PC: "0", WEB: "1", WAP: "3", MAC: "4", ANDROID: "10", LINUX: "12" }
```

---

## 2. 设备指纹 `devicesign`（关键）

### 2.1 生成算法

`index.js` @93113：

```js
nativeCall.CallNativeFunction("GetLoginDeviceID", (err, machineId) => {
    const digest = md5(machineId + cfg.package + cfg.appid + cfg.appkey);
    const deviceSign = "div101." + machineId + base64(digest);

    store("memory", "deviceid", JSON.stringify({ id: deviceSign }));
    store("file",   "deviceid", JSON.stringify({ id: deviceSign }));
    // 同时写进 GBHelper 的 platformInfo.deviceSign
});
```

拆开看：

```
machineId   ← 原生 GetLoginDeviceID 返回（主进程提供，机器级唯一）
digest      = md5(machineId + package + appid + appkey)
deviceSign  = "div101." + machineId + base64(digest)
```

**四个输入**：`machineId`、`package`、`appid`、`appkey`。
后三个来自 `initconfig`（即主进程下发的 app 配置）。

这个格式 `div101.<machineId><base64(md5)>` 是迅雷客户端的**统一设备标识**，
不是登录专用的。复刻时这个字符串要能被服务端接受，
所以 `<machineId>` 的取值域需要和原版一致。

### 2.2 客户端侧的读取

`qLogin.min.js` `deviceid()`：

```js
function deviceid() {
    let v = cookie("deviceid");
    if (v && v.length > 20) return v;
    if (localStorage.enabled && localStorage.has("deviceid")) {
        const s = localStorage.get("deviceid");
        if (s.length > 20) return s.replace(/'/g, "");
    }
    return "";
}
```

长度必须 > 20，且要剥掉单引号。长度阈值是**校验**，不是修剪。

---

## 3. 路径 B：Session → OAuth2 Token（源码级）

**这一节是未压缩源码**，来自
`_thunder_src/User/dist/main/modules/User/xbaseTokenRequest.js`。

### 3.1 常量（`dist/main/modules/User/constants.js`）

```js
exports.SESSION_TOKEN_URL      = '/v1/auth/signin/token';
exports.SESSION_TOKEN_PROVIDER = 'access_end_point_token';
exports.AUTH_REVOKE_URL        = '/v1/auth/revoke';
exports.AUTH_CLIENT_URL        = '/v1/user/authorize';
exports.RequestIdHeaderName    = 'x-request-id';
exports.DeviceIdHeaderName     = 'x-device-id';
exports.XL_ACC_CENTER_CLIENT_ID = 'XW5SkOhLDjnOZP7J';
exports.XL_ACC_CENTER_URL       = 'https://i.xunlei.com/xluser/code-auth/';
```

`XL_ACC_CENTER_CLIENT_ID` 是**明文硬编码的 OAuth2 client_id**。

### 3.2 token 交换本体

`xbaseTokenRequest.js` `sessionTokenExchange()`：

```js
const sessionId = await getSessionId();
if (!sessionId || sessionId.length <= 0) {
    sleep(500);
    sessionId = await getSessionId();          // 只重试一次
}

const param    = await getUserLoginParam();
const deviceID = await getDeviceId();

let opts = {
    method: 'POST',
    body: {
        provider:      'access_end_point_token',
        signin_token:  sessionId,
        client_id:     clientId,
        client_secret: clientSecret
    }
};
opts.headers['x-device-id'] = deviceID;
opts.headers['User-Agent']  = param.userAgent;

const data = await o2client.request('/v1/auth/signin/token', opts);
data.refresh_token = data.refresh_token || sessionId;   // 用 sessionId 兜底
```

要点：
- `provider` 固定 `access_end_point_token` —— 服务端据此知道"凭据是客户端 session"
- `signin_token` 就是 A 路径拿到的 `sessionid`
- `refresh_token` 缺失时**用 sessionId 自身兜底**
- 有按 sessionId 的去重：`_sessionPromises` Map，同 session 并发只发一次

调试模式会把 `expires_in` 强制改成 50 秒，方便测刷新逻辑：

```js
if (BUILD_ENV === 'debug') data.expires_in = 50;
```

### 3.3 匿名登录

```js
async signUpAnonymously() {
    const uid = await getUserID();
    if (uid != "0" && this.uid) {
        return Promise.reject(buildResponseError(new Error("uid!=0")));
    }
    const param = { client_id, client_secret };
    const cred  = await auth.signUpAnonymously(param);
    this.uid = cred.sub;
}
```

调用时机：启动后 **3 秒**（`setTimeout(..., 3000)`），且仅当 `IsLogined == false`。

`auth.signUpAnonymously` 内部（`@xbase/sdk/dist/index.js`）：

```js
e.prototype.signUpAnonymously = function(e) {
    e.client_id = this._config.clientId;
    const n = await this._config.request('/v1/auth/signup/anonymously', {
        method: "POST", body: e
    });
    await this._config.credentialsClient.setCredentials(n);
};
```

匿名身份的 uid 取自响应的 `sub` 字段。后续所有带 `withCredentials` 的请求
都会带这个匿名身份的 `Authorization`。

### 3.4 OAuth2 SDK 端点全表（`@xbase/sdk`）

```
/v1/auth/signin                      登录
/v1/auth/signin/with/provider        第三方登录
/v1/auth/signin/token                session→token（本链路核心）
/v1/auth/signup                      注册
/v1/auth/signup/anonymously          匿名注册
/v1/auth/token                       取 token
/v1/auth/device/code                 设备码
/v1/auth/revoke                      吊销
/v1/auth/verification                发验证码
/v1/auth/verification/verify         校验验证码
/v1/auth/provider/token
/v1/auth/provider/uri
/v1/user/provider/bind               绑定第三方
/v1/user/provider                    第三方列表 / 解绑
/v1/user/device/authorize            设备授权
/v1/user/me                          当前用户
/v1/user/query                       查询用户
/v1/user/profile                     资料
/v1/user/trans/by/provider
/v1/user/sudo                        校验密码
/v1/user/contact                     绑定手机
/v1/user/password                    设置密码
```

这是**完整的账号中心 API**。登录复刻基本就是照这张表实现。

### 3.5 错误码全表

```
unreachable  local  cancelled  unknown  invalid_argument
deadline_exceeded  not_found  already_exists  permission_denied
unauthenticated  resource_exhausted  failed_precondition
aborted  out_of_range  unimplemented  internal  unavailable  data_loss
captcha_required  captcha_invalid  invalid_password  invalid_status
user_pending  user_blocked  invalid_verification_code
two_factor_required  invalid_two_factor  invalid_two_factor_recovery
under_review  provider_error  validate_required
password_reset_required  invalid_account_or_password
invalid_request  unauthorized_client  access_denied
```

`unauthenticated` 触发 `signOutHandler`（会话失效自动登出）。

### 3.6 请求重试与去重

```js
generateReqKey(url, reqOptions) {
    const holder = reqOptions.headers["x-request-id"];
    reqOptions.headers["x-request-id"] = "";        // 排除掉再算哈希
    const key = md5(url + JSON.stringify(reqOptions));
    reqOptions.headers["x-request-id"] = holder;
    return key;
}
```

`x-request-id` 是随机的，所以算 key 前要先置空——否则每次都是新 key，
去重失效。同样的请求会复用同一个 Promise。

---

## 4. 路径 C：会话保活与踢下线

`index.js` `re()`：

```js
setInterval(re, 300000);        // 5 分钟一次

Se({ type: "ping", data: {} }, 0, res => {
    if (res.errorCode != 200) return stopPing();
    (res.messages || []).forEach(m => {
        if (m.type == "session_timeout") {
            D = false; stopPing();
            // 派发 session_timeout
        } else if (m.type == "kickout") {
            stopPing();
            // 派发 kickout，带 sessionID
        }
    });
});
```

两种消息：
- `session_timeout` — 会话超时，清登录态
- `kickout` — 被其他地方登录顶掉

`ping` 同时在跑**消息通道同步**：`SyncMessage-/user/me/info` 事件
（`client.attachServerEvent`）用于多端同步用户信息变更。

---

## 5. 注销（三条路径并存）

### 5.1 老接口

```js
const url = `https://${V[t]}.xunlei.com/xluser.core.login/v3/logout`;
axios({ url, method: "post", data: Object.assign({}, Q, {
    devicesign: E, userID: j.userid, sessionID: T
})}).then(...).catch(...);        // 成功失败都派发 onLogout
```

注意 `.catch` 里**也**派发 `onLogout`——注销是尽力而为，失败不能卡住。

### 5.2 OAuth 注销（webview 方式）

```js
enableOauthLogout && xbaseLogoutInfo.needRunLogout
  → tab 名 = `WebSDK-XbaseLogout-Tab-{B284B653-0A8C-4E31-8CA6-A41679F30323}` + index
  → 逐个 URL 起隐藏 webview，等 OnLoadEnd / OnLoadError
  → 等 3 秒或 5 秒超时
  → 读 cookie，逐个清
```

默认兜底 URL：

```
https://i.xunlei.com/xluser/oauth.html?sign_out=true
```

`{B284B653-0A8C-4E31-8CA6-A41679F30323}` 是**第 4 个硬编码 GUID**（前三个见 `IPC_CONTRACT.md`）。

### 5.3 本地清理

```
memory: allUserInfo → null
file:   users 列表剔除当前用户
memory: userinfo
停 ping 定时器
```

---

## 6. 用户信息与 VIP 字段

### 6.1 `getuserinfo` 请求

```js
const url = `https://${V[t]}.xunlei.com/xluser.core.login/v3/getuserinfo`;
axios({ url, method: "post", data: Object.assign({}, Q, {
    devicesign: E,
    userID:     userid,
    sessionID:  sessionid,
    vasid:      "2,14,33,34,35"
})});
```

**`vasid: "2,14,33,34,35"`** —— 增值服务 ID 列表，VIP 信息就在这批里。

`qLogin.min.js` 版本多一个 appid 分支：

```js
r.vasid = t.vasid || "2,14,33,34,35";
if (t.appid)    r.appid    = t.appid;
if (t.appName)  r.appName  = t.appName;
if (t.devicesign) r.devicesign = t.devicesign;
r.format = "jsonp";
```

### 6.2 `vipList` 的存在性判定

`index.js` `me()`：

```js
t.vipList && (
    X = true,
    store("memory", "allUserInfo", JSON.stringify(t)),
    CallNativeFunction("CloseLoginWnd", "suc"),
    CallNativeFunction("NativeFireEvent", "onLoginSuc", t.userid, t.sessionid, ()=>{})
);
```

**`vipList` 存在 = 登录成功的信号**。不是看 `errorCode`。

### 6.3 主渲染进程侧的 VIP 映射

`main-renderer/renderer.js`：

```js
vipList[0].vasType → vipType    { 2: "normal", 3: "platinum", 5: "super" }
vipList[0].vipLevel → vipLevel
vipList[0].isVip    → isVip
```

`VipPluginController` 用的是另一套：

```js
t = IsLogined();
r = Number(e.vasType).valueOf();
n = Boolean(e.isVip === "1");        // 注意字符串比较

e.set("is_login",     t ? 1 : 0);
e.set("is_vip",       n ? 1 : 0);
e.set("vip_type",     r);
e.set("plugin_name",  i);
e.set("plugin_version", pluginVersion);
```

`e.isVip === "1"` 是**字符串**比较。同一个字段在不同插件里类型不一致——
服务端返回的可能是数字，插件做了宽松处理。复刻时按插件各自的方式处理。

---

## 7. 客户端原生函数清单

`ThunderXLogin` 调用的原生能力：

```js
CallNativeFunction("GetLoginDeviceID", cb)                  // 机器 ID
CallNativeFunction("CreateLoginWnd", true, n, r, 600, 440)  // 开登录窗（600x440）
CallNativeFunction("CloseLoginWnd", "suc")                  // 关登录窗
CallNativeFunction("NativeFireEvent", "onLoginBefore", ...)
CallNativeFunction("NativeFireEvent", "onLoginSuc", userid, sessionid, cb)
CallNativeFunction("NativeFireEvent", "onLoginFailed", code, "fail", cb)
CallNativeFunction("NativeFireEvent", "onGetUserInfoFinished", cb)
CallNativeFunction("NativeFireEvent", "onLogout", uid, cb)
```

登录窗口尺寸 **600 × 440** 硬编码。

### 7.1 插件注册给外部的函数

`User` 插件（`clientFunction.js`）：

```js
client.registerFunctions({
    UserGetAccessToken: this.getAccessToken,
    Request:            this.Request,
    GetOauthURI:        this.getOauthURI,
    IsAnonymous:        this.isAnonymous
});
client.callServerFunction('RegisterWebExternal', functions);
```

### 7.2 `User` 插件对外暴露的完整 API

```
register              registerXbaseTokenRequestt()
getAccessToken        (remoteId, context)
getOAuth2Client       (remoteId, context)
getCurrentSub         (remoteId, context)
getSubList            (remoteId, context)
getOauthURI           (remoteId, redirectURI, context)
isAnonymous           (remoteId, context)
mock                  ()
```

内部工具函数：

```
getThunderVersion()   → callServerFunction("GetThunderVersion")
getSessionId()        → callServerFunction("GetSessionID")
getDeviceId()         → callServerFunction("GetDeviceIdOfWebSDKPlugin")
getPeerID()           → callServerFunction("GetPeerID")
getUserID()           → callServerFunction("GetUserID")
isLogined()           → callServerFunction("IsLogined")
```

这些就是 VIP token 请求要用的那几个。

---

## 8. OAuth 授权码流程

`getOauthURI(remoteId, redirectURI, context)`：

```js
const body = {
    client_id:     "XW5SkOhLDjnOZP7J",
    redirect_uri:  redirectURI,
    response_type: "code",
    scope:         "user+pan",
    state:         "ignored"
};
reqOptions.method = "POST";
reqOptions.body   = body;
reqOptions.withCredentials = true;
reqOptions.headers["x-request-id"] = uuidv4();
reqOptions.headers["x-device-id"]  = deviceID;

const codeRsp = await tokenRequest.request("/v1/user/authorize", reqOptions, uid);

const result = new URL("https://i.xunlei.com/xluser/code-auth/");
result.searchParams.set("redirect_uri", redirectURI);
result.searchParams.set("code", codeRsp.code);
result.searchParams.set("expires_in", codeRsp.expires_in);
```

`scope` 是 `user+pan`（加号分隔，不是空格）—— 用云盘功能就要这个 scope。

---

## 9. 一个有趣的实现细节

`User/clientFunction.js` 里有个 `hackyReqOptions`：

```js
if (reqOptions.method === 'GET' && reqOptions.body) {
    delete reqOptions.body;
}
if (reqOptions.method === "POST" && reqOptions.body && url === "/fn/dlstatisc/1zb3oxs") {
    const bodyBase64 = Buffer.from(JSON.stringify(reqOptions.body)).toString("base64");
    if (bodyHackBlock.has(bodyBase64)) {
        reqOptions = null;                    // 重复的埋点，直接丢掉
    } else {
        bodyHackBlock.set(bodyBase64, true);
    }
}
```

`/fn/dlstatisc/1zb3oxs` 是埋点上报端点，客户端做了**请求体级去重**——
同样的 body 只发一次。注释写着："temp break to help thunderX fixing its req"。

复刻时这个端点可以直接丢弃，验证系统可选。

---

## 10. 复刻清单

```
[ ] 1. 原生桩：GetLoginDeviceID 返回机器 ID
[ ] 2. app 配置：appid / appName / package / appkey / clientVersion / osversion
[ ] 3. devicesign = "div101." + machineId + base64(md5(machineId+package+appid+appkey))
[ ] 4. 登录窗（600x440 webview）加载 xlx.html，走 qLogin
[ ] 5. loginkey 请求 → 拿 sessionid/userid
[ ] 6. 字段映射 → 存 cookie/localStorage
[ ] 7. getuserinfo（vasid=2,14,33,34,35）→ 拿 vipList
[ ] 8. sessionTokenExchange → POST /v1/auth/signin/token → access_token
[ ] 9. 5 分钟 ping 保活 + session_timeout / kickout 处理
[ ] 10. 匿名登录兜底（3 秒后，未登录才触发）
[ ] 11. 注销三路（老 API + OAuth webview + 本地清理）
```

**服务端契约已 100% 掌握，不需要再逆向。** 剩下的都是工程实现。

---

## 附录：相关文件与行号

| 内容 | 文件 | 位置 |
|---|---|---|
| 登录主流程 | `plugins/ThunderXLogin/index.js` | @91736 起 |
| 设备指纹 | 同上 | @93113 |
| loginkey | 同上 | @97800 附近 |
| getuserinfo | 同上 | @97700 附近 |
| logout | 同上 | @98120 |
| ping | 同上 | @97600 附近 |
| OAuth 注销 | 同上 | @106427 |
| 网页 SDK 配置表 | `plugins/ThunderXLogin/qLogin.min.js` | `SERVER_LOGIN:` |
| v3 API 类 | 同上 | `baseUrl:"/xluser.core.login/v3/"` |
| baseParams2 | 同上 | @26828 |
| gslb 调度 | `plugins/ThunderXLogin/gslb.min.js` | 全文（3.8 KB） |
| token 交换 | `_thunder_src/User/dist/main/modules/User/xbaseTokenRequest.js` | 全文 |
| 登录常量 | `_thunder_src/User/dist/main/modules/User/constants.js` | 全文 |
| OAuth2 端点表 | `_thunder_src/User/node_modules/@xbase/sdk/dist/index.js` | @17622 |
| OAuth2 错误码 | 同上 | @15203 |
| 匿名登录 | 同上 | @66579 |
| User 插件客户端 API | `_thunder_src/User/dist/main/modules/User/clientFunction.js` | 全文 |
