# DSH Studio —— GitHub 同步/发布 经验备忘

> 用途：把「DSH Studio 桌面版（DeepSeek Harness 壳）」开发中的 GitHub 同步与发布踩坑浓缩成可复用记忆。**新对话开场可直接粘贴本文件**，减少重复试错。
> 项目：`D:\Practice\AItest\Deepseek_projects\dsh-desktop` · 仓库：`https://github.com/well74741/dsh-desktop`（公开）
> 当前发布模型：electron-builder NSIS + GitHub Releases + electron-updater；Actions 单任务「Run workflow」发布。

---

## 0. 一页 SOP（日常用）

1. 我/你在本地改代码 → 本地验证（`npm start` / 面板；可离线）。
2. 上传代码：双击 **`studio-tool.bat`** → 按钮 1「Commit & Push code」（或 `push.bat`）。
3. 发版：双击 **`studio-tool.bat`** → 按钮 2「One-click Release」（或 `release.bat`）→ 选 patch/minor/major → 自动升级版本、打标签、推送 → **Actions 自动构建发布**（几分钟后 Releases 出新版）。
4. 用户端自动更新（托盘/菜单「检查更新…」）。

一键工具文件：`studio-tool.bat/.ps1`、`push.bat`、`release.bat`、`scripts/{push-code,do-release,bump-version,release}.mjs`。

---

## 1. 环境事实（重要前提）

- **国内访问 GitHub 不稳**：`api.github.com`、`objects.githubusercontent.com`（更新下载）经常 502/超时；浏览器 github.com 靠 steamcommunity302/hosts 部分可用且不稳定。
- **GitHub Actions 构建在云端**，不受本地网络影响——本地只需能推送代码。
- **内置 `GITHUB_TOKEN` 推送的 tag/提交不会触发其它 workflow**（防递归）。⇒ 网页一键任务必须**在同一次 job 内完成构建发布**，不能依赖“push tag → 再触发 build”。
- GitHub Desktop 可做图形化 push；它**不支持打标签**——标签统一交给 Actions/脚本，本地无需管理。

## 2. 发布配置事实（本仓库已固化）

- `electron-builder.yml`：`publish.provider: github`，`owner: well74741`，`repo: dsh-desktop`，**`releaseType: release`（非草稿，草稿用户下载不到/自动更新读不到）**。
- `.github/workflows/release.yml`：**单 job `release`**，触发 = `workflow_dispatch`(patch/minor/major) 或 tag `v*`。
  - dispatch 分支：`shell: bash`（**必须**，默认 PowerShell 不认 `$(...)`）→ `node scripts/bump-version.mjs` → commit package.json+lock → tag → push(main+tag) → **同一 job 继续** npm ci + electron-builder `--publish always`。
  - `scripts/bump-version.mjs` 需**同时写 package.json 与 package-lock.json 的 version**（否则 `npm ci` 报锁不一致）。
- Actions 无需任何 Secret/PAT（用 `secrets.GITHUB_TOKEN`，`permissions: contents: write`）。

## 3. 同步踩坑清单（按“何时遇到”排序）

### A. 代码/仓库层
1. **git 首次 commit 前必须设身份**：`git config user.name "well74741"`、`user.email "well74741@users.noreply.github.com"`（本项目 .git 已设）。
2. **remote 被拒 `fetch first`**：网页 Run workflow 会往 main 推“chore: release vX”的 bump 提交，本地会落后 → `git pull origin main --rebase` 再 `git push origin main`（多轮遇到都这么处理）。
3. **合并冲突常见于 `.github/workflows/release.yml` / `scripts/bump-version.mjs`**（网页手改 vs 本地改同一文件）→ 用本地正确版：`git checkout --ours <file>`（git checkout 参数注意在冲突中）后 `git add`+`git commit --no-edit`；**保留含 `shell: bash` 的那份**。
4. **502 是瞬时网络问题，不是代码错误**：本地 push 重试即可（一键脚本已内置 3 次重试）。
5. `git fetch/ls-remote` 在沙箱或 hosts 不稳时会 502；`git show origin/main:path` 可离线看远端文件内容，用于确认“远端是不是旧工作流”。
6. **幽灵标签**（Run 失败/旧流程只升版本没出包产生，如 v0.1.10~0.1.12）：没有 Release 的空 tag 无害，但会占版本号 → 想复用需在 Tags 页删除。
7. 判断发布是否真的成功：看 **Releases 页是否有该版本 + 3 个文件**(setup.exe/.blockmap/latest.yml)，不要只看 Actions 绿。

### B. 构建/打包层（桌面端自用）
8. **Electron 需内置 Node ≥ 22.7**（内核用到 zstd、`stripTypeScriptTypes`）→ 用 Electron 44（内置 Node 24.x）。Electron 33 会因缺 API 崩溃。
9. **npm 11 默认拦 install 脚本**：electron/koffi/node-pty 等需先 `npm install-scripts approve <pkg>`（已写进 package.json `allowScripts`）；electron 二进制缺失时手动 `node node_modules/electron/install.js`。
10. **electron-builder 不打包 peerDependencies**：上游 `@deepseek-ai/*` 大量 peer 依赖（如 cordis-plugin-group）→ 装机缺包崩溃 `ERR_MODULE_NOT_FOUND`。已把缺的 24 个 peer 补成根 dependencies。
11. **装机验证必须在工程目录外**：`release/` 在开发目录内时，Node 向上解析会命中开发 node_modules，掩盖缺包 → 自检假通过。装到 `Deepseek_projects\verify-*` 等外部目录才算真验证。
12. **asar 关闭**：内核以 plain-Node 子进程(ELECTRON_RUN_AS_NODE)启动，读不了 asar → `asar: false`；`npmRebuild: false`（原生走 N-API 预编译）。
13. **electron-updater 是 CJS 且 autoUpdater 经 Object.defineProperty 导出**：ESM `import { autoUpdater }` 会报错 → 用 `createRequire` 加载。
14. `import.meta.resolve('pnpm')` 会解析到 pnpm 的 **package.json**（直接执行是静默空跑）→ 需读其 `bin.pnpm` 再取 `bin/pnpm.cjs`。
15. pnpm 的 `--no-audit/--no-fund` 不是 `pnpm add` 的选项；pnpm **不要**在“父工程目录”里跑 add（会把它当根并把别的包移进 node_modules/.ignored）。
16. 主进程要带 `--expose-internals` 派生内核（HMR loader 需要）；窗口/托盘图标路径要从 `src/main` 起算 `../../assets`。
17. GUI 程序无控制台 → 日志镜像到 `%APPDATA%\DSH Studio\logs\dsh-studio.log`（排障先看它）；单实例锁残留会导致“自检静默退出”（dev 可用 `DSH_STUDIO_ALLOW_MULTI=1`）。
18. 自检无输出/弹 “Error” 对话框 = 主进程加载期异常（查 duplicate declaration/import 错），stderr 会打印真实原因。

### C. 更新/发布体验层
19. 手动「检查更新」旧版失败**只写日志**，体验是“点了没反应” → 新版：即时 toast「正在检查…」+ 自动重试3次 + 失败弹原因 + 托盘「打开下载页（手动更新）」兜底。
20. 自动更新要求 GitHub 上有**正式(non-draft) Release** 且含 `latest.yml`；草稿/重复 release 会造成混乱（每版只留一个带 latest.yml 的）。
21. 若 CN 网络仍不稳：当前兜底=手动下载页；**镜像更新源（可切换/自动回退）是待办**——需一个国内可达的静态源（Gitee/OSS 等）放 latest.yml+exe。

---

## 4. 常用命令速查

```powershell
cd D:\Practice\AItest\Deepseek_projects\dsh-desktop
npm start            # dev 跑应用（含菜单栏/插件市场/发布中心）
npm run selfcheck    # 无头自检内核（可 DSH_STUDIO_ALLOW_MULTI=1 避免锁冲突）
npm run test:plugins # 插件安装→激活→卸载 E2E（用项目外 dsh-e2e-home）
npm run smoke        # 纯 Node 内核 boot
git show origin/main:.github/workflows/release.yml | findstr web-tag  # 应无输出=新版单job
```

## 5. 下次直接可用的“开场白”（copy-paste 给新对话）

> 项目 DSH Studio 桌面壳：D:\Practice\AItest\Deepseek_projects\dsh-desktop，仓库 github.com/well74741/dsh-desktop。
> 请先读仓库根 GITHUB-SYNC-NOTES.md（同步/发布踩坑记忆）再动手。当前发布=Actions Run workflow(patch)；用户在国内，GitHub 502 频发，更新兜底=托盘手动下载页；镜像源待做。
