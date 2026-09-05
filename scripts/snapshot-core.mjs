/**
 * Snapshot the pinned kernel versions this desktop build was packaged against.
 * Run `npm run snapshot:core` after any @deepseek-ai/dsh (or core) upgrade —
 * the snapshot documents the kernel baseline and is the data source for
 * future "kernel follow" rebuild checks (see DESKTOP-PLAN P1 内核跟随).
 */
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function readPkg(relative) {
	return JSON.parse(readFileSync(`${ROOT}${relative}`, "utf8"));
}

function versionAt(scopeDir, name) {
	try {
		const manifest = readPkg(`node_modules/${scopeDir}${name}/package.json`);
		return manifest.version ?? null;
	} catch {
		return null;
	}
}

// [node_modules 子目录, 包名, 展示名(完整)] —— 展示名保留 scope。
const PICKS = [
	["@deepseek-ai/", "dsh", "@deepseek-ai/dsh"],
	["@deepseek-ai/", "dsh-app-boot", "@deepseek-ai/dsh-app-boot"],
	["@deepseek-ai/", "dsh-base", "@deepseek-ai/dsh-base"],
	["@deepseek-ai/", "dsh-web-app", "@deepseek-ai/dsh-web-app"],
	["@deepseek-ai/", "cordis", "@deepseek-ai/cordis"],
	["", "pnpm", "pnpm"],
	["", "electron-updater", "electron-updater"]
];

const appPkg = readPkg("package.json");
const snapshot = {
	generatedAt: new Date().toISOString(),
	desktopApp: { name: appPkg.name, version: appPkg.version },
	packages: Object.fromEntries(PICKS.map(([dir, name, full]) => [full, versionAt(dir, name)]))
};

const outPath = `${ROOT}core/versions.json`;
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`wrote ${outPath}`);
console.log(JSON.stringify(snapshot.packages, null, 2));
