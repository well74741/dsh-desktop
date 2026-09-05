# DSH Studio（桌面版，P0）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）做成 Windows 桌面应用。**内核与官方 `dsh web` 完全同源**：同一份 `@deepseek-ai/dsh` 依赖、同一套官方前端 dist、同一 `DSH_HOME`——网页版与桌面版天然同步。

## 架构（为什么这样设计）

```
Electron Main（桌面壳）
 ├─ 单实例锁 / 窗口 / 托盘 / 退出生命周期
 └─ spawn 内核子进程：process.execPath + ELECTRON_RUN_AS_NODE=1
       （同一 electron.exe 充当纯 Node 运行时 → worker_threads、
         spawn(process.execPath)、koffi FFI 等 Node 语义全部保持，
         这在内核跑在 Electron 主进程里时会坏掉）
     └─ runProfile("web") —— 官方 profile boot（dsh-base + dsh-web-app）
          ├─ webServer @ 127.0.0.1:<OS 分配端口>
          ├─ 伺服官方前端 dist + __DSH_BOOT__ 注入
          └─ DSH_HOME = $DSH_HOME 或官方默认 ~/.dsh（与 dsh web 共用数据）
```

**网页版保底与同步**：
- 桌面窗口就是网页 UI（同一内核实例）；托盘“在默认浏览器中打开”直接打开同一 live URL（同会话、同数据）。
- `DSH_HOME` 与 CLI 一致 → 会话/设置/凭据/已装插件磁盘级共享。
- 独立保底：官方 `dsh web` 不受任何影响；桌面版另提供 `--web` 模式（不开窗口，等价于 `dsh web`）。

## 目录

```
src/
  core/run.mjs      内核入口：boot 官方 web profile（可被纯 Node 直接跑）
  main/main.mjs     Electron 主进程（壳）
  preload/preload.cjs   context-isolated 桥（当前最小）
scripts/make-icon.mjs   无依赖 PNG 图标生成
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run smoke` | 纯 Node 跑通内核 boot（临时/当前 DSH_HOME），打印 ready 后退出 |
| `npm start` | 桌面模式（窗口 + 托盘） |
| `npm run start:web` | 网页保底模式：不开窗口，默认浏览器打开同一内核 |
| `npm run start:plugins` | 桌面模式并自动打开"插件市场"面板 |
| `npm run selfcheck` | 无头验证 Electron-as-Node 派生内核链路 |
| `npm run test:plugins` | 插件安装→内核激活→卸载 端到端测试（隔离 DSH_HOME） |
| `npm run pack` | 构建未打包目录（release/win-unpacked） |
| `npm run dist` | 构建 NSIS 安装器（release/ 下 setup.exe + latest.yml，不发布） |
| `npm run dist:publish` | 构建并发布到 GitHub Releases（需先填仓库并配 GH_TOKEN） |

> smoke/selfcheck 如需隔离家目录：设 `DSH_HOME` 指向临时目录再运行，避免动到真实 `~/.dsh`。

## P1：打包与自动更新（已落地）

- electron-builder 26 + electron-updater 6，配置见 `electron-builder.yml`。
- **asar 关闭**：内核以 plain-Node 子进程（ELECTRON_RUN_AS_NODE）启动，读不了 asar 内的文件，故应用文件直接放 `resources/app`（代价：包体较大，约 147 MB；后续可改"asar + 内核目录外置"优化）。
- **npmRebuild 关闭**：内核原生依赖走 N-API 预编译平台包，无需 node-gyp 工具链。
- 自动更新：仅打包版启用 → 启动 10 s 后检查 GitHub Releases → 有新版本自动下载 → 弹窗确认后重启安装；托盘有"检查更新…"。退出/关窗逻辑已与 updater 的 quitAndInstall 协调。
- **诊断日志**：打包版所有日志（含内核 stderr）镜像写入 `%APPDATA%\DSH Studio\logs\dsh-studio.log`；内核异常退出时弹窗会附最近日志并给"重试"（自动重试一次后强制退出）。
- 已验证：`win-unpacked` 与**安装版** `--selfcheck` 均通过（内核 boot→ready→退出 0）；静默安装/卸载退出码 0；真实 `~/.dsh` 启动（含与官方 `dsh web` 并存）正常；`latest.yml`、`app-update.yml`、`.blockmap` 均生成。

## P2-MVP：插件市场（可视化，已落地）

- **入口**：托盘 → "插件市场…"，或 `npm run start:plugins`。
- **面板**（独立窗口，`src/panel/`，与官方 UI 同风格深色）：
  - 已安装：列出 profile 依赖，区分 **bundle 层**（dsh 插件）/普通依赖，显示 `bundles` 层顺序与路径；
  - 插件市场：npm 搜索（`src/core/registry.mjs`），逐项标注 **"dsh 插件（bundle）"** 或 **"普通包"**，一键安装/卸载；
  - "重启内核以生效"：内核热重启并把主窗口重载到新 URL。
- **引擎**（`src/core/pluginctl.mjs`）：与官方 `dsh plugin` 同语义 —— profile 缺失时按模板初始化 → **内置 pnpm**（以本 exe `ELECTRON_RUN_AS_NODE` 运行，用户机器无需装 Node/pnpm）在 profile 目录执行 add/remove → 按 `dsh.bundle` 声明 reconcile `bundles` 层。
- **网页版同步**：插件安装在 `$DSH_HOME/profiles/web`（与 `dsh web` 共用同一目录）→ 双方下次启动自动可见；同一运行实例内可用托盘"在默认浏览器中打开"看同一 live 内核。
- **验证**：`npm run test:plugins` 全绿（安装 file 测试 bundle → 依赖+bundles 层写入 → 内核重启日志出现 `[test-bundle] active` → 卸载 → 再启动干净）。
- 备注：当前官方/社区可直接安装的 dsh bundle 还很少（npm 上已有 `dsh-plugin` 社区市场索引可搜）；普通 npm 包可装但不进 bundles 层（面板会标注）。

## 发布（GitHub：https://github.com/well74741/dsh-desktop）

**自动（推荐）**：`.github/workflows/release.yml` 已就位，且使用仓库内置的 `GITHUB_TOKEN`（**无需创建 PAT / 无需添加 Secret**）。流程：升 `package.json` 版本 → `git tag v<版本>` → `git push origin v<版本>` → Actions 自动构建 NSIS 并发布到 Releases。

**手动（可选）**：本地 `GH_TOKEN=<你的 classic PAT> npm run dist:publish`（先打 tag）或 `npm run dist` 后在 Releases 网页手动上传 `setup.exe`+`latest.yml`+`blockmap`。仅手动发布才需要建 PAT（Settings → Developer settings → Personal access tokens → Tokens (classic) → 勾 `repo`）。

> Windows 代码签名证书暂缺（未签名，SmartScreen 会提示）；获取证书后可加 `win.signingHashAlgorithms`/证书配置或在 Actions 注入 CSC 环境变量。

### 已知边界（P0 + P1）

- 已验证环境：Electron 44.2.0（内置 Node 24.20）+ @deepseek-ai/dsh 0.1.2-rc.1；内核要求 Node ≥ 22.7（zstd、TS strip API）。
- `--dir` 构建不生成 `app-update.yml`（NSIS/发布构建才会）；electron-updater 在 dev（未打包）下自动禁用。
- 端口为 OS 分配（loopback only）；内核日志里的 `dsh web:` 行是官方 printUrl 输出，无碍。
- 单实例：重复启动会聚焦已有窗口/托盘实例。
- 建议不要与 `dsh web` 同时常驻写同一 `DSH_HOME`；同步用托盘"在默认浏览器中打开"（同一 live 内核）即可。
- 占位图标由 `scripts/make-icon.mjs` 生成（icon.png/icon-256.png/icon.ico），后续替换正式品牌图。
- 插件市场（P2-MVP）边界：安装/卸载走 pnpm（需网络与 npm registry）；装完需"重启内核"生效；面板标注的 "bundle/普通包" 依据 latest manifest 的 `dsh.bundle`；生态尚小，多数官方能力已内置于官方 bundles。
- **打包依赖经验（0.1.3 修复）**：上游多个 `@deepseek-ai/*` 把运行库声明为 **peerDependency**（npm 开发树会自动装、但 electron-builder 不打 peer）。0.1.2 及更早在真实装机时主进程报 `ERR_MODULE_NOT_FOUND: '@deepseek-ai/cordis-plugin-group'`。已把 peer 缺失包补为根正式依赖。**注意**：在 `release/`（工程目录内）自检会因 Node 向上解析命中开发树 `node_modules` 而假通过；装机级验证必须在工程目录之外进行（本次在 `Deepseek_projects\verify-dsh` 验证通过）。
- **桌面版自知与网页保底**：内核与官方 `dsh web` 逐字节同源，**不注入**"桌面版"语义（开发/提示词零差异）；仅外壳层自知。内核子进程会收到 `DSH_STUDIO_RUNTIME=desktop|web` 环境标记，供将来 host 插件使用。若桌面窗口化链路异常：错误框可点 **"网页模式保底运行"**（同内核、默认浏览器打开、无窗口），连续两次失败会自动进入该兜底；也可直接 `npm run start:web` 或托盘"在默认浏览器中打开"。
- **P2 完整体：兼容门禁（联网能力继承）**：安装/搜索仍走 npm registry（联网能力未受限）；安装前对 registry 包做 **peer 兼容分析**（`src/core/compat.mjs`，对照本应用随附的整个 `@deepseek-ai` scope 版本：cordis 主版本不匹配标 danger，其余 warn）并弹窗提示，可继续或取消。开发便利：设 `DSH_STUDIO_ALLOW_MULTI=1` 可跳过单实例锁（仅供自检/CI）。
- **P2 完整体：面板第二弹**：面板元信息显示内核基线（dsh/cordis 版本、随附 @deepseek-ai 包数）；已装项支持逐个"检查"兼容；安装同名已装包会二次确认；`core/versions.json`（`npm run snapshot:core` 生成）固化内核依赖基线，供内核跟随检查与文档使用。
- **P3 桌面体验（第一批）**：托盘菜单显示运行模式（desktop/web 保底状态），新增 **"开机自启"** 开关（`app.setLoginItemSettings`）；打包版注册 `dsh://` 协议与 Windows AppUserModelId（通知/任务栏身份，`dsh://` 深链为后续预留）。
- **P3 桌面体验（第二批·0.1.6）**：系统通知——首次"关窗驻留托盘"提示（可点通知恢复窗口）、内核重启（插件/变更生效，窗口隐藏时）与网页保底就绪时通知；托盘即后台常驻会话（关窗不退出、核心继续）。
- **P3 桌面体验（第三批）**：`--hidden` 纯净启动（无主窗口、仅托盘，供开机自启"隐藏到托盘"）；托盘"开机自启"+"自启时隐藏到托盘（下次登录生效）"双开关（`userData/settings.json` 持久化，登录项带 `--hidden` 参数）；`dsh://` 深链处理（二次实例 argv 或首启命令行；`dsh://studio/web` 走浏览器，其余聚焦主窗口）。打包程序为 GUI 子系统：**不产生/不占用控制台窗口，双击即开**。
