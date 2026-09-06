# DSH Studio（桌面版）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打包成 **Windows 桌面应用**（Electron 壳 + 官方内核，当前版本 **0.1.19**）。

**核心原则：内核与官方 `dsh web` 完全同源。** 桌面版只负责"外壳体验"，不修改、不注入任何内核语义：同一份 `@deepseek-ai/dsh` 依赖、同一套官方前端、同一个 `DSH_HOME`——桌面版与网页版的数据/插件/会话天然同步。

## 主要功能

- **窗口 + 托盘常驻**：关窗不退出（驻留托盘继续运行内核）；托盘可开主窗口、切网页保底、退出。
- **网页版保底**：内核异常或不想用窗口时，可在默认浏览器打开**同一 live 内核**（同数据）；`--web` 模式等价于官方 `dsh web`。
- **开机自启**（可选"隐藏到托盘启动"，下次登录生效，`userData/settings.json` 持久化）。
- **自动更新**：打包版启动后自动检查 GitHub Releases 并下载安装（托盘/菜单也有"检查更新"）；国内网络走**镜像兜底**（ghfast.top 等）；更新源绑定本仓库 Releases。
- **诊断日志**：打包版全部日志（含内核 stderr）写入 `%APPDATA%\DSH Studio\logs\dsh-studio.log`；内核异常退出弹窗附最近日志并支持"重试 / 网页保底"。
- **插件市场（可视化面板）**：搜索 npm、标注是否真 dsh 插件（`dsh.bundle`）、安装前 peer 兼容分析、一键安装/卸载、**重启内核即生效**；插件安装在 `$DSH_HOME/profiles/web`（与 `dsh web` 共用）。
- **发布中心（面板）**：多项目支持——选任意 git 仓库，看远程/构建状态/最新版本，打开 GitHub Actions 页面，无需命令行。
- **引用文件快捷按钮**：主窗口输入框"+"旁有「引用文件 @」，点击自动输入 `@` 打开官方文件/对话选择器（可精确引用工作区文件，`@` 后可用 Tab 快速选择）。
- **官方内核跟随**：启动约 1 分钟后自动检查 npm 官方 `@deepseek-ai/dsh`（官方源+国内镜像）；发现新版会通知——确认后自动同步内置内核、升版本、发布新版并让应用自动更新（全程无需命令行）。
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
