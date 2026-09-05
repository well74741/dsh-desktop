/**
 * DSH Studio — plugin compatibility analysis (P2).
 *
 * The dsh plugin ecosystem has no standardized compatibility manifest yet, so
 * the practical gate is peer-dependency ranges on the packages the kernel
 * actually ships (@deepseek-ai/cordis and the @deepseek-ai/dsh-* tree bundled
 * with this app). Analysis is advisory: nothing here replaces or restricts
 * the app's network/registry capabilities — install still goes through pnpm
 * and can always be forced.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import satisfies from "semver/functions/satisfies.js";

const require = createRequire(import.meta.url);

/** Read a bundled package's package.json wherever it resolves from. */
function bundledPackagePath(spec) {
	const candidates = [];
	try {
		candidates.push(import.meta.resolve(`${spec}/package.json`));
	} catch {
		/* not exported */
	}
	let mainUrl;
	try {
		mainUrl = import.meta.resolve(spec);
	} catch {
		/* spec not installed */
	}
	if (mainUrl !== undefined) candidates.push(mainUrl);
	for (const url of candidates) {
		try {
			const path = fileURLToPath(url);
			const dir = dirname(path);
			const base = path.endsWith("package.json") ? path : join(dir, "package.json");
			const manifest = JSON.parse(readFileSync(base, "utf8"));
			if (manifest.version !== undefined && manifest.name === spec) return base;
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

function bundledPackageJson(spec) {
	const path = bundledPackagePath(spec);
	if (path === null) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Versions of the @deepseek-ai packages this app ships (the resolution
 * anchor). Scans the whole scope under our node_modules so peers on any
 * @deepseek-ai/* family member are judged against what the app actually
 * bundles.
 */
export function bundledVersions() {
	const out = {};
	const anchor = bundledPackagePath("@deepseek-ai/cordis");
	if (anchor === null) return out;
	const scopeDir = dirname(dirname(anchor)); // node_modules/@deepseek-ai
	const entries = readdirSync(scopeDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const manifest = JSON.parse(readFileSync(join(scopeDir, entry.name, "package.json"), "utf8"));
			if (manifest.name && manifest.version) out[manifest.name] = manifest.version;
		} catch {
			/* skip */
		}
	}
	return out;
}

/** Whether an installed version satisfies a peer range (robust to junk ranges). */
export function rangeSatisfies(installed, range) {
	if (range === undefined || range === null || range === "*" || range === "") return true;
	if (installed === undefined) return false;
	try {
		return satisfies(installed, range);
	} catch {
		// Unparseable range: give the benefit of the doubt.
		return true;
	}
}

/**
 * Analyze one package (latest manifest from the registry) against the bundled
 * kernel. Returns issues as { package, range, installed, kind, note }.
 */
export function analyzeManifest(meta, bundled = bundledVersions()) {
	const issues = [];
	const peers = meta.peerDependencies ?? {};
	const interesting = Object.entries(peers).filter(
		([name]) => name === "@deepseek-ai/cordis" || name.startsWith("@deepseek-ai/")
	);
	for (const [name, range] of interesting) {
		if (name in bundled) {
			const installed = bundled[name];
			if (!rangeSatisfies(installed, range)) {
				issues.push({
					package: name,
					range,
					installed,
					kind: name === "@deepseek-ai/cordis" ? "danger" : "warn",
					note: name === "@deepseek-ai/cordis"
						? "Cordis API 主版本不匹配可能导致插件无法加载"
						: "与随内核分发的版本范围不匹配，功能可能不完整"
				});
			}
		} else {
			issues.push({
				package: name,
				range,
				installed: null,
				kind: "warn",
				note: "内核未随附该 @deepseek-ai 包（该包声明为 peer；若内核加载时缺失会报错）"
			});
		}
	}
	return {
		name: meta.name,
		version: meta.version,
		bundle: meta.dshBundle,
		issues,
		ok: issues.every((issue) => issue.kind !== "danger")
	};
}
