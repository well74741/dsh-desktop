/**
 * Sync kernel-follow release (run inside the dsh-desktop repo).
 *
 * Usage: node scripts/sync-kernel-release.mjs [target-version]
 *
 * Steps:
 *   1) resolve the latest official @deepseek-ai/dsh version (npm registry,
 *      mirrored) unless an explicit target is given;
 *   2) if the repo already pins that version → "already latest", exit 0;
 *   3) otherwise set every @deepseek-ai/dsh* dependency to that exact
 *      version (skipping any package that does not exist at it), npm install,
 *      commit, bump the app patch version, tag vX.Y.Z and push main + tag
 *      (GitHub Actions builds & publishes the installer; the app then
 *      auto-updates).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG_PATH = `${ROOT}package.json`;
const REGISTRIES = [
	"https://registry.npmjs.org",
	"https://registry.npmmirror.com"
];

function run(args, opts = {}) {
	console.log(`\n$ ${args.join(" ")}`);
	execFileSync(args[0], args.slice(1), { stdio: "inherit", cwd: ROOT, ...opts });
}

const MARKER = `${ROOT}.kernel-sync-version`;

function clearMarker() {
	try { writeFileSync(MARKER, ""); } catch { /* ignore */ }
}

async function latestDshVersion() {
	for (const base of REGISTRIES) {
		try {
			const res = await fetch(`${base}/@deepseek-ai/dsh/latest`, { headers: { "user-agent": "dsh-studio-sync" } });
			if (!res.ok) continue;
			const body = await res.json();
			if (typeof body?.version === "string" && body.version !== "") return body.version;
		} catch {
			/* try next mirror */
		}
	}
	throw new Error("cannot reach npm registry to resolve the official kernel version");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

async function main() {
	const requested = process.argv[2]?.trim() ?? "";
	const target = requested !== "" ? requested : await latestDshVersion();
	const pkg = readJson(PKG_PATH);
	const pinned = pkg.dependencies?.["@deepseek-ai/dsh"] ?? "";
	console.log(`target official kernel: ${target}  (repo pins: ${pinned})`);

	if (pinned === target) {
		console.log("already latest — nothing to do");
		clearMarker();
		return;
	}

	const picks = Object.keys(pkg.dependencies ?? {}).filter((k) => k === "@deepseek-ai/dsh" || /^@deepseek-ai\/dsh-/.test(k));

	// Which picks actually exist at the target version?
	const changed = [];
	for (const name of picks) {
		let exists = false;
		for (const base of REGISTRIES) {
			try {
				const res = await fetch(`${base}/${name.replace("/", "%2f")}/${target}`, { headers: { "user-agent": "dsh-studio-sync" } });
				exists = res.ok;
				if (exists) break;
			} catch { /* next mirror */ }
		}
		if (exists) {
			pkg.dependencies[name] = target;
			changed.push(name);
		} else {
			console.warn(`skip ${name}: no ${target} published`);
		}
	}
	if (changed.length === 0) {
		console.error("no official kernel package matched the target version — aborting (releases are version-aligned normally)");
		process.exit(1);
	}
	writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf8");
	console.log(`re-pinned ${changed.length} kernel packages to ${target}`);

	run(["npm", "install"]);

	const git = (args) => {
		try {
			return execFileSync("git", args, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
		} catch {
			return null;
		}
	};
	const dirty = git(["status", "--porcelain"]);
	if (dirty === null) throw new Error("git not available in repo");

	run(["git", "add", "package.json", "package-lock.json"]);
	run(["git", "commit", "-m", `chore: sync official kernel @deepseek-ai/dsh@${target}`]);

	// Bump the app patch version and create the release tag.
	const out = execFileSync("node", ["scripts/bump-version.mjs", "patch"], { encoding: "utf8", cwd: ROOT }).trim();
	console.log(`app version now ${out}`);
	run(["git", "add", "package.json", "package-lock.json"]);
	run(["git", "commit", "-m", `chore: release v${out}`]);
	run(["git", "tag", `v${out}`]);

	const push = (args) => {
		for (let attempt = 1; attempt <= 4; attempt++) {
			try {
				run(["git", "push", "origin", ...args]);
				return;
			} catch (error) {
				if (attempt < 4) {
					console.log(`push failed (${String(error?.message ?? error).split("\n")[0]}), rebase + retry`);
					try { run(["git", "pull", "--rebase", "origin", "main"]); } catch { /* keep going */ }
				} else throw error;
			}
		}
	};
	push(["main"]);
	push([`v${out}`]);
	writeFileSync(MARKER, `${out}\n`, "utf8");
	console.log(`\nDONE: v${out} pushed — GitHub Actions is building & publishing the installer.`);
}

main().catch((error) => {
	console.error(String(error?.message ?? error));
	process.exit(1);
});
