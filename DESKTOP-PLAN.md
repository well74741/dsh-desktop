# dsh 桌面版实施方案（Electron · Windows · GitHub Releases + npm · npm 托管插件）

> 状态：P0、P1、P2-MVP 已落地（Electron 44 · Windows · 内核子进程 · NSIS + electron-updater · 插件市场面板）· P2 完整体/P3 待续
> 决策摘要：**Electron 壳 + 内核子进程**（同一 electron.exe 以 `ELECTRON_RUN_AS_NODE` 跑官方 `runProfile("web")`，零移植）+ **首发仅 Windows** + **electron-updater / GitHub Releases 分发应用本体，npm 跟随内核** + **应用内 npm 插件托管安装（含版本门禁）**

---

## 1. 总体架构

```
┌────────────────────────── Electron 进程模型 ──────────────────────────┐
│                                                                      │
│  Main Process (Node)                          Renderer (Chromium)     │
│  ┌─────────────────────────────┐   loadURL   ┌──────────────────────┐ │
│  │ 桌面壳 (desktop host)        │ ──────────► │ 官方 Web UI          │ │
│  │  · 窗口/托盘/单实例/退出      │ loopback    │ (内核伺服的 dist，    │ │
│  │  · spawn/监视/关闭内核子进程  │             │  原样复用)            │ │
│  └────────────┬────────────────┘             └──────────────────────┘ │
│  spawn (同一 exe,                    HTTP/WS JSON-RPC ↑                │
│   ELECTRON_RUN_AS_NODE=1,                                        │
│   --expose-internals)                                            │
│  ┌────────────▼───────────────────────────────────────────────────┐  │
│  │ Harness 内核子进程（Node 语义，worker_threads/execPath 正常）      │  │
│  │  = runProfile("web") — 官方 Cordis 插件树                       │  │
│  │  · webServer @ 127.0.0.1:<OS端口> · 前端伺服 + __DSH_BOOT__ 注入  │  │
│  │  · host-plugin-inventory · …（与 dsh web 逐字节同源）             │  │
│  └───────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
   DSH_HOME = 官方默认（$DSH_HOME 或 ~/.dsh）→ 与 `dsh web` 共享
   会话/设置/凭据/插件（磁盘级同步）；桌面升级只换程序本体，不动 DSH_HOME
```

**加载方式**：Renderer 加载 `http://127.0.0.1:<OS随机端口>`（认证 URL，带 token），与官方 `dsh web` 完全同构——零传输层改造、CORS/WS 原样可用。WebServer 自带"拒绝 0.0.0.0 + Host 头校验"防 DNS rebinding；根路径无 token 返回 401。进阶（可选 P3 硬化）：file:/// 自定义协议 + IPC 桥、彻底不开放端口（参考 lansi-ai/dsh-desktop）。

**桌面能力以壳层实现**：窗口/托盘/单实例/退出/浏览器保底均由 Electron 壳负责；托盘"在默认浏览器中打开"指向同一 live 内核。更深的桌面能力（通知、开机自启、协议唤起）后续以 host 插件/Cordis 插件形态挂进 profile，官方升级内核时壳只负责重打包，不动其内部。

---

## 2. 仓库/工程结构（建议 monorepo）

```
dsh-desktop/
├─ DESKTOP-PLAN.md
├─ apps/
│  ├─ desktop/            # Electron 壳（主进程 + preload + 打包配置）
│  │  ├─ src/main/        #   bootstrap、生命周期、托盘、单实例、更新、插件市场 IPC
│  │  ├─ src/preload/     #   contextBridge（严格最小面）
│  │  ├─ package.json     #   electron + electron-builder + electron-updater
│  │  └─ electron-builder.yml
│  └─ host-plugins/       # 桌面能力 Cordis 插件（按官方插件规范编写）
│     ├─ tray/  notifications/  autostart/  updater/  plugin-market/
├─ core/                  # 锁定的 Harness 依赖清单（版本 gate 的数据源）
│  ├─ versions.json       #   @deepseek-ai/dsh 当前锁定版本与兼容区间
├─ dist/                  # 产出：NSIS 安装包 + latest.yml + 增量包
└─ scripts/               # 构建/签名/发布脚本
```

---

## 3. 分阶段任务

### P0 桌面壳（Electron 内嵌内核）—— 已落地 ✅
- [x] 脚手架：electron ^44.2.0（内置 Node 24.20，满足内核 Node ≥22.7 需求）+ electron-builder 待 P1
- [x] 内核进程模型：**Electron 主进程派生"同一 exe + ELECTRON_RUN_AS_NODE=1"的 Node 语义子进程**跑官方 `runProfile("web")`（非主进程内嵌——dsh 依赖 worker_threads 与 `spawn(process.execPath)`，主进程内嵌会拉起新 GUI 实例；实测采用子进程）
  - [x] 子进程加 `--expose-internals`（HMR loader 需要；纯 Node 走 node-addon 回退，Electron 下该回退不可用）
  - [x] `DSH_HOME` 默认 = 官方默认家目录（尊重 $DSH_HOME，否则 ~/.dsh）→ **与 `dsh web` 磁盘级同步**（会话/设置/凭据/插件共享；桌面升级不触碰）
  - [x] 端口 0（OS 分配），从 `webServer` 服务读回；ready 载荷用 connection 的认证 URL（带 token，根路径无 token 返回 401）
  - [x] 前端 dist 随 @deepseek-ai/dsh-web-app 依赖装入（约 4.6 MB），由内核伺服，**零前端改造**
- [x] 窗口：BrowserWindow loadURL(loopback 认证 URL)；关闭=最小化到托盘
- [x] 单实例锁；退出时向子进程 stdin 发 shutdown → 优雅 dispose
- [x] 原生模块：koffi/node-pty 在 web profile 非关键路径（koffi 有平台预编译包；node-pty 仅在 tui 交互场景），不阻塞 P0
- [x] 冒烟验证：`npm run smoke`（纯 Node）→ boot→ready→干净退出 ✅；`npm run selfcheck`（Electron-as-Node 派生内核）✅；`npm start` 桌面运行：窗口标题 DeepSeek Harness、UI HTTP 200 ✅

### P1 分发与自动更新 —— 已落地 ✅
- [x] electron-builder 26 产物：NSIS 安装包（DSH-Studio-0.1.0-setup.exe）+ `latest.yml` + `.blockmap`；应用版本独立于内核版本
  - [x] asar 关闭（内核子进程需真实文件路径）、npmRebuild 关闭（N-API 预编译平台包）；包体约 147 MB（后续可 asar + 内核外置优化）
  - [x] 图标：`assets/icon.ico`（16/32/48/256）→ exe/NSIS；托盘/窗口用 icon.png
- [x] electron-updater 6 接入：打包版启动 10 s 延迟检查 → 自动下载 → 弹窗“立即重启安装” → quitAndInstall；托盘“检查更新…”
  - [x] GitHub Releases provider（`electron-builder.yml` 的 owner/repo 为占位符，发布前必填）
- [x] 数据安全：DSH_HOME 在官方默认位置，更新只换程序本体，天然不触碰数据/会话/插件
- [ ] Windows 代码签名：待证书（未签名，SmartScreen 会提示）
- [ ] 内核跟随策略：`core/versions.json` 锁官方版本 → 官方发版后重打包（待建，机制同 P1 说明）
- [ ] 发布流水线：GitHub Actions 构建 + 上传 Releases（待建；本地已可 `dist:publish`）
- [x] 端到端验证：dev selfcheck ✅ / `win-unpacked` selfcheck ✅ / **安装版** selfcheck ✅（内核 boot→ready→退出 0）；静默安装与卸载退出码 0

### P2 插件托管安装 —— MVP 已落地 ✅（完整版待续）
- [x] 安装器选型：复用官方 `dsh plugin` 的 pnpm 语义 —— 内置 pnpm@10，以 `ELECTRON_RUN_AS_NODE` 用当前 exe 充当 Node 跑（无需用户装 Node/pnpm）
- [x] 插件管理服务：`src/core/pluginctl.mjs`（profile 模板初始化 + pnpm add/remove + dsh.bundle reconcile，与官方同算法）
  - [x] 列出已装（bundles 层/普通依赖区分）
  - [x] npm registry 搜索 + 详情（`src/core/registry.mjs`，latest manifest 标注 dsh.bundle）
  - [x] 安装 / 卸载
- [ ] 版本门禁：官方尚无 manifest 兼容区间的通用约定；待生态规范后按 `core/versions.json` 做
- [x] UI（桌面侧）：`src/panel/` 独立"插件市场"窗口（已安装/搜索/安装/卸载/重启内核），托盘入口 + `start:plugins`
  - [ ] UI 扩展（可选）：改走官方 client-modules/UI slots 内嵌官方设置页（后续）
- [x] 重启生效：内核热重启（stopCore→spawn）+ 主窗口自动重载到新 URL
- [x] E2E 验证：`npm run test:plugins` —— 安装测试 bundle → 依赖+bundles 层写入 → 内核启动出现 `[test-bundle] active` → 卸载 → 再启动干净（隔离 DSH_HOME，位于项目外，与真实 ~/.dsh 同级）

### P3 安全与体验增强（持续，可裁剪）
- [ ] 插件哈希/来源校验、声明式权限清单、安装前权限确认页
- [ ] （可选硬化）file:/// + IPC 桥，零 HTTP 端口
- [ ] 托盘常驻后台会话、系统通知、协议唤起（dsh://…）
- [ ] 插件自动更新检查（npm 侧 diff）

---

## 4. 关键风险与对策

| 风险 | 对策 |
|---|---|
| 官方 `0.1.2-rc.1` API 快速变动 | 锁版本随 app 发版；`versions.json` 兼容区间做门禁；升级显式化 |
| 原生模块 ABI（koffi/node-addon） | P0 专项验证；不行走 electron-rebuild/N-API |
| 无签名 SmartScreen 告警 | P1 内上证书；开发期自签不影响功能 |
| 插件=任意代码（文件/终端/网络） | P3 权限清单 + 来源校验；P2 默认仅官方目录可信源可加 |
| loopback HTTP 暴露面 | 官方已有 Host 头/0.0.0.0 拒绝；Electron 内不对外 |
| 更新破坏已装插件 | 插件在 DSH_HOME，随内核重装后做兼容门禁提示 |

---

## 5. 遗留开放问题（开工前需定）

1. 应用名/品牌（NSIS 安装名、托盘名、协议 scheme）
2. 发布用的 GitHub 仓库（自己的 repo，Releases 公开/私有）
3. Windows 签名证书预算与持有者
4. 是否要把桌面能力 host 插件开源回官方生态（可选加分项）
5. 内核跟随节奏：官方每个 RC 都跟随 vs 攒稳定版再跟

---

## 6. 参考（社区先行者，MIT/公开可读）

- 官方内核：<https://github.com/deepseek-ai/deepseek-harness>（"Everything is a Plugin"，MIT）
- 内嵌内核 + 零 HTTP 端口（推荐参照）：<https://github.com/lansi-ai/dsh-desktop>
- sidecar 方案：<https://github.com/koompi/dsh-desktop>
- 即装即用打包：<https://github.com/lijian-ui/dsh-desktop> · <https://www.npmjs.com/package/@zhengguang-wang/dsh-desktop>
