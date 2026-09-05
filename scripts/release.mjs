/**
 * DSH Studio — one-command release helper.
 *
 * Usage:
 *   node scripts/release.mjs [nextVersion]     (nextVersion like 0.2.0)
 *   or double-click release.bat (prompts for the version)
 *
 * Does: bump package.json → commit → tag v<ver> → push main → push tag.
 * Requires: clean working tree (commit code changes first), git remote set,
 * and GitHub credentials available (a browser login window may open).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG = `${ROOT}package.json`;

function run(cmd, args) {
	console.log(`\n$ ${cmd} ${args.join(" ")}`);
	execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT });
}

function git(args) {
	execFileSync("git", args, { stdio: "inherit", cwd: ROOT });
}

function ask(question) {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function bumpPatch(version) {
	const [major, minor, patch] = version.split(".").map(Number);
	return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

async function main() {
	const pkg = JSON.parse(readFileSync(PKG, "utf8"));
	const current = pkg.version;
	const requested = process.argv[2]?.trim() ?? (await ask(`新版本号（当前 ${current}；留空 = ${bumpPatch(current)}）：`));
	const next = requested === "" ? bumpPatch(current) : requested;
	if (!/^\d+\.\d+\.\d+$/.test(next)) {
		console.error(`版本号格式应为 x.y.z，收到: ${next}`);
		process.exit(1);
	}
	console.log(`发布版本: ${next}`);

	// Safety: the tree must be committed before releasing.
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
	if (status !== "") {
		console.error("工作区有未提交改动，请先在 GitHub Desktop（或 git）提交再发布：");
		console.error(status);
		process.exit(1);
	}

	pkg.version = next;
	writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
	console.log(`package.json -> ${next}`);

	git(["add", "package.json"]);
	git(["commit", "-m", `chore: release v${next}`]);

	const hasTag = execFileSync("git", ["tag", "--list", `v${next}`], { cwd: ROOT, encoding: "utf8" }).trim() !== "";
	if (!hasTag) {
		git(["tag", `v${next}`]);
	} else {
		console.log(`标签 v${next} 已存在，跳过创建`);
	}

	run("git", ["push", "origin", "main"]);
	run("git", ["push", "origin", `v${next}`]);

	console.log(`\n完成 ✅  Actions: https://github.com/well74741/dsh-desktop/actions`);
}

main().catch((error) => {
	console.error(`发布失败: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
