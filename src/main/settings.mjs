/**
 * DSH Studio — tiny userData settings store (JSON at <userData>/settings.json).
 * Shell-level preferences only; nothing kernel-related lives here.
 */
import { app } from "electron";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = () => join(app.getPath("userData"), "settings.json");
const DEFAULTS = {
	autoStartHidden: false
};

let cached = null;

export function loadSettings() {
	if (cached !== null) return cached;
	try {
		const raw = existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), "utf8")) : {};
		cached = { ...DEFAULTS, ...raw };
	} catch {
		cached = { ...DEFAULTS };
	}
	return cached;
}

export function saveSettings(patch) {
	const next = { ...loadSettings(), ...patch };
	try {
		mkdirSync(dirname(FILE()), { recursive: true });
		writeFileSync(FILE(), JSON.stringify(next, null, 2), "utf8");
		cached = next;
	} catch (error) {
		console.error(`[dsh-studio] settings save failed: ${String(error?.message ?? error)}`);
	}
	return next;
}
