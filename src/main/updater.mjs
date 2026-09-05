/**
 * DSH Studio — auto-update wiring (P1).
 *
 * Uses electron-updater against the GitHub Releases feed baked into
 * app-update.yml at build time (see electron-builder.yml publish section).
 *
 * Policy:
 *   - only active in packaged builds (dev runs never check),
 *   - checks ~10 s after startup (non-blocking),
 *   - downloads automatically once an update is found,
 *   - asks the user before restarting to install,
 *   - quitToInstall() flags updaterState.installing so the shell's close/quit
 *     guards let the updater-driven quit proceed (no graceful core stop —
 *     the process is being replaced).
 */
import { app, dialog, Notification } from "electron";
import { createRequire } from "node:module";

// electron-updater is CJS and publishes autoUpdater via Object.defineProperty,
// which Electron's ESM<->CJS interop cannot see as a named export. Load it
// with createRequire to get the exact CJS singleton.
const require = createRequire(import.meta.url);
const { autoUpdater } = require("electron-updater");

export const updaterState = {
	enabled: false,
	installing: false,
	updateReady: false
};

let checkTimer = null;
let lastLoggedPercent = -1;
// True while a check was started from the tray (needs a visible result).
let manualRequested = false;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Instant, non-blocking status toast (modal only as last-resort fallback). */
function toast(title, body) {
	if (Notification.isSupported()) {
		new Notification({ title, body }).show();
	} else {
		dialog.showMessageBoxSync({ type: "info", title, message: body, buttons: ["确定"], noLink: true });
	}
}

function showResult(title, body) {
	toast(title, body);
}

function log(message) {
	console.log(`[dsh-studio:updater] ${message}`);
}

/** Keep error lines short: electron-updater errors embed full HTTP headers. */
function shortMessage(error) {
	const text = String(error?.message ?? error);
	return text.split("\n")[0].slice(0, 300);
}

function armEvents() {
	autoUpdater.logger = {
		info: (m) => log(shortMessage(m)),
		warn: (m) => log(shortMessage(m)),
		error: (m) => log(shortMessage(m)),
		debug: (m) => log(shortMessage(m))
	};
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;

	autoUpdater.on("checking-for-update", () => log("checking for update..."));
	autoUpdater.on("update-available", (info) => {
		log(`update available: ${info.version}`);
		toast("DSH Studio 更新", `发现新版本 ${info.version}，正在后台下载…`);
		void autoUpdater.downloadUpdate().catch((error) => log(`download failed: ${shortMessage(error)}`));
	});
	autoUpdater.on("update-not-available", (info) => {
		const manual = manualRequested;
		manualRequested = false;
		log(`no update available (current ${info.version ?? "?"})`);
		if (manual) showResult("DSH Studio 已是最新版本", `当前 ${app.getVersion()} 已是最新。`);
	});
	autoUpdater.on("download-progress", (progress) => {
		const percent = Math.floor(progress.percent);
		if (percent % 25 === 0 && percent !== lastLoggedPercent) {
			lastLoggedPercent = percent;
			log(`downloading update: ${percent}%`);
		}
	});
	autoUpdater.on("update-downloaded", (info) => {
		updaterState.updateReady = true;
		log(`update downloaded (${info.version}) — asking to install`);
		const choice = dialog.showMessageBoxSync({
			type: "info",
			title: "DSH Studio 更新",
			message: `DSH Studio ${info.version} 已下载完成`,
			detail: "立即重启并安装更新？",
			buttons: ["稍后", "立即重启安装"],
			defaultId: 1,
			cancelId: 0,
			noLink: true
		});
		if (choice === 1) quitToInstall();
	});
	autoUpdater.on("error", (error) => {
		// Popups/retries are driven by checkNow(); here we only log so a
		// transient 502 does not interrupt the manual retry loop.
		log(`update error: ${shortMessage(error)}`);
	});
}

/** Enable the updater and schedule the first check. Dev runs are a no-op. */
export function setupUpdater({ delayMs = 10000 } = {}) {
	if (!app.isPackaged) {
		log("disabled (unpackaged/dev run)");
		return;
	}
	updaterState.enabled = true;
	armEvents();
	checkTimer = setTimeout(() => {
		void autoUpdater.checkForUpdates().catch((error) => log(`check failed: ${shortMessage(error)}`));
	}, delayMs);
	log(`armed (first check in ${Math.round(delayMs / 1000)} s)`);
}

/** Manual check (tray/menu) — instant status toast, retries transient errors. */
export async function checkNow() {
	if (!updaterState.enabled) return;
	manualRequested = true;
	lastLoggedPercent = -1;
	toast("DSH Studio 更新", "正在检查更新…（网络不稳会自动重试）");
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			await autoUpdater.checkForUpdates();
			manualRequested = false;
			return;
		} catch (error) {
			if (attempt < MAX_RETRIES) {
				log(`check attempt ${attempt + 1} failed (${shortMessage(error)}); retrying in ${RETRY_DELAY_MS / 1000}s…`);
				await sleep(RETRY_DELAY_MS);
				continue;
			}
			manualRequested = false;
			const message = shortMessage(error);
			showResult("检查更新失败", `${message}\n\n可稍后重试，或点“打开下载页（手动更新）”下载。`);
		}
	}
}

/** User confirmed: let the updater quit the app and install. */
export function quitToInstall() {
	if (updaterState.installing) return;
	updaterState.installing = true;
	log("restarting to install update");
	clearTimeout(checkTimer);
	void autoUpdater.quitAndInstall();
}
