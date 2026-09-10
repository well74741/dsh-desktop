# DSH Studio（桌面版）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成 **Windows 桌面应用**（Electron 壳 + 官方内核；版本号以 Releases 为准，当前 **0.1.26**）。

**核心原则：内核与官方 `dsh web` 完全同源。** 桌面版只负责"外壳体验"，不修改、不注入任何内核语义：同一份 `@deepseek-ai/dsh` 依赖、同一套官方前端、同一个 `DSH_HOME`——桌面版与网页版的数据/插件/会话天然同步。

## 主要功能

- **窗口 + 托盘常驻**：关窗不退出（驻留托盘继续运行内核）；托盘可开主窗口、切网页保底、退出。
- **网页版保底**：内核异常或不想用窗口时，可在默认浏览器打开**同一 live 内核**（同数据）；`--web` 模式等价于官方 `dsh web`。
- **开机自启**（可选"隐藏到托盘启动"，下次登录生效，`userData/settings.json` 持久化）。
- **自动更新**：打包版启动后自动检查 GitHub Releases 并下载安装（托盘/菜单也有"检查更新"）；国内网络走**镜像兜底**（ghfast.top 等）；更新源绑定本仓库 Releases。
- **诊断日志**：打包版全部日志（含内核 stderr）写入 `%APPDATA%\DSH Studio\logs\dsh-studio.log`；内核异常退出弹窗附最近日志并支持"重试 / 网页保底"。
- **插件市场（可视化面板）**：搜索 npm、标注是否真 dsh 插件（`dsh.bundle`）、**卡片显示 GitHub ⭐ 星数与 npm 月下载量，支持按 星数/下载量 排序**，可"只看 dsh 插件"（多关键词覆盖 + 主进程真实过滤翻页）；支持**从 GitHub/本地路径安装**没上 npm 的插件；**已安装页显示内置内核版本并可一键检查官方更新**；安装前 peer 兼容分析、一键安装/卸载、**重启内核即生效**；插件安装在 `$DSH_HOME/profiles/web`（与 `dsh web` 共用）。
- **发布中心（引导向导）**：全程不碰账号信息——按状态自动分步引导：①初始化本地仓库 → ②🔐 打开网页建空仓库（附填写清单）→ ③粘贴地址连接并推送 → ④日常"提交并推送/拉取"→ ⑤🔐 打开 Releases 网页发成品；默认停靠开发仓库时有提示条；**高级功能收进折叠区**（打版本 tag、构建状态、网络检查、凭据/账号…），支持任意项目、自动用当前分支、不写死 dsh-desktop。
- **手机接力（局域网）**：输入框旁"+"有「引用文件 @」；菜单栏 **📱 手机接力**：开启后通过**免重启转发桥**让同一 WiFi 的手机访问同一内核（二维码/完整地址，30 天免登录），开启期间阻止电脑休眠，桌面/手机数据实时同屏。
- **官方内核自动跟随**：仓库内置每日巡检（GitHub Actions `kernel-watch`）。官方 `@deepseek-ai/dsh` 一发布新内核，巡检会自动同步依赖、升版本并发布新版安装包；桌面版的**自动更新**随后提示你升级即可，全程无需任何手动操作。
- **`dsh://` 深链与 Windows 通知身份**（打包版注册，为后续预留）。

## 架构

```
Electron Main（桌面壳，src/main/）
 ├─ 单实例锁 / 窗口 / 托盘 / 菜单 / 自动更新 / 内核巡检
 └─ spawn 内核子进程：process.execPath + ELECTRON_RUN_AS_NODE=1
      （同一 electron.exe 充当纯 Node 运行时，Node 语义完整保留）
      └─ runProfile("web") —— 官方 profile boot（src/core/run.mjs）
           ├─ webServer @ 127.0.0.1:<OS 分配端口>（loopback）
           ├─ 伺服官方前端 + __DSH_BOOT__ 注入
           └─ DSH_HOME = $DSH_HOME 或官方默认 ~/.dsh
```

要点：
- **asar 关闭**：plain-Node 内核子进程读不了 asar，应用文件直接放 `resources/app`（代价：安装包约 143 MB）。
- **npmRebuild 关闭**：原生依赖走 N-API 预编译平台包，无需 node-gyp 工具链。
- 打包内置内核基线见 `core/versions.json`（`npm run snapshot:core` 生成）。

## 安装与更新

- 下载：<https://github.com/well74741/dsh-desktop/releases>（`DSH-Studio-x.y.z-setup.exe`）。
- 安装后：应用内菜单/托盘 **检查更新** 自动下载新版本并重启安装；也可打开下载页手动装。
- 更新源与本仓库 Releases 绑定；无需任何 GitHub 账号即可使用与更新。

## 常用命令（开发）

| 命令 | 作用 |
|---|---|
| `npm start` | 桌面模式（窗口 + 托盘） |
| `npm run start:web` | 网页保底模式（不开窗口，默认浏览器打开同一内核） |
| `npm run start:plugins` | 桌面模式并自动打开"插件市场" |
| `npm run selfcheck` | 无头验证 Electron-as-Node 派生内核链路 |
| `npm run test:plugins` | 插件安装→激活→卸载 端到端测试（隔离 DSH_HOME） |
| `npm run dist` | 本地构建 NSIS 安装器（不发布） |
| `npm run snapshot:core` | 固化内置内核版本基线到 `core/versions.json` |
| `node scripts/sync-kernel-release.mjs` | 同步官方内核到最新并发布新版（内核跟随用） |

## 发布流程

- **网页一键**：仓库 Actions → `release` → Run workflow → 选 patch/minor/major（任务自动升版本、提交、打标签、构建并发布）。
- **Tag 直发**：`git push origin vX.Y.Z` 自动构建发布（内置 `GITHUB_TOKEN`，无需 PAT）。
- 发布步骤会先删除该 tag 的旧 Release 行，再一次性上传完整文件（`setup.exe + latest.yml + .blockmap`），避免自动更新读到残缺发布。

## 已知边界

- **未签名**：Windows 代码签名证书暂缺，SmartScreen 可能提示"未知发布者"（属正常，点"仍要运行"）。
- 建议不要与官方 `dsh web` 同时常驻写同一 `DSH_HOME`；跨窗口同步用托盘"在默认浏览器中打开"（同一 live 内核）。
- 开发模式（未打包）下自动更新自动禁用；updater 诊断日志照常。
- 桌面版从 0.1.3 起已把上游 peerDependencies 补齐为根依赖，装机级验证须在工程目录外进行（Node 会向上解析开发树导致假通过）。
- **开发依赖用 pnpm 安装**（仓库已配置 `nodeLinker: hoisted` 扁平布局，electron-builder 才能正确收集依赖）：不要用 `npm ci`/`npm install` 覆盖（会损坏 pnpm 的 node_modules，曾导致 `npm start` 起不来）；跑 `pnpm install` 即可。CI 现在也走 pnpm（`pnpm install --frozen-lockfile`），npm ci 仅作失败兜底。
- 官方可公开安装的 dsh 插件目前较少（多数为内置模块），插件市场"只看 dsh"列出的是已发现的全部，正常现象。
- **升级后的界面缓存**：版本变化时应用会自动清一次网页缓存；若界面仍报 `Failed to load plugins`，应用会**自动清缓存并强制重载一次**（自愈），无需手动删 `%APPDATA%\DSH Studio` 里的缓存目录。
