/**
 * DSH Studio — 一键发版（双击 release.bat）。
 * 提交未提交改动 → 升级版本号(patch/minor/major) → 打标签 → 推送 main 与标签
 * → GitHub Actions 自动构建并发布到 Releases（此脚本不构建，只负责“上传触发”）。
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUMP = fileURLToPath(new URL("./bump-version.mjs", import.meta.url));

function ask(question, def) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim() === "" ? def : answer.trim()); }));
}

function run(args) {
	console.log(`\n$ git ${args.join(" ")}`);
	execFileSync("git", args, { stdio: "inherit", cwd: ROOT });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Push with retries (GitHub connection can be flaky / 502). */
async function pushWithRetry(args, tries = 3) {
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			console.log(`\n$ git push ${args.join(" ")}（第 ${attempt}/${tries} 次）`);
			execFileSync("git", ["push", ...args], { stdio: "inherit", cwd: ROOT });
			return;
		} catch (error) {
			if (attempt < tries) {
				console.log(`推送失败（${String(error?.message ?? error).split("\n")[0]}），5 秒后重试…`);
				await sleep(5000);
			} else {
				throw error;
			}
		}
	}
}

export async function main() {
	console.log("DSH Studio — 一键发版（自动上传并触发 Actions 发布）");

	const kind = await ask("版本类型？[patch/minor/major，回车=patch]：", "patch");
	if (!["patch", "minor", "major"].includes(kind)) {
		console.error(`未知类型: ${kind}`);
		process.exit(1);
	}

	const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
	if (dirty !== "") {
		const message = await ask(`先提交未上传改动（${dirty.split("\n").length} 个文件；回车默认 "chore: update"）：`, "chore: update");
		run(["add", "-A"]);
		run(["commit", "-m", message]);
	}

	const newVersion = execFileSync("node", [BUMP, kind], { cwd: ROOT, encoding: "utf8" }).trim();
	console.log(`新版本: ${newVersion}`);

	run(["add", "package.json", "package-lock.json"]);
	run(["commit", "-m", `chore: release v${newVersion}`]);

	const exists = execFileSync("git", ["tag", "--list", `v${newVersion}`], { cwd: ROOT, encoding: "utf8" }).trim();
	if (exists === "") run(["tag", `v${newVersion}`]);
	else console.log(`标签 v${newVersion} 已存在，跳过创建`);

	await pushWithRetry(["origin", "main"]);
	await pushWithRetry(["origin", `v${newVersion}`]);

	console.log(`\n完成 ✅ 已上传 v${newVersion}，Actions 正在自动构建发布…`);
	console.log("查看进度: https://github.com/well74741/dsh-desktop/actions");
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("do-release.mjs")) {
	main().catch((error) => { console.error(`失败: ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
