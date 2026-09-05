/**
 * Bump the version in package.json (+ package-lock.json) and print the new
 * version. Usage: node scripts/bump-version.mjs patch|minor|major
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG = `${ROOT}package.json`;
const LOCK = `${ROOT}package-lock.json`;

const kind = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(kind)) {
	console.error(`用法: node scripts/bump-version.mjs patch|minor|major（收到: ${kind}）`);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);

let next;
if (kind === "major") next = `${major + 1}.0.0`;
else if (kind === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${(patch ?? 0) + 1}`;

pkg.version = next;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// Keep the lockfile's root version in sync so `npm ci` stays green.
try {
	const lock = JSON.parse(readFileSync(LOCK, "utf8"));
	if (lock.version !== undefined) {
		lock.version = next;
		if (lock.packages?.[""]?.version !== undefined) lock.packages[""].version = next;
		writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n", "utf8");
	}
} catch {
	/* no lockfile — fine */
}

console.log(next);
