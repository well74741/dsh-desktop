# AGENTS.md — 给在这个仓库工作的 AI 助手

> 维护者：几乎零编程经验的中文用户。目标是"减少试错、讲人话"。
> 请先读本文件；涉及 GitHub/发布先读 `GITHUB-SYNC-NOTES.md`。

## 一、沟通铁律
- 用大白话解释（类比：快递/仓库/零件/电路/楼层），先结论后细节；
- 术语首次出现必须翻译（见仓库外 `D:\Practice\AItest\Deepseek_projects\开发事项预读\02-解释风格指南.md`）；
- 报错先安抚（要不要紧、该做什么），再贴细节；
- 能用一个按钮完成的事，别让用户敲命令。

## 二、项目是什么
- DSH Studio：把 DeepSeek Harness（`dsh web` 内核）做成 Windows 桌面应用（Electron 44）。
- 内核与网页版逐字节同源，**不要改内核语义/官方 UI**；桌面壳在外层（窗口/托盘/菜单/更新/插件市场/发布中心）。
- 发布：GitHub Actions `release`（网页 Run workflow，patch/minor/major）；exe 由云端构建。
- 用户在国内，GitHub 常 502：脚本带重试/自动 pull --rebase；更新失败给手动下载入口。

## 三、重要经验指针（详情看对应文件）
- GitHub 同步/发布全踩坑：见仓库根 `GITHUB-SYNC-NOTES.md`（含通用版在 开发事项预读\01）。
- 打包铁律：Electron≥44（Node≥22.7）；electron-builder 不打包 peer → 缺包补正式依赖；装机验证放**工程目录外**；asar 关闭；CJS 用 createRequire；面板 CSP 必须放行 inline script。
- 插件：只有声明 `dsh.bundle` 的包才是真插件（标签 (bundle)）；普通包不激活。
- 一键工具：父目录 `studio-tool.bat`（按钮：上传/一键发版/重试/下载页…）；仓库内 `push.bat`/`release.bat`/`push-tag.bat`。
- 开发自检：`npm run selfcheck`（可设 `DSH_STUDIO_ALLOW_MULTI=1`）；面板功能用 `npm start` + 菜单/托盘验证。

## 四、维护约定
- 经验教训只加"结论型"短条目，不粘贴整段日志；
- 通用经验进 `开发事项预读\`，项目专属进 `GITHUB-SYNC-NOTES.md`，别重复两处；
- 改完代码记得提醒用户：本地 dev 立即生效，进安装包需发布新版。
