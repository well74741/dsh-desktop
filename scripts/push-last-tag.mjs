/**
 * DSH Studio — 重试发布：推送 main 与“最新已打标签”（不重复升版本）。
 * 用于：一键发版时推送失败（502），本地已升版本/已打标签但 Actions 未触发。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gitOut(args) {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

async function pushWithRetry(args, { tries = 3, rebase = false } = {}) {
	const isRejected = (e) => /rejected|fetch first|non-fast-forward/i.test(String(e?.message ?? e));
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			console.log(`\n$ git push ${args.join(" ")}（第 ${attempt}/${tries} 次）`);
			execFileSync("git", ["push", ...args], { stdio: "inherit", cwd: ROOT });
			return 0;
		} catch (error) {
			if (rebase && attempt === 1 && isRejected(error)) {
				console.log("远端有更新，先 pull --rebase 再推送…");
				execFileSync("git", ["pull", "--rebase", "origin", "main"], { stdio: "inherit", cwd: ROOT });
				continue;
			}
			if (attempt < tries) {
				console.log("推送失败，5 秒后重试…");
				await sleep(5000);
			} else {
				throw error;
			}
		}
	}
}

export async function main() {
	console.log("DSH Studio — 重试发布（推送最新标签，不重复升版本）");
	const lastTag = gitOut(["describe", "--tags", "--abbrev=0"]);
	console.log(`最新标签: ${lastTag}`);
	await pushWithRetry(["origin", "main"], { rebase: true });
	await pushWithRetry(["origin", lastTag]);
	console.log(`\n完成 ✅ 已推送 ${lastTag}，Actions 正在自动构建发布…`);
	console.log("查看进度: https://github.com/well74741/dsh-desktop/actions");
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("push-last-tag.mjs")) {
	main().catch((error) => { console.error(`失败: ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
