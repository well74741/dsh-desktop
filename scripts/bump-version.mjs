/**
 * Set the version in package.json (+ package-lock.json) and print it.
 * Usage: node scripts/bump-version.mjs patch|minor|major   (auto bump)
 *        node scripts/bump-version.mjs 1.2.3              (explicit version)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG = `${ROOT}package.json`;
const LOCK = `${ROOT}package-lock.json`;

const input = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(input) && !/^\d+\.\d+\.\d+$/.test(input)) {
	console.error(`用法: node scripts/bump-version.mjs patch|minor|major|0.x.y（收到: ${input}）`);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);

let next;
if (input === "major") next = `${major + 1}.0.0`;
else if (input === "minor") next = `${major}.${minor + 1}.0`;
else if (input === "patch") next = `${major}.${minor}.${(patch ?? 0) + 1}`;
else next = input;

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
