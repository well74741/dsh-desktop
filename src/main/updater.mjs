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
import { app, dialog } from "electron";
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
		void autoUpdater.downloadUpdate().catch((error) => log(`download failed: ${shortMessage(error)}`));
	});
	autoUpdater.on("update-not-available", (info) => {
		log(`no update available (current ${info.version ?? "?"})`);
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

/** Manual check (tray menu). */
export function checkNow() {
	if (!updaterState.enabled) return;
	lastLoggedPercent = -1;
	void autoUpdater.checkForUpdates().catch((error) => log(`check failed: ${shortMessage(error)}`));
}

/** User confirmed: let the updater quit the app and install. */
export function quitToInstall() {
	if (updaterState.installing) return;
	updaterState.installing = true;
	log("restarting to install update");
	clearTimeout(checkTimer);
	void autoUpdater.quitAndInstall();
}
