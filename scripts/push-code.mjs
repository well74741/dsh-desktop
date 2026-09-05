/**
 * DSH Studio — 日常一键“提交并上传”（双击 push.bat）。
 * 询问提交说明 → 有改动则 git add -A + commit → git push origin main。
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SELF = fileURLToPath(import.meta.url).replace(/\\/g, "/");

function ask(question, def) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim() === "" ? def : answer.trim()); }));
}

function run(args) {
	console.log(`\n$ git ${args.join(" ")}`);
	execFileSync("git", args, { stdio: "inherit", cwd: ROOT });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Push with retries; auto pull --rebase once when rejected (remote ahead). */
async function pushWithRetry(args, { tries = 3, rebase = false } = {}) {
	const isRejected = (error) => /rejected|fetch first|non-fast-forward/i.test(String(error?.message ?? error));
	for (let attempt = 1; attempt <= tries; attempt++) {
		try {
			console.log(`\n$ git push ${args.join(" ")}（第 ${attempt}/${tries} 次）`);
			execFileSync("git", ["push", ...args], { stdio: "inherit", cwd: ROOT });
			return;
		} catch (error) {
			if (rebase && attempt === 1 && isRejected(error)) {
				console.log("远端有更新，先 pull --rebase 再推送…");
				try {
					execFileSync("git", ["pull", "--rebase", "origin", "main"], { stdio: "inherit", cwd: ROOT });
					continue;
				} catch (pullError) {
					console.error(`pull --rebase 失败，请手动解决冲突：${String(pullError?.message ?? pullError).split("\n")[0]}`);
					throw pullError;
				}
			}
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
	console.log("DSH Studio — 提交并上传");
	const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
	if (dirty === "") {
		console.log("工作区干净，没有可提交的改动；直接尝试推送…");
	} else {
		const message = await ask(`提交说明（${dirty.split("\n").length} 个文件改动；回车默认 "chore: update"）：`, "chore: update");
		run(["add", "-A"]);
		run(["commit", "-m", message]);
	}
	await pushWithRetry(["origin", "main"], { rebase: true });
	console.log("\n上传完成 ✅");
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith(SELF.split("/").pop())) {
	main().catch((error) => { console.error(`失败: ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
