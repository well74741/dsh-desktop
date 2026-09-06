/**
 * Kernel-follow helpers (shell-only, used by main.mjs).
 *
 * The desktop app bundles the official DeepSeek Harness kernel
 * (@deepseek-ai/dsh + friends). These helpers let the shell answer:
 *   - what kernel version is bundled right now,
 *   - what the latest official kernel version is (npm registry, mirrored),
 *   - whether the latest is newer than the bundled one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const KERNEL_REGISTRIES = [
	"https://registry.npmjs.org",
	"https://registry.npmmirror.com"
];

/** Fetch the latest official @deepseek-ai/dsh version; null when unreachable. */
export async function fetchLatestKernelVersion() {
	for (const base of KERNEL_REGISTRIES) {
		try {
			const res = await fetch(`${base}/@deepseek-ai/dsh/latest`, {
				headers: { "user-agent": "dsh-studio" },
				timeout: 15000
			});
			if (!res.ok) continue;
			const body = await res.json();
			if (typeof body?.version === "string" && body.version !== "") return body.version;
		} catch {
			/* try next mirror */
		}
	}
	return null;
}

/**
 * Read the bundled kernel version from the first candidate path that holds an
 * @deepseek-ai/dsh package.json. Candidates are absolute directories.
 */
export function readBundledKernelVersion(candidateRoots) {
	for (const root of candidateRoots) {
		if (root === undefined || root === null) continue;
		try {
			const manifest = JSON.parse(readFileSync(join(root, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
			if (typeof manifest?.version === "string" && manifest.version !== "") return manifest.version;
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

/** npm-style "a is greater than b" including prerelease tags (rc.1 < rc.2). */
export function semverGt(a, b) {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (pa === null || pb === null) return false;
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] > pb[i];
	}
	const ra = pa[3];
	const rb = pb[3];
	if (ra.length === 0 && rb.length === 0) return false;
	if (ra.length === 0) return true; // release > prerelease
	if (rb.length === 0) return false;
	return comparePre(ra, rb) > 0;
}

function parseVersion(v) {
	if (typeof v !== "string") return null;
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
	if (m === null) return null;
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? [] : m[4].split(".")];
}

function comparePre(a, b) {
	const len = Math.max(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const x = a[i];
		const y = b[i];
		if (x === undefined) return -1;
		if (y === undefined) return 1;
		const xn = /^\d+$/.test(x) ? Number(x) : NaN;
		const yn = /^\d+$/.test(y) ? Number(y) : NaN;
		let cmp;
		if (!Number.isNaN(xn) && !Number.isNaN(yn)) cmp = xn - yn;
		else cmp = x.localeCompare(y);
		if (cmp !== 0) return cmp > 0 ? 1 : -1;
	}
	return 0;
}
