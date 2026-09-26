# 启动链 —— 从 Thunder.exe 到 Electron（决定性证据）

## 1. `Thunder.exe` 的真实身份

```
大小      608 256 B
位数      PE32 / 32 位（machine=0x014c，7 个节）
PDB       D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\Thunder.pdb
```

### 导入表（11 个 DLL，**没有 XDASKernel.dll**）

```
KERNEL32.dll   153
USER32.dll      26
ADVAPI32.dll    26
SHLWAPI.dll     12
libexpat.dll     8   ← XML 解析（读配置）
SHELL32.dll      5
VERSION.dll      3
WININET.dll      3   ← HTTP（检查更新）
ole32.dll        2
IPHLPAPI.DLL     1
WS2_32.dll       1
```

### ★ 决定性字符串证据

```
RunMain                  ← 1 处
LoadLibraryW / LoadLibraryExW / LoadLibraryExA / LoadLibraryA   ← 5 处
GetProcAddress           ← 1 处
node.exe                 ← 1 处
```

## 2. 启动链（还原）

```
Thunder.exe
   │
   │ 1. 读配置（libexpat 解析 XML）、检查更新（WININET）、UPnP（IPHLPAPI）
   │
   │ 2. LoadLibraryW("XDASKernel.dll")        ← 静态导入表里没有，是运行时加载
   │
   │ 3. GetProcAddress(hMod, "RunMain")        ← 唯一要找的导出符号
   │
   │ 4. RunMain()                              ← 进入 Electron 主进程
   │        │
   │        └─ Electron 14 启动序列
   │               ├─ 解析 process.argv
   │               ├─ 读 resources/default_app.asar（102 351 B）
   │               ├─ 读 resources/app/package.json
   │               │     main = "./out/main.js"
   │               └─ 执行 resources/app/out/main.js
   │                      └─ 加载 ../bin/*.node（7 个插件）
   │                             └─ 通过 XDASKernel.dll 的导出表拿 v8::/napi_*/uv_*
```

**为什么 `node.exe` 会作为字符串出现**：Electron 里 `process.execPath` 的 basename
在很多地方被当作 node 使用（比如 `getDefaultPrex()` 返回
`path.basename(process.execPath, ".exe")`，在 Electron 下就是 `Thunder`）。
这个字符串是 Electron 运行时内部的，不是 Thunder.exe 自己的逻辑。

## 3. 复刻的直接推论

### 复刻可以完全跳过 `Thunder.exe` 和 `XDASKernel.dll`

只需要一个标准 Electron 14 的 `electron.exe`，加一个自定义的 `resources/app/`：

```
my-thunder/
├── electron.exe                  ← 官方 Electron 14 发行版，直接拿
├── resources/
│   ├── default_app.asar          ← 可省（用 --app 参数或 package.json 即可）
│   └── app/
│       ├── package.json          ←  3 行，main 指向 out/main.js
│       └── out/
│           ├── main.js           ← 自己重写
│           ├── common-preload.js ← 照抄三条契约
│           └── ...
└── profiles/                     ← 运行时生成
```

### 需要自己补的

| 原物 | 作用 | 复刻方案 |
|---|---|---|
| `XDASKernel.dll` | 提供 `v8::`/`napi_*`/`uv_*` 导出表 | **官方 electron.exe 自带，不用管** |
| `Thunder.exe` | 启动器 + 更新检查 + UPnP | Electron 直接启动，或写个 10 行的 C 启动器 |
| `resources.pak` (4.4 MB) | Chromium 资源 | 官方 Electron 自带 |
| `locales/*.pak` | 多语言 | 官方 Electron 自带 |
| `codecs/`（空目录） | 编解码 | 不需要 |
| `default_app.asar` (100 KB) | 默认应用 | 不需要 |

### 必须重新编译的

7 个 `.node`：它们依赖的是 **`XDASKernel.dll` 那份特定的导出表**。
换成官方 `electron.exe` 后，导入符号必须重新解析。

**推荐路径**：不要试图产出 ABI 兼容的旧式 V8 扩展，直接用 **N-API** 重写。
理由：
1. `XDASKernel.dll` 实测导出 **136 个 `napi_*`** ⇒ N-API 在迅雷自己的运行时里就是一等公民；
2. N-API 是 ABI 稳定的，跨 Electron 版本不用重编；
3. 官方 `electron.exe` 同样导出完整 N-API。

## 4. 其它资源盘点

```
resources/
├── app/                        应用本体
│   ├── out/                    打包后的 JS
│   ├── plugins/                8 个插件
│   ├── static/                 图标与 UI 资源
│   │   ├── thunder11.ico       主图标
│   │   ├── shadow.png / shadow-corner.png    窗口阴影（配合 drawShadowWindow）
│   │   ├── transparent-img.png
│   │   ├── default-preview.jpg
│   │   ├── empty.ico
│   │   ├── activity/  icon/  search/
│   └── package.json
├── bin/                        原生层
│   ├── *.node                  7 个插件
│   └── SDK/                    下载引擎
└── default_app.asar            102 351 B
```

顶层还有：`resources.pak`（4.4 MB，Chromium 资源）、`locales/{en-US,zh-CN}.pak`、
`XLLuaRuntime.dll`（Lua UI 引擎，旧版迅雷遗留）、`XLFSIO.dll`、`XLBugHandler.dll`、
`xlstat4.dll`、`libexpat.dll`、`codecs/`（空）。

**注**：`XLLuaRuntime.dll` / `XLFSIO.dll` 属于**上一代迅雷**（Lua UI），
在 12.x 的 Electron 架构里已不承担主界面职责，属于遗留依赖。复刻不需要它们。
（PDB 路径 `e:\work\xunlei_uiengine\pdb\ProductRelease\...` 证实是另一个工程。）

## 5. 一句话总结

> **迅雷 12.1.2.2662 = 官方 Electron 14 + 自己写的 `app/` 目录 + 7 个 N-API 插件 + 一套下载 SDK。**
>
> `Thunder.exe` 和 `XDASKernel.dll` 只是"把 Electron 改名藏起来"的包装 ——
> 复刻时这两样都可以直接用官方发行版替代。
