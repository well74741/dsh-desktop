import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PKG = `${ROOT}package.json`;
const LOCK = `${ROOT}package-lock.json`;
const kind = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(kind)) { console.error("用法: node scripts/bump-version.mjs patch|minor|major"); process.exit(1); }
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
let next;
if (kind === "major") next = `${major + 1}.0.0`;
else if (kind === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${(patch ?? 0) + 1}`;
pkg.version = next;
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");
try {
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  if (lock.version !== undefined) { lock.version = next; if (lock.packages?.[""]?.version !== undefined) lock.packages[""].version = next; writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n", "utf8"); }
} catch {}
console.log(next);
