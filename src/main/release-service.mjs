/**
 * DSH Studio — release center (main-process side). Works on ANY local git
 * project: choose a folder once (persisted), then commit/push/tag/publish.
 * Publish = bump(if npm) + tag + push; whether Actions builds depends on the
 * project's own CI.
 */
import { app, dialog, ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadSettings, saveSettings } from "./settings.mjs";

let repoRoot = null;
let panelWindows = () => [];

export function configureReleaseService({ getWindows, gitRepoRoot, execPath }) {
	if (getWindows) panelWindows = getWindows;
	// Prefer the last project the user chose (persisted); fall back to the
	// repo this app was started from when that path is a real git checkout.
	const saved = loadSettings().releaseProject;
	if (typeof saved === "string" && existsSync(join(saved, ".git"))) {
		repoRoot = saved;
		explicitProject = true;
	} else if (gitRepoRoot && existsSync(join(gitRepoRoot, ".git"))) {
		repoRoot = gitRepoRoot;
		explicitProject = false;
	}
	if (execPath) execNode = execPath;
}

// 该项目是用户主动选的（true）还是启动时默认带上的开发仓库（false）。
let explicitProject = false;

let execNode = process.execPath;

function broadcast(payload) {
	for (const win of panelWindows()) {
		if (!win.isDestroyed()) win.webContents.send("release:event", payload);
	}
}

function gitAvailable() {
	return repoRoot !== null && existsSync(join(repoRoot, ".git"));
}

/** Current branch name of the selected project (generic; no hard-coded main). */
async function headBranch() {
	if (!gitAvailable()) return "main";
	try {
		const { out } = await collect("git", ["symbolic-ref", "--short", "-q", "HEAD"]);
		const branch = (out || "").trim();
		return branch === "" ? "main" : branch;
	} catch {
		return "main";
	}
}

const FALLBACK_ACTIONS = "https://github.com";

/** Derive the GitHub Actions URL of the current project's origin remote. */
async function actionsUrl() {
	if (!gitAvailable()) return FALLBACK_ACTIONS;
	try {
		const { out } = await collect("git", ["remote", "get-url", "origin"]);
		let url = (out || "").trim();
		if (url === "") return FALLBACK_ACTIONS;
		url = url.replace(/^git@([^:]+):/u, "https://$1/").replace(/^https:\/\/[^@/]+@/u, "https://").replace(/\.git$/u, "");
		return /^https?:\/\//u.test(url) ? `${url}/actions` : FALLBACK_ACTIONS;
	} catch {
		return FALLBACK_ACTIONS;
	}
}

function readPkgVersion() {
	try {
		return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version ?? null;
	} catch {
		return null;
	}
}

function runGit(args) {
	return new Promise((resolve) => {
		broadcast({ kind: "line", text: `$ git ${args.join(" ")}` });
		const child = spawn("git", args, {
			cwd: repoRoot,
			env: process.env,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});
		const read = (stream, kind) => {
			stream.setEncoding("utf8");
			stream.on("data", (chunk) => {
				for (const line of chunk.split(/\r?\n/u)) if (line.trim() !== "") broadcast({ kind, text: line });
			});
		};
		read(child.stdout, "out");
		read(child.stderr, "err");
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", (error) => {
			broadcast({ kind: "err", text: `git 启动失败: ${String(error?.message ?? error)}` });
			resolve(1);
		});
	});
}

/** Push branch with auto pull --rebase once when rejected (remote ahead). */
async function pushBranch(args) {
	const branch = args[1] ?? "main";
	let code = await runGit(["push", ...args]);
	if (code !== 0) {
		broadcast({ kind: "phase", text: `远端有更新，先 pull --rebase origin ${branch} 再推送…` });
		await runGit(["pull", "--rebase", "origin", branch]);
		code = await runGit(["push", ...args]);
	}
	return code;
}

/** Push tag with a few retries (no rebase; tags rarely conflict). */
async function pushTag(args) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const code = await runGit(["push", ...args]);
		if (code === 0) return 0;
		broadcast({ kind: "line", text: `标签推送第 ${attempt} 次失败，稍后重试…` });
		await sleep(4000);
	}
	return 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function collect(executable, args, env = process.env) {
	return await new Promise((resolve) => {
		const child = spawn(executable, args, { cwd: repoRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("close", () => resolve({ out: out.trim(), err: err.trim() }));
		child.on("error", () => resolve({ out: "", err: "spawn failed" }));
	});
}

async function info() {
	const chosen = repoRoot !== null;
	if (!chosen) return { ok: true, available: false, chosen: false, defaultProject: false, root: null, reason: "还没有选择项目目录。" };
	if (!gitAvailable()) {
		return {
			ok: true, available: false, chosen: true, defaultProject: !explicitProject, hasGit: false, root: repoRoot,
			reason: "该目录还不是 git 仓库（没有 .git）。可以用向导里的“初始化并首次提交”开始。"
		};
	}
	const branch = (await collect("git", ["branch", "--show-current"])).out || "";
	const rawRemote = (await collect("git", ["remote", "get-url", "origin"])).out.trim();
	const remote = rawRemote === "" ? "" : rawRemote.replace(/^https:\/\/[^@/]+@/u, "https://");
	const tag = (await collect("git", ["describe", "--tags", "--abbrev=0"])).out || "";
	const dirty = (await collect("git", ["status", "--porcelain"])).out;
	return {
		ok: true,
		available: true,
		chosen: true,
		defaultProject: !explicitProject,
		hasGit: true,
		hasRemote: rawRemote !== "",
		root: repoRoot,
		branch,
		remote,
		lastTag: tag || "(无标签)",
		version: readPkgVersion(),
		dirty: dirty === "" ? 0 : dirty.split("\n").length,
		statusText: dirty === "" ? "工作区干净" : `有 ${dirty.split("\n").length} 项未提交改动`
	};
}

async function doCommitPush(message) {
	if (!gitAvailable()) return { ok: false, error: "非开发目录，无法提交" };
	if (!message || message.trim() === "") return { ok: false, error: "请填写提交说明" };
	if ((await runGit(["add", "-A"])) !== 0) return { ok: false, error: "git add 失败" };
	if ((await runGit(["commit", "-m", message.trim()])) !== 0) return { ok: false, error: "git commit 失败（可能没有改动）" };
	const branch = await headBranch();
	const code = await pushBranch(["origin", branch]);
	if (code !== 0) return { ok: false, error: "git push 失败（网络/登录问题；已含 rebase 与提示，可稍后重试）" };
	return { ok: true };
}

const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;
const KINDS = ["patch", "minor", "major"];

/** Write an explicit version into package.json + package-lock.json. */
function setVersionTo(next) {
	const pkgPath = join(repoRoot, "package.json");
	const lockPath = join(repoRoot, "package-lock.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	pkg.version = next;
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
	try {
		const lock = JSON.parse(readFileSync(lockPath, "utf8"));
		if (lock.version !== undefined) lock.version = next;
		if (lock.packages?.[""]?.version !== undefined) lock.packages[""].version = next;
		writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf8");
	} catch {
		/* no lockfile */
	}
	return next;
}

async function doPublish(kindOrVersion) {
	if (!gitAvailable()) return { ok: false, error: "非开发目录，无法发布" };
	if (!existsSync(join(repoRoot, "package.json"))) {
		return { ok: false, error: "该项目没有 package.json（发布按钮只适用于带版本文件的项目）。桌宠这类项目请用“提交并推送代码”传源码。" };
	}
	const dirty = (await collect("git", ["status", "--porcelain"])).out;
	if (dirty !== "") return { ok: false, error: `工作区有未提交改动（${dirty.split("\n").length} 项），请先「提交并推送代码」` };

	broadcast({ kind: "phase", text: "确定新版本号…" });
	let newVersion;
	if (PLAIN_VERSION.test(kindOrVersion)) {
		newVersion = setVersionTo(kindOrVersion);
	} else if (KINDS.includes(kindOrVersion)) {
		const bumpArgs = [join(repoRoot, "scripts", "bump-version.mjs"), kindOrVersion];
		// The main process is the Electron executable — run the bump script as plain Node.
		const bumped = await collect(execNode, bumpArgs, { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
		newVersion = bumped.out;
	} else {
		return { ok: false, error: `版本类型/号无效: ${kindOrVersion}` };
	}
	if (!PLAIN_VERSION.test(newVersion)) {
		return { ok: false, error: `版本升级失败: ${newVersion}` };
	}
	broadcast({ kind: "line", text: `新版本: ${newVersion}` });

	if ((await runGit(["add", "package.json", "package-lock.json"])) !== 0) return { ok: false, error: "git add 失败" };
	if ((await runGit(["commit", "-m", `chore: release v${newVersion}`])) !== 0) return { ok: false, error: "commit 失败" };
	const tags = (await collect("git", ["tag", "--list", `v${newVersion}`])).out;
	if (tags === "") {
		if ((await runGit(["tag", `v${newVersion}`])) !== 0) return { ok: false, error: "打标签失败" };
	}
	if ((await pushBranch(["origin", await headBranch()])) !== 0) return { ok: false, error: "push 分支失败（已尝试自动 rebase，仍失败请稍后重试）" };
	if ((await pushTag(["origin", `v${newVersion}`])) !== 0) return { ok: false, error: "push 标签失败（构建不会触发，请重试）" };
	broadcast({ kind: "phase", text: `已推送 v${newVersion}（若仓库配了 Actions 将自动构建发布）` });
	return { ok: true, version: newVersion };
}

export function registerReleaseIpc() {
	ipcMain.handle("release:choose", async () => {
		const previous = loadSettings().releaseProject;
		const dialogOpts = {
			title: "选择要管理/上传的项目文件夹（可以是还没建 git 的普通文件夹）",
			properties: ["openDirectory"]
		};
		// 从上次所选目录的“上一级”打开，避免每次都回到默认的“下载”。
		if (typeof previous === "string" && previous !== "") {
			try { dialogOpts.defaultPath = dirname(previous); } catch { /* ignore */ }
		}
		const result = await dialog.showOpenDialog(dialogOpts);
		if (result.canceled || !result.filePaths?.[0]) return { ok: false, error: "未选择" };
		const dir = result.filePaths[0];
		repoRoot = dir;
		explicitProject = true;
		saveSettings({ releaseProject: dir });
		broadcast({ kind: "line", text: `已切换项目：${dir}` });
		return { ok: true, info: await info() };
	});

	ipcMain.handle("release:ping", async () => {
		const start = Date.now();
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 5000);
			const res = await fetch("https://api.github.com", { method: "HEAD", signal: controller.signal });
			clearTimeout(timer);
			return { ok: res.status < 500, ms: Date.now() - start, detail: String(res.status) };
		} catch (error) {
			return { ok: false, ms: Date.now() - start, detail: String(error?.message ?? error) };
		}
	});

	ipcMain.handle("release:info", async () => info());

	ipcMain.handle("release:net", async () => {
		const probe = async (name, url) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 8000);
			try {
				const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
				const code = res.status;
				const state = code < 500 ? "OK" : "异常";
				return `${name} → ${state} ${code}`;
			} catch (error) {
				return `${name} → 失败：${String(error?.message ?? error)}`;
			} finally {
				clearTimeout(timer);
			}
		};
		const origin = gitAvailable()
			? (await collect("git", ["remote", "get-url", "origin"])).out.trim()
			: "";
		const base = origin.replace(/^git@([^:]+):/u, "https://$1/").replace(/^https:\/\/[^@/]+@/u, "https://").replace(/\.git$/u, "");
		const lines = [
			await probe("github.com 主页", "https://github.com"),
			await probe("GitHub API（更新检查用）", "https://api.github.com")
		];
		if (/^https?:\/\//u.test(base)) {
			// 404 也视为“可达”：该仓库没有发布页/无 Releases 也正常。
			lines.push(await probe(`本项目 Releases（${base.replace(/^https?:\/\//u, "")}）`, `${base}/releases/latest`));
		}
		for (const line of lines) broadcast({ kind: "out", text: line });
		return { ok: true, results: lines };
	});

	ipcMain.handle("release:pull", async () => {
		const branch = await headBranch();
		broadcast({ kind: "phase", text: `拉取远端（pull --rebase origin ${branch}）…` });
		const code = await runGit(["pull", "--rebase", "origin", branch]);
		if (code === 0) {
			broadcast({ kind: "phase", text: "拉取完成（若提示可推送，请点“提交并推送”）" });
			return { ok: true };
		}
		return { ok: false, error: "pull --rebase 失败，可能需要手动解决冲突（见日志）" };
	});

	ipcMain.handle("release:push", async (_event, message) => {
		broadcast({ kind: "phase", text: "提交并推送代码…" });
		const result = await doCommitPush(message);
		if (result.ok) broadcast({ kind: "phase", text: "推送完成" });
		return result;
	});

	ipcMain.handle("release:publish", async (_event, kindOrVersion) => {
		if (typeof kindOrVersion !== "string" || kindOrVersion.trim() === "") {
			return { ok: false, error: "缺少版本类型/号" };
		}
		broadcast({ kind: "phase", text: `发布 ${kindOrVersion}…（会先检查工作区）` });
		const result = await doPublish(kindOrVersion.trim());
		if (result.ok) void shell.openExternal(await actionsUrl());
		return result;
	});

	ipcMain.handle("release:open-actions", async () => {
		await shell.openExternal(await actionsUrl());
		return { ok: true };
	});

	// 换账号 = 改 Windows 系统凭据里的 github.com 条目（应用不保存任何账号）。
	ipcMain.handle("release:open-cred", async () => {
		spawn("cmd", ["/c", "start", "", "control", "/name", "Microsoft.CredentialManager"], { windowsHide: true });
		return { ok: true };
	});

	// 构建状态：读取“当前项目自己仓库”的 release 工作流徽章（公开仓库免登录）。
	ipcMain.handle("release:status", async () => {
		if (!gitAvailable()) return { ok: false, error: "未选择项目目录（先点“选择项目…”）" };
		const { out } = await collect("git", ["remote", "get-url", "origin"]);
		let origin = (out || "").trim();
		if (origin === "") return { ok: false, error: "该项目没有设置 origin 远程，无法查构建" };
		origin = origin.replace(/^git@([^:]+):/u, "https://$1/").replace(/^https:\/\/[^@/]+@/u, "https://").replace(/\.git$/u, "");
		if (!/^https?:\/\//u.test(origin)) return { ok: false, error: "无法识别远程地址" };
		const badge = `${origin}/actions/workflows/release.yml/badge.svg`;
		const link = `${origin}/actions`;
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 8000);
			const res = await fetch(badge, { signal: controller.signal });
			clearTimeout(timer);
			if (res.status === 404) return { ok: false, error: "该项目没有名为 release 的构建工作流（纯源码项目属正常）", link };
			if (!res.ok) return { ok: false, error: `状态服务返回 ${res.status}`, link };
			const text = await res.text();
			let state = "未知";
			if (/passing/i.test(text)) state = "成功 ✅";
			else if (/failing/i.test(text)) state = "失败 ❌";
			else if (/no status/i.test(text)) state = "暂无运行";
			else if (/in_progress|running/i.test(text)) state = "运行中 ⏳";
			return { ok: true, state, link };
		} catch (error) {
			return { ok: false, error: `网络失败：${String(error?.message ?? error)}（不代表发布失败，可稍后再试）`, link };
		}
	});

	// ---------- 向导主路径：阶段1 初始化本地仓库 ----------
	ipcMain.handle("release:init", async (_event, message) => {
		const text = (typeof message === "string" ? message : "").trim() || "chore: initial commit";
		if (repoRoot === null) return { ok: false, error: "请先点“选择项目…”选一个文件夹" };
		if (gitAvailable()) return { ok: false, error: "这个目录已经是 git 仓库，无需初始化" };
		broadcast({ kind: "phase", text: "正在把该目录变成 git 仓库…" });
		if ((await runGit(["init"])) !== 0) return { ok: false, error: "git init 失败" };
		const name = (await collect("git", ["config", "user.name"])).out.trim();
		const email = (await collect("git", ["config", "user.email"])).out.trim();
		if (name === "" || email === "") {
			const who = (process.env.USERNAME || "user").replace(/\s+/gu, "");
			if (name === "") await runGit(["config", "user.name", who]);
			if (email === "") await runGit(["config", "user.email", `${who.toLowerCase()}@users.noreply.github.com`]);
		}
		await runGit(["add", "-A"]);
		if ((await runGit(["commit", "-m", text])) !== 0) {
			return { ok: false, error: "首次提交失败（可能没有任何文件被跟踪——请确认目录里确实有源码）" };
		}
		return { ok: true };
	});

	// ---------- 向导主路径：阶段2 连接刚建的空仓库并首次推送 ----------
	ipcMain.handle("release:add-remote", async (_event, url) => {
		const target = (typeof url === "string" ? url : "").trim();
		if (repoRoot === null) return { ok: false, error: "请先选项目目录" };
		if (!gitAvailable()) return { ok: false, error: "请先在向导里点“初始化并首次提交”" };
		if (!/^(https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\/)?|git@github\.com:[^/\s]+\/[^/\s]+\.git)$/u.test(target)) {
			return { ok: false, error: "地址格式不对。应该是：https://github.com/你的用户名/仓库名" };
		}
		const existing = (await collect("git", ["remote", "get-url", "origin"])).out.trim();
		if (existing === "") {
			if ((await runGit(["remote", "add", "origin", target])) !== 0) return { ok: false, error: "添加远程失败" };
		} else {
			await runGit(["remote", "set-url", "origin", target]);
		}
		await runGit(["branch", "-M", "main"]);
		broadcast({ kind: "phase", text: "正在首次推送到 GitHub…（若弹出 GitHub 登录窗口，选你的账号登录一次即可）" });
		let code = await runGit(["push", "-u", "origin", "main"]);
		if (code !== 0) {
			await runGit(["pull", "--rebase", "origin", "main"]);
			code = await runGit(["push", "-u", "origin", "main"]);
		}
		if (code !== 0) {
			return { ok: false, error: "推送失败（网络/未登录）。可稍后点“重试”，或用“凭据/账号…”检查登录" };
		}
		return { ok: true };
	});

	// ---------- 向导：把账号步骤引导到网页 ----------
	ipcMain.handle("release:open-new", async () => {
		await shell.openExternal("https://github.com/new");
		return { ok: true };
	});

	ipcMain.handle("release:open-releases", async () => {
		await shell.openExternal((await actionsUrl()).replace(/\/actions$/u, "/releases/new"));
		return { ok: true };
	});
}
