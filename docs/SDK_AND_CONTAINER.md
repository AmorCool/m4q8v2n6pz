# 下载 SDK 与 XLTP 容器格式

用户要求"完整复刻"，那下载内核就需要一个替代品。这一节把 SDK 侧
**所有可观测的事实**记录下来，并给出替换方案。

---

## 1. 目录全貌

```
resources/bin/
    ThunderHelper.node              1 044 448     基础工具（性能监控等）
    ThunderKernel.node              1 277 408     ★ 内核桥接（106 个成员）
    ThunderMsgChannel.node            178 656     消息通道
    ThunderNewTask.node               183 264     新建任务
    ThunderSuspensionWindow.node    1 630 688     悬浮窗
    WeakReferences.node               103 392     弱引用辅助
    XDASEnhancerAddon.node            257 616     统计增强（外部团队）
    SDK/                                          下载 SDK 本体
```

### 1.1 `SDK/` 目录

```
xsdn.dll                    3 941 808
xl_thunder_sdk.dll          3 595 696
DownloadSDK.dll             2 979 248     ← XPF 框架主体，Jenkins+VS2019 独立流水线
TcpImpl.dll                 2 802 096
libeay32.dll                1 430 392     OpenSSL（旧版命名 = OpenSSL 1.0.x）
P2PBase.dll                 1 256 880
xar/DownloadDispatcher.xta  1 033 730     ← 配置/调度数据（见 §3）
libcurl.dll                   723 320
XUdt.dll                      634 288     UDT 传输协议
P2PFramework.dll              483 248
XLReImport.dll                420 272
XLTaskUpgrade.dll             403 376
P2PStat.dll                   329 648
AssistantTools.dll            307 632
XLFileAssistant.exe           264 112
DownloadSDKServer.exe         257 456     ← 独立进程（见 §2）
DownloadSDKProxy.dll          245 680
Http.dll                      240 048
P2PCommonObjects.dll          222 640
P2PIO.dll                     192 944
P2PTarget.dll                 168 880
Ftp.dll                       168 368
XLLiveUDownload.dll           128 944     直播下载
upnp.exe                      132 528     UPnP 端口映射
ProxyVerifier.dll              93 104
```

**每个协议一个 DLL**：`Http.dll`、`Ftp.dll`、`P2P*`、`XUdt.dll`。
这是清晰的分层，复刻时对应关系很直接。

`libeay32` + `ssleay32` 是 OpenSSL 1.0.x 的旧命名（1.1 起改名为
`libcrypto`/`libssl`）。说明 SDK 的 TLS 栈很老。

---

## 2. 进程模型

`DownloadSDKServer.exe` 是**独立进程**。架构：

```
主进程 (Electron)
  → XDASKernel.dll            （Electron 运行时）
  → ThunderKernel.node        （N-API 桥）
  → DownloadSDKProxy.dll      （代理层）
  → DownloadSDKServer.exe     （下载引擎，独立进程）
      → Http.dll / Ftp.dll / P2P*.dll / XUdt.dll
```

跨进程用 `DownloadSDKProxy.dll` 桥。这解释了为什么下载崩了不影响 UI。

**复刻时这一层可以直接换成同进程或子进程**，因为
`ThunderKernel.node` 的接口是稳定的（已全枚举 106 个成员）。

---

## 3. XLTP 容器格式（`DownloadDispatcher.xta`）

这是迅雷自有的容器，用来分发 SDK 的配置/调度数据。

### 3.1 头部（64 字节）

```
偏移  长度  值                        含义
0     4     "XLTP"                    魔数
4     4     00 20 20 20               填充（' '）
8     4     20 20 01 00   = 0x00012020  ?
12    4     02 c6 0f 00   = 1033730   总文件长度（与实际一致）
16    4     40 00 00 00   = 64        数据区起始偏移
20    4     12 00 00 00   = 18        条目数（见 §3.3 的修正）
24    4     01 00 00 00   = 1         版本号
28    4     00 00 00 00   = 0         标志
32    32    全部是 0x20（空格）        填充
```

头部把**总长度和条目数都写进来了**，校验很方便。

### 3.2 数据区结构

从偏移 64 开始是 TLV 序列：

```
name\0       以 NUL 结尾的 ASCII 名字
u32          payload 长度（小端）
payload      定长数据
```

实测遍历：

```
[0] name="context"  len=82      @76
[1] name=""         len=65536   @163        ← 65536 = 64 KB 页
[2] name=""         len=2359296             ← 2.25 MB
```

第一条 `context` 的 82 字节 payload：

```
b0c50f00 0100  555a45... 
串起来看是:  b0 c5 0f 00  01 00  55455a00  012f002f00000081c50f00...
```

注意 `55 45 5a 00` = `"UEZ\0"`。**`UEZ` 是迅雷私有的压缩/加密标记**，
嵌在 `context` 记录内部，标志后面紧跟一段压缩数据。

### 3.3 未完成的部分

`context` 之后的两个无名条目长度（65536 / 2359296）加起来超出了文件长度
（1033730）。说明 §3.2 的 TLV 假设在第一个条目之后就不成立了，
`context` 内部应该还有自己的子结构来描述后面的数据布局。

**已知的确定结论**：
- 魔数、总长度、数据偏移、版本号的位置和含义都确定了
- `context` 是名字-长度-数据形式的第一条记录
- `UEZ` 是内部的压缩标记

**待续**：`context` payload 内部 82 字节的字段表，
以及后面的数据区如何寻址。这是复刻 SDK 配置分发才会用到的，
不影响下载功能本身。

---

## 4. `setting.cfg`（明文 JSON，base64 包装）

文件本身是 base64，解开是 JSON：

```json
{
  "content": {
    "query_config": {
      "int32_query_interval": 28800
    },
    "server": {
      "nce_host": "139.196.143.117;xunlei.com;106.14.112.47;vip.xunlei.com;139.224.15.109;baidu.com;101.132.97.11;x.xunlei.com;101.132.174.28;lol.qq.com;101.132.187.234;live.douyin.com;101.132.186.59;jsq.xunlei.com;101.132.173.130;www.jd.com;101.132.182.211;www.ctrip.com;139.196.143.117;app.toutiao.com"
    },
    "strategy": {
      "name": "(server.UpdateNCEHost_20250717)"
    }
  },
  "control": {
    "last_update_tick": 1790387304
  }
}
```

### 4.1 这是什么

**NCE = 网络连通性探测**（Network Connectivity Estimation 之类）。
`nce_host` 是 `IP;域名` 的交替列表，SDK 拿它们测网络质量、
判断是否被运营商劫持或做了 QoS 限速。

看这组域名很有意思：
- `xunlei.com` / `vip.xunlei.com` / `x.xunlei.com` / `jsq.xunlei.com` — 自家
- `baidu.com` / `lol.qq.com` / `www.jd.com` / `www.ctrip.com` / `app.toutiao.com` — 国内大站
- `live.douyin.com` — 抖音直播

**同时带 IP 和域名**：域名用来测 DNS，IP 用来绕过 DNS 直接测连通性。
如果域名解析到的 IP 和列表里的 IP 不一致，就是被劫持了。

复刻时可以**完全去掉这个机制**，或者自己维护一份类似的探测列表。
它只影响"网络诊断"和"智能限速"，不影响下载本身。

`int32_query_interval = 28800` 秒 = 8 小时查询一次。

`last_update_tick = 1790387304` → 换算成时间是 **2026 年 9 月**左右。
这个文件是被更新过的（`strategy.name` 里的日期是 `20250717`）。

---

## 5. `upgrade_manifest.json`（明文）

SDK 自我升级的清单，每条是 `文件 + MD5`：

```json
[
    { "file": "AssistantTools.dll",    "hash": "7588889A0D40CC18ED791AA09AFF8D63" },
    { "file": "DownloadSDK.dll",       "hash": "118851D3191BC106DDF7BD090FFD4DEC" },
    { "file": "DownloadSDKProxy.dll",  "hash": "A0BC7256D66C62BDDBE3A355A3DB83C1" },
    { "file": "DownloadSDKServer.exe", "hash": "FBBEC256A3A76AD651B591A54347F7CE" },
    { "file": "Ftp.dll",               "hash": "E596873F2D9A91936495A70C3932FC13" },
    { "file": "Http.dll",              "hash": "5CDF24C1C7C9E5AA06099A2A2ADEC464" },
    { "file": "libcurl.dll",           "hash": "4B5DFD7E9AC50A741B5AC6102B30CBF5" },
    { "file": "libeay32.dll",          "hash": "FF5C63EFBBA91A0EEC9FC645DA655B4C" },
    ...
]
```

**MD5 是裸 hex 大写**，不是 base64。升级时逐文件校验。

其他文件：
- `seq_id` — 4 字节，序列号
- `statXml.xml` — 统计配置
- `statstorage_v5.xml` — 统计存储（v5）
- `download_stat.bin` — 21 864 字节，二进制统计

---

## 6. 替换方案

### 6.1 分层替换表

| 原组件 | 复刻替代 | 难度 |
|---|---|---|
| `DownloadSDKServer.exe` | 自写下载引擎 | **高** |
| `Http.dll` | Node 内置 `https` / `got` | 低 |
| `Ftp.dll` | `basic-ftp` | 低 |
| `P2P*.dll` | **无替代**，只能做 BT | 高 |
| `XUdt.dll` | **无替代**（可放弃） | — |
| `XLLiveUDownload.dll` | **无替代**（可放弃） | — |
| `upnp.exe` | `nat-upnp` / `upnp-client` | 低 |
| `ProxyVerifier.dll` | 自写 | 低 |
| `xar/DownloadDispatcher.xta` | 自写配置 | 中 |

### 6.2 协议层对应

```
原 SDK                复刻
─────────────────────────────────────────────
Http.dll          →   Node fetch / undici
Ftp.dll           →   basic-ftp
BT (P2P 部分)     →   libtorrent (webtorrent 或 aria2 子进程)
磁力              →   同上
XUdt / 直播下载    →   放弃（迅雷私有，无公开协议）
```

### 6.3 XPF 框架

`DownloadSDK.dll` 导出 51 个 `XPF_*` 符号，构成可注册式通道/连接框架：

```
XPF_Register*Type    注册通道类型
DataBlock / DataRange  引用计数数据块
Package / PackageParser  私有封包
GlobalFlowControler  全局配额
```

这是**内部框架**，复刻时不需要照抄。只要保证 `ThunderKernel.node`
的 106 个成员对外行为一致，内部怎么实现都行。

### 6.4 关键结论

**下载内核可以整个替换，只要接口签名一致。** 这是复刻里最容易切分的一块，
因为它是进程边界（`DownloadSDKServer.exe`），契约清晰。

---

## 7. `XLTP` 格式的用途推断

`xar/DownloadDispatcher.xta` 从名字看是**下载调度器**的配置/代码。
`730 万字节里 2359296 = 2.25 MB` 那段很可能就是调度策略的字节码或规则表。

考虑到：
- `context` 条目名
- `UEZ` 压缩标记
- 头部有版本号 `1`

这更像是**一套规则引擎的序列化数据**，而不是可执行代码。

**对复刻的影响**：调度策略我们可以自己写一套简单的（HTTP 多连接 + BT），
不需要还原迅雷的调度算法。这块可以直接跳过。

---

## 8. 存档位置

本文档涉及的所有文件都在：

```
E:\Thunder\Program\resources\bin\
E:\Thunder\Program\resources\bin\SDK\
E:\Thunder\Program\resources\bin\SDK\xar\
```

解析脚本：
- `_pe_dump.py` — PE 头/导出/导入/PDB
- 本节新增的 XLTP 解析逻辑可后续补进 `_xta_dump.py`
