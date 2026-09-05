/**
 * DSH Studio — plugin control (P2).
 *
 * Manages plugins of a dsh profile using the OFFICIAL semantics:
 *   - profile auto-initialized from the shipped template on first use,
 *   - pnpm performs the actual dependency change inside the profile dir
 *     (registry/file/git specs, peer resolution — exactly like `dsh plugin`),
 *   - afterwards the `dsh.profile.bundles` layer list is reconciled against
 *     the installed state (a dependency whose package declares `dsh.bundle`
 *     joins the layer stack; a removed one leaves it).
 *
 * Because everything lives under $DSH_HOME/profiles/<profile>, any change is
 * visible to `dsh web` (and every other profile consumer) on its next boot —
 * desktop and web stay in sync on disk by construction.
 *
 * This module is pure Node (no Electron imports) so the same code runs inside
 * the app shell (spawning pnpm through this executable as plain Node) and in
 * CLI/dev tests (plain Node). pnpm path: bundled `pnpm` dependency.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
	DEFAULT_PROFILE_BUNDLES,
	PROFILE_TEMPLATES,
	initProfile,
	readProfileManifest,
	writeProfileManifest,
	resolveBundleDir,
	resolveProfileDir
} from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

const require = createRequire(import.meta.url);
const NAME = "dsh";

export const PROFILE_NAME = "web";

function log(message) {
	console.log(`[dsh-studio:pluginctl] ${message}`);
}

/**
 * Absolute path of the bundled pnpm CLI. pnpm's package "exports" resolves the
 * bare specifier to its own package.json (running that file is a silent
 * no-op), so parse the manifest and take the declared `bin.pnpm` path instead.
 */
export function pnpmCliPath() {
	const packageJsonPath = fileURLToPath(import.meta.resolve("pnpm"));
	const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
	const bin = manifest.bin?.pnpm;
	if (typeof bin === "string") return join(dirname(packageJsonPath), bin);
	throw new Error("pnpm package declares no bin.pnpm entry");
}

/**
 * Resolve the effective DSH_HOME (honors $DSH_HOME, else the official default)
 * and the profile directory. `resolveProfileDir` reads $DSH_HOME itself, so we
 * pin process.env.DSH_HOME before calling for deterministic results.
 */
export function profileDirOf(dshHome, profile = PROFILE_NAME) {
	// Always normalize: pin $DSH_HOME so resolveProfileDir is deterministic.
	process.env.DSH_HOME = dshHome ?? resolveDshHome();
	return resolveProfileDir(profile);
}

export function effectiveDshHome() {
	return resolveDshHome();
}

function readManifest(dir) {
	return readProfileManifest(NAME, dir);
}

/** Initialize a profile directory from the shipped template when missing. */
export function ensureProfile(dshHome, profile = PROFILE_NAME) {
	const dir = profileDirOf(dshHome, profile);
	if (!existsSync(join(dir, "package.json"))) {
		const template = PROFILE_TEMPLATES[profile];
		initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES, template?.patchReload);
		log(`initialized profile ${profile} at ${dir}`);
	}
	return dir;
}

/** Whether a resolved dependency exports a profile patch (i.e. is a bundle). */
function exportsPatch(packageName, profileDir) {
	let dir;
	try {
		dir = resolveBundleDir(NAME, packageName, dshAnchor(), profileDir);
	} catch {
		return false;
	}
	return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== undefined;
}

function dshAnchor() {
	return dirname(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh/package.json")));
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state (same algorithm
 * as the official `dsh plugin` forwarder; see @deepseek-ai/dsh/lib/plugin-*).
 */
function reconcilePlugins(before, profileDir) {
	const after = readManifest(profileDir);
	const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
	const dependencies = Object.keys(after.dependencies ?? {});
	const plugins = after.dsh?.profile?.bundles ?? [];
	let changed = false;
	for (const packageName of dependencies) {
		const isBundle = exportsPatch(packageName, profileDir);
		if (isBundle && !plugins.includes(packageName)) {
			plugins.push(packageName);
			changed = true;
		} else if (!isBundle && !beforeDeps.has(packageName)) {
			log(`warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer`);
		}
	}
	const dependencySet = new Set(dependencies);
	for (const packageName of [...plugins]) {
		const wasDependency = beforeDeps.has(packageName) || dependencySet.has(packageName);
		const stillBundle = dependencySet.has(packageName) && exportsPatch(packageName, profileDir);
		if (wasDependency && !stillBundle) {
			plugins.splice(plugins.indexOf(packageName), 1);
			changed = true;
		}
	}
	if (!changed) return after;
	after.dsh = {
		...after.dsh,
		profile: {
			...after.dsh?.profile,
			bundles: plugins
		}
	};
	writeProfileManifest(profileDir, after);
	return after;
}

/** Run pnpm in the profile directory; streams output via onOutput when given. */
async function runPnpm(args, { cwd, execPath, env, onOutput } = {}) {
	const node = execPath ?? process.execPath;
	const childEnv = {
		...process.env,
		...env,
		// Under Electron this is the executable itself acting as plain Node.
		...(execPath !== undefined ? { ELECTRON_RUN_AS_NODE: "1" } : {})
	};
	const child = spawn(node, [pnpmCliPath(), ...args], {
		cwd,
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true
	});
	const capture = (stream, prefix) => {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			for (const line of chunk.split(/\r?\n/u)) {
				if (line.trim() === "") continue;
				onOutput?.(`${prefix}${line}`);
			}
		});
	};
	capture(child.stdout, "");
	capture(child.stderr, "");
	const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
	if (code !== 0) throw new Error(`pnpm exited with code ${code}`);
	return code;
}

/** Human-readable plugin inventory for one profile. */
export function listPlugins(dshHome, profile = PROFILE_NAME) {
	const dir = ensureProfile(dshHome, profile);
	const manifest = readManifest(dir);
	const dependencies = Object.entries(manifest.dependencies ?? {});
	const inventory = [];
	for (const [name, version] of dependencies) {
		inventory.push({
			name,
			version,
			bundle: exportsPatch(name, dir)
		});
	}
	return {
		profile,
		profileDir: dir,
		home: dshHome ?? effectiveDshHome(),
		dependencies: manifest.dependencies ?? {},
		bundles: manifest.dsh?.profile?.bundles ?? [],
		inventory
	};
}

/** Install one package spec (registry name, file:, git, ...) into the profile. */
export async function installPlugin(spec, { dshHome, profile = PROFILE_NAME, execPath, onOutput } = {}) {
	const dir = ensureProfile(dshHome, profile);
	const before = readManifest(dir);
	onOutput?.(`pnpm add ${spec}`);
	await runPnpm(["add", spec], {
		cwd: dir,
		execPath,
		onOutput
	});
	const after = reconcilePlugins(before, dir);
	log(`installed ${spec}`);
	return listPlugins(dshHome, profile);
}

/** Remove one package from the profile. */
export async function uninstallPlugin(name, { dshHome, profile = PROFILE_NAME, execPath, onOutput } = {}) {
	const dir = ensureProfile(dshHome, profile);
	const before = readManifest(dir);
	if ((before.dependencies ?? {})[name] === undefined) {
		throw new Error(`${name} is not a dependency of profile ${profile}`);
	}
	onOutput?.(`pnpm remove ${name}`);
	await runPnpm(["remove", name], {
		cwd: dir,
		execPath,
		onOutput
	});
	const after = reconcilePlugins(before, dir);
	log(`removed ${name}`);
	return listPlugins(dshHome, profile);
}
