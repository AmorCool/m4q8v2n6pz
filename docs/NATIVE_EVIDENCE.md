# 迅雷 12.1.2.2662 —— 原生层证据与依赖树

本文件是 `ARCHITECTURE.md` 的补充，只放**实测出来的原始证据**。

---

## 1. 七个 `.node` 的 PE 头与 PDB（自写解析器实测）

全部 `machine=0x014c` = **PE32 / 32 位**，`magic=0x10b` = PE32（非 PE32+），5 个节。

| 模块 | 大小 | PDB 路径 |
|---|---|---|
| ThunderHelper.node | 1 044 448 | `D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\ThunderHelper.pdb` |
| ThunderKernel.node | 1 277 408 | `D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\ThunderKernel.pdb` |
| ThunderMsgChannel.node | 178 656 | `D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\ThunderMsgChannel.pdb` |
| ThunderNewTask.node | 183 264 | `D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\ThunderNewTask.pdb` |
| ThunderSuspensionWindow.node | 1 630 688 | `D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\ThunderSuspensionWindow.pdb` |
| WeakReferences.node | 103 392 | `D:\thunder11\thunder11_cppsrc\thunder\build\ProductRelease\WeakReferences.pdb` |
| XDASEnhancerAddon.node | 257 616 | `D:\thunder_thirdparty\thunder11_cppsrc\thunder\build\ProductRelease\XDASEnhancerAddon.pdb` |

> `XDASEnhancerAddon` 的 PDB 在 **thunder_thirdparty** 树里 ⇒ 它是第三方/外部团队编译的组件，
> 与其余六个（同一 `thunder11_cppsrc\thunder` 树）不同源。

## 2. 导入表 —— 一个反直觉的结论

| 模块 | 导入 DLL 数 | 明细 |
|---|---|---|
| ThunderHelper | 22 | KERNEL32(202) USER32(95) **gdiplus(33)** ADVAPI32(15) SHELL32(14) GDI32(12) ole32(8) **xlstat4(8)** SHLWAPI(7) … |
| ThunderKernel | **3** | KERNEL32(130) ADVAPI32(5) SHLWAPI(2) |
| ThunderNewTask | 5 | KERNEL32(96) USER32(12) ADVAPI32(9) **WS2_32(2)** SHLWAPI(2) |
| ThunderSuspensionWindow | 9 | KERNEL32(90) **gdiplus(37)** USER32(31) GDI32(6) ADVAPI32(5) ole32(5) SHLWAPI(4) SHELL32(1) COMCTL32(1) |
| WeakReferences | **1** | KERNEL32(71) |
| ThunderMsgChannel | 5 | KERNEL32(81) USER32(5) ADVAPI32(5) VERSION(3) SHLWAPI(3) |
| XDASEnhancerAddon | 11 | KERNEL32(84) USER32(25) ole32(4) ADVAPI32(3) SHELL32(2) PSAPI(2) … |

### ★ 关键发现

**没有任何 `.node` 导入 `node.exe`、`electron.exe`、`v8.dll` 或 `libnode.dll`。**

它只在 `ThunderMsgChannel.node` 的**导入符号名**里出现 V8 的 mangled symbol
（`?New@FunctionTemplate@v8@@...`），而这些符号**不是从某个 DLL 导入的** ——
它们是宿主进程（Electron 主进程）通过**导出符号表**在运行时解析的。

⇒ `.node` 与宿主之间是**双向符号解析**：
- 宿主向 `.node` 要 `_register_<模块>_`（Node 的 `node_register_module_v80` 协议）
- `.node` 向宿主（`Thunder.exe` 加载的 `XDASKernel.dll`）要 `v8::*` / `node::*`

这也解释了为什么 `XDASKernel.dll` 有 2541 个导出、全是 `v8::`/`node::`/`electron::`
—— **它就是那个导出表**。迅雷把 Electron 运行时改名，然后让 `.node` 直接链它。

复刻含义：如果要用标准 Electron 14，`.node` 需要重新链接到 `electron.exe` 的导入库，
或者改成 N-API。**不能直接复用现成的 `.node` 二进制。**

## 3. 平台特征

- **32 位**：全部 PE32。迅雷至今是 32 位主程序（XP–Win11 全兼容的代价）。
- 用 **gdiplus** 自绘悬浮窗（`ThunderSuspensionWindow` 37 个 gdiplus 导入）。
- `WinMM`(XDAS) + `PSAPI`(XDAS) ⇒ 有计时器和进程内存查询。
- `WS2_32` 只在 `ThunderNewTask` 出现 2 个符号 ⇒ 那里有个小的网络探针（大概是 URL 校验）。

## 4. 依赖树（从两处反推）

### 4.1 `manifest.json` 反推（主 app，216 个模块）

```
babel-runtime                     129 个模块
@xunlei/thunder-ui-vue             40
es-abstract                        10
util.promisify / object.getownpropertydescriptors   4 / 4
es-to-primitive                     3
function-bind / regenerator-runtime / object-keys   2 / 2 / 2
vue-class-component, @xunlei/sget, vue, vuex,
@xunlei/scroll-load, @xunlei/sort-by, @xunlei/tiny-logger,
@xunlei/vuex-connector, vue-property-decorator, reflect-metadata,
babel-helper-vue-jsx-merge-props, define-properties, has,
is-callable, is-date-object, is-regex, is-symbol, foreach      各 1
```

共 **28 个包**。技术栈 = **Vue 2 + Vuex + TypeScript decorator + Babel**。

### 4.2 `XmpPlugin/0.2.1/package.json` 的 `dependencies`（22 个）

```
@xunlei/async-remote        ^2.1.12-dev     ← IPC 远程调用（主/渲染/插件三端）
@xunlei/node-net-ipc        ^1.0.22         ← 本机 socket IPC
@xunlei/sget                ^1.0.3          ← HTTP 客户端
@xunlei/thunder-ui          ^0.20.8         ← UI 基础组件
@xunlei/thunder-ui-vue      0.53.3          ← Vue 版 UI 组件
@xunlei/thunderx-login-main ^1.0.2          ← 迅雷账号登录
@xunlei/tiny-logger         ^1.3.0          ← 日志
@xunlei/vip                 ^1.1.1          ← VIP 判定
@xunlei/vuex-connector      ^0.3.1          ← Vuex 桥

ali-oss                     ^6.3.1          ← 阿里云 OSS（上传）
async-validator             ^1.8.5
axios                       ^0.18.0
compressing                 ^1.5.1          ← 打包（zip/tar）
form-data                   ^3.0.0
jszip                       ^3.1.5
qrcode                      ^1.4.4          ← 扫码登录
vue                         ^2.5.17
vue-property-decorator      ^6.1.0
vuex                        ^3.0.1
xml2js                      ^0.4.19
babel-helper-vue-jsx-merge-props  ^2.0.3
html-webpack-plugin         github:jantimon/html-webpack-plugin
```

### 4.3 构建脚本链（`package.json.scripts`）

```
dll                     webpack --config build/webpack.dll.config.js
prerelease              cross-env BIN_TARGET=Release      npm run dll
preproduct-release      cross-env BUILD_ENV=production BIN_TARGET=ProductRelease npm run dll
release                 cross-env BIN_TARGET=Release node build/build.js
product-release         cross-env BUILD_ENV=production BIN_TARGET=ProductRelease node build/build.js
deploy-release          node build/deploy.js
postbuild               node build/compression.js
start-release           cd ../../../../bin/Release && Thunder.exe
```

⇒ 复刻的产物目录布局是 `bin/Release`（debug）与 `bin/ProductRelease`（成品），
与 PDB 路径里的 `build\ProductRelease\` 完全一致。

### 4.4 devDependencies 里的 electron 版本

```
electron  ^9.2.1
```

注意：**这是插件项目自己声明的**，用于本地开发/调试插件。
**实际运行时是 Electron 14**（`XDASKernel.dll` 的源码路径 + `node_register_module_v80`）。
⇒ 插件按 Electron 9 开发，但要跑在 14 上。复刻时以 14 为准。

## 5. 插件目录

| 插件 | 版本 | 作用 |
|---|---|---|
| Centertip | - | 居中提示弹窗（`dialog-renderer` + Vue） |
| ThunderPanPlugin | 0.7.0 | 迅雷网盘 |
| ThunderXLogin | - | 登录（`qLogin.min.js` 扫码 + `gslb.min.js` 调度 + `xdas.js` 埋点） |
| ThunderXWebXDAS | - | Web 埋点 |
| User | 0.2.20 | 用户中心 |
| VipDownload | 4.8.0 | VIP 下载 |
| VipPluginController | 2.0.1 | VIP 插件控制器 |
| XmpPlugin | 0.2.1 | 主界面框架（唯一带完整 `package.json`） |

每个插件目录下有 `config.json`（启用/版本配置），版本子目录里是打包产物。

## 6. 工具

本目录下的自写分析工具（无第三方依赖）：

| 文件 | 用途 |
|---|---|
| `_pe_dump.py` | PE 头 / 导出表 / 导入表 / PDB 路径 |
| `_extract_contract.py` | 从 webpack bundle 提取 `.node` 的 JS 侧访问契约 |
| `_ns_members.py` | 枚举命名空间对象的成员 |

用法示例：

```bash
python _pe_dump.py <file.node> --exports --imports --pdb
python _extract_contract.py <bundle.js> ThunderHelper ThunderKernel
```
