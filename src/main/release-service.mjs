/**
 * DSH Studio — release center (main-process side). Dev tool: runs git inside
 * the local repository this app was started from. Only meaningful when the
 * app runs from a git checkout (npm start / dev); installed builds have no
 * .git and the panel shows a hint.
 */
import { ipcMain, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let repoRoot = null;
let panelWindows = () => [];

export function configureReleaseService({ getWindows, gitRepoRoot, execPath }) {
	if (getWindows) panelWindows = getWindows;
	if (gitRepoRoot) repoRoot = gitRepoRoot;
	if (execPath) execNode = execPath;
}

let execNode = process.execPath;

function broadcast(payload) {
	for (const win of panelWindows()) {
		if (!win.isDestroyed()) win.webContents.send("release:event", payload);
	}
}

function gitAvailable() {
	return repoRoot !== null && existsSync(join(repoRoot, ".git"));
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
	if (!gitAvailable()) {
		return { ok: true, available: false, reason: "未检测到 .git（这是安装版或非开发目录）；发布请用 GitHub 网页 Run workflow。" };
	}
	const branch = (await collect("git", ["branch", "--show-current"])).out || "?";
	const remote = (await collect("git", ["remote", "get-url", "origin"])).out || "(未设置 origin)";
	const tag = (await collect("git", ["describe", "--tags", "--abbrev=0"])).out || "(无标签)";
	const dirty = (await collect("git", ["status", "--porcelain"])).out;
	return {
		ok: true,
		available: true,
		root: repoRoot,
		branch,
		remote,
		lastTag: tag,
		version: readPkgVersion(),
		dirty: dirty === "" ? 0 : dirty.split("\n").length,
		statusText: dirty === "" ? "工作区干净" : "有未提交改动（请先提交）"
	};
}

async function doCommitPush(message) {
	if (!gitAvailable()) return { ok: false, error: "非开发目录，无法提交" };
	if (!message || message.trim() === "") return { ok: false, error: "请填写提交说明" };
	if ((await runGit(["add", "-A"])) !== 0) return { ok: false, error: "git add 失败" };
	if ((await runGit(["commit", "-m", message.trim()])) !== 0) return { ok: false, error: "git commit 失败（可能没有改动）" };
	const code = await runGit(["push"]);
	if (code !== 0) return { ok: false, error: "git push 失败（可能是网络/登录问题，请重试）" };
	return { ok: true };
}

async function doPublish(kindOrVersion) {
	if (!gitAvailable()) return { ok: false, error: "非开发目录，无法发布" };
	const dirty = (await collect("git", ["status", "--porcelain"])).out;
	if (dirty !== "") return { ok: false, error: `工作区有未提交改动（${dirty.split("\n").length} 项），请先「提交并推送代码」` };

	broadcast({ kind: "phase", text: "升级版本号…" });
	const bumpArgs = [join(repoRoot, "scripts", "bump-version.mjs"), kindOrVersion];
	// The main process is the Electron executable — run the bump script as plain Node.
	const bumped = await collect(execNode, bumpArgs, { ...process.env, ELECTRON_RUN_AS_NODE: "1" });
	const newVersion = bumped.out;
	if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
		return { ok: false, error: `版本升级失败: ${bumped.err || bumped.out}` };
	}
	broadcast({ kind: "line", text: `新版本: ${newVersion}` });

	if ((await runGit(["add", "package.json"])) !== 0) return { ok: false, error: "git add 失败" };
	if ((await runGit(["commit", "-m", `chore: release v${newVersion}`])) !== 0) return { ok: false, error: "commit 失败" };
	const tags = (await collect("git", ["tag", "--list", `v${newVersion}`])).out;
	if (tags === "") {
		if ((await runGit(["tag", `v${newVersion}`])) !== 0) return { ok: false, error: "打标签失败" };
	}
	if ((await runGit(["push"])) !== 0) return { ok: false, error: "push main 失败" };
	if ((await runGit(["push", "origin", `v${newVersion}`])) !== 0) return { ok: false, error: "push 标签失败（构建不会触发，请重试）" };
	broadcast({ kind: "phase", text: `已推送 v${newVersion}，Actions 将自动构建发布` });
	return { ok: true, version: newVersion };
}

export function registerReleaseIpc() {
	ipcMain.handle("release:info", async () => info());

	ipcMain.handle("release:push", async (_event, message) => {
		broadcast({ kind: "phase", text: "提交并推送代码…" });
		const result = await doCommitPush(message);
		if (result.ok) broadcast({ kind: "phase", text: "推送完成" });
		return result;
	});

	ipcMain.handle("release:publish", async (_event, kind) => {
		if (!["patch", "minor", "major"].includes(kind)) return { ok: false, error: `未知版本类型: ${kind}` };
		broadcast({ kind: "phase", text: `发布 ${kind}…（会先检查工作区）` });
		const result = await doPublish(kind);
		if (result.ok && !result.version) void shell.openExternal("https://github.com/well74741/dsh-desktop/actions");
		return result;
	});

	ipcMain.handle("release:open-actions", async () => {
		await shell.openExternal("https://github.com/well74741/dsh-desktop/actions");
		return { ok: true };
	});
}
