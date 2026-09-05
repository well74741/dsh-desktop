/**
 * DSH Studio — file logging for packaged builds.
 *
 * Packaged GUI apps have no visible console, so all console output (main,
 * updater, and forwarded core lines) is mirrored into
 * <userData>/logs/dsh-studio.log. Dev runs keep plain console behavior
 * (plus the same file when available).
 */
import { app } from "electron";
import { createWriteStream, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let fileStream = null;
let logPath = null;
let wrapped = false;

function serialize(value) {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export function logFilePath() {
	return logPath;
}

/** Mirror console.log/error/warn into a file (packaged or not, best effort). */
export function initFileLog() {
	if (wrapped) return;
	wrapped = true;
	try {
		const dir = join(app.getPath("userData"), "logs");
		mkdirSync(dir, { recursive: true });
		logPath = join(dir, "dsh-studio.log");
		fileStream = createWriteStream(logPath, { flags: "a" });
	} catch (error) {
		console.error(`[dsh-studio] file log unavailable: ${String(error?.message ?? error)}`);
		return;
	}

	const original = {
		log: console.log.bind(console),
		error: console.error.bind(console),
		warn: console.warn.bind(console)
	};
	const write = (kind, args) => {
		fileStream?.write(`[${new Date().toISOString()}][${kind}] ${args.map(serialize).join(" ")}\n`);
	};
	console.log = (...args) => {
		write("log", args);
		original.log(...args);
	};
	console.warn = (...args) => {
		write("warn", args);
		original.warn(...args);
	};
	console.error = (...args) => {
		write("error", args);
		original.error(...args);
	};
}

/** Last `count` lines of the log file (for error dialogs), best effort. */
export function readLogTail(count = 25) {
	try {
		if (!logPath || !existsSync(logPath)) return [];
		const lines = readFileSync(logPath, "utf8").split(/\r?\n/u);
		return lines.slice(-count);
	} catch {
		return [];
	}
}
