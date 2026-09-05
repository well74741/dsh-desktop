/**
 * DSH Studio — Electron main process.
 *
 * Owns the desktop shell only:
 *   - single-instance lock,
 *   - spawns the harness core as a Node-semantics child of this same
 *     executable (ELECTRON_RUN_AS_NODE=1) — never touches the kernel's code,
 *   - creates the BrowserWindow over the kernel's loopback URL,
 *   - tray with "open in default browser" (web-mode fallback on the SAME live
 *     kernel & data), show/hide and quit,
 *   - graceful dispose of the core on quit.
 *
 * Modes:
 *   default    : windowed desktop app (window hidden to tray on close).
 *   --web      : web fallback mode — no app window; opens the same UI in the
 *                default browser (equivalent to `dsh web`, same DSH_HOME).
 *   --selfcheck: boot the core child, wait for the ready line, exit 0/1.
 *                Used to validate the Electron-as-Node spawn path headlessly.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, Notification, shell } from "electron";
import { dirname, join } from "node:path";
import { setupUpdater, checkNow, updaterState } from "./updater.mjs";
import { initFileLog, logFilePath, readLogTail } from "./logger.mjs";
import { configurePluginService, registerPluginIpc } from "./plugin-service.mjs";
import { configureReleaseService, registerReleaseIpc } from "./release-service.mjs";
import { loadSettings, saveSettings } from "./settings.mjs";

// Paths are relative to this file (src/main/): "../../" is the project root.
const ASSETS_DIR = fileURLToPath(new URL("../../assets", import.meta.url));
const CORE_ENTRY = fileURLToPath(new URL("../core/run.mjs", import.meta.url));
const TRAY_ICON = join(ASSETS_DIR, "tray-32.png");
const PANEL_FILE = fileURLToPath(new URL("../panel/index.html", import.meta.url));
const PANEL_PRELOAD = fileURLToPath(new URL("../preload/preload-panel.cjs", import.meta.url));
const RELEASE_FILE = fileURLToPath(new URL("../release/index.html", import.meta.url));
const RELEASE_PRELOAD = fileURLToPath(new URL("../preload/preload-release.cjs", import.meta.url));
// The dev repository this app runs from (exists only in source checkouts).
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_NAME = "DSH Studio";
// Embedded 16x16 fallback (bright glyph) in case the icon file is unavailable.
const TRAY_FALLBACK_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAjElEQVR42mNgGHTAt+rWf7/q2//9a+7896+5+z+g9v7/wLoH/4PqHv4Prn/0P7jhyX+KNIc0PP0f2vjsP0Waw5qe/w9veolqCKmaw5tfoRpAquaIltfoBpCmObLlDaoBpGqOan2HagA+zbgAigH4bCbKAHzOJs4APH4mygAQwBVgRGmGAWyhTbRmcgAAn8XT4MAep2kAAAAASUVORK5CYII=";

const ARGV = new Set(process.argv.slice(1));
const MODE_WEB = ARGV.has("--web");
const MODE_SELFCHECK = ARGV.has("--selfcheck");
const OPEN_PLUGINS = ARGV.has("--plugins");

let core = null;
let coreLines = null;
let mainWindow = null;
let tray = null;
let quitting = false;
let readyUrl = null;
let disposed = false;
let coreExitCount = 0;
let loadedUrl = null;
// Set after repeated desktop-shell/core failures: keep going as the web-mode
// fallback (same kernel, opened in the default browser, no app window).
let webFallback = false;
let closeHintShown = false;
let restartExpected = false;
// Start without a main window (--hidden, or OS login with "autostart hidden").
let hiddenAtStart = ARGV.has("--hidden");
let deepLinkHandled = false;
const pluginPanels = [];
const releasePanels = [];

function releasePanelWindows() {
	return [...releasePanels];
}

function appVersion() {
	try {
		return app.getVersion() || "";
	} catch {
		return "";
	}
}

function titleWithVersion() {
	return `${APP_NAME} v${appVersion()}`;
}

function notify(title, body) {
	if (!Notification.isSupported()) {
		log(`notification skipped (unsupported): ${title} — ${body}`);
		return;
	}
	const notification = new Notification({
		title,
		body,
		icon: TRAY_ICON
	});
	notification.on("click", () => {
		if (isWebLike()) return;
		if (mainWindow === null && readyUrl !== null) createWindow(readyUrl);
		mainWindow?.show();
		mainWindow?.focus();
	});
	notification.show();
	log(`notification: ${title}`);
}

function isWebLike() {
	return MODE_WEB || webFallback;
}

function runtimeLabel() {
	return isWebLike() ? "web" : "desktop";
}

function log(message) {
	console.log(`[dsh-studio] ${message}`);
}

function stopCore(code = 0) {
	if (disposed) return Promise.resolve();
	disposed = true;
	return new Promise((resolve) => {
		if (core === null || core.exitCode !== null || core.killed) {
			resolve();
			return;
		}
		const forceTimer = setTimeout(() => {
			log("core did not stop in time; terminating");
			core.kill();
		}, 8000);
		core.once("exit", () => {
			clearTimeout(forceTimer);
			resolve();
		});
		try {
			core.stdin?.write("shutdown\n");
		} catch {
			core.kill();
			resolve();
		}
		setTimeout(() => resolve(), 9000);
	});
}

async function quitApp() {
	if (quitting) return;
	quitting = true;
	await stopCore(0);
	app.exit(0);
}

function spawnCore() {
	log(`spawning harness core (Electron-as-Node child, runtime=${runtimeLabel()})`);
	// --expose-internals: the harness loader uses Node internals for config
	// hot-reload (HMR); under plain Node it falls back to a native helper that
	// is not built for Electron's runtime, so we pass the official flag instead.
	const coreArgs = ["--expose-internals", CORE_ENTRY, ...(MODE_SELFCHECK ? ["--smoke"] : [])];
	core = spawn(process.execPath, coreArgs, {
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			DSH_STUDIO_CORE: "1",
			// Self-identification for kernel/host plugins that need it.
			DSH_STUDIO_RUNTIME: runtimeLabel()
		},
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true
	});

	core.stderr?.setEncoding("utf8");
	core.stderr?.on("data", (chunk) => {
		for (const line of chunk.split(/\r?\n/u)) {
			if (line.trim() !== "") console.error(`[core] ${line}`);
		}
	});

	coreLines = createInterface({ input: core.stdout, terminal: false });
	coreLines.on("line", (line) => {
		if (line.startsWith("DSH_STUDIO_READY ")) {
			try {
				const info = JSON.parse(line.slice("DSH_STUDIO_READY ".length));
				onCoreReady(info);
			} catch (error) {
				log(`bad ready line: ${String(error)}`);
			}
			return;
		}
		if (line.trim() !== "") log(`[core] ${line}`);
	});

	core.on("exit", (code) => {
		log(`core exited (code ${String(code)})`);
		if (MODE_SELFCHECK) {
			app.exit(code === 0 ? 0 : 1);
			return;
		}
		// disposed => exit was requested via stopCore (quit or restart), not a crash.
		if (quitting || updaterState.installing || disposed) return;
		coreExitCount += 1;

		// Unexpected core death: show the real reason (log tail) and offer
		// retry or a web-mode fallback (same kernel, opened in the browser).
		const tail = readLogTail(30).join("\n");
		const location = logFilePath();
		const detail = [
			`内核进程意外退出（code ${String(code)}）。`,
			location !== null ? `完整日志：${location}` : "",
			!isWebLike() ? "可在网页模式（保底）下继续开发/使用：同一内核，浏览器打开，无桌面窗口。" : "",
			tail !== "" ? `\n--- 最近日志 ---\n${tail}` : ""
		]
			.filter(Boolean)
			.join("\n");
		let choice;
		if (isWebLike()) {
			// Already in fallback: one more retry, then give up.
			choice = coreExitCount >= 2 ? 0 : 1;
		} else {
			// Desktop: after two failures, auto-switch to the web fallback.
			choice = coreExitCount >= 2
				? 2
				: dialog.showMessageBoxSync({
						type: "error",
						title: APP_NAME,
						message: "Harness core stopped unexpectedly (code " + String(code) + ")",
						detail,
						buttons: ["退出", "重试", "网页模式保底运行"],
						defaultId: 1,
						cancelId: 0,
						noLink: true
					});
		}
		if (choice === 2) {
			log("switching to web-mode fallback");
			webFallback = true;
			coreExitCount = 0;
			disposed = false;
			readyUrl = null;
			spawnCore();
		} else if (choice === 1) {
			respawnCore();
		} else {
			quitting = true;
			app.exit(code ?? 1);
		}
	});
	core.on("error", (error) => {
		log(`core spawn error: ${String(error)}`);
		if (!quitting) {
			dialog.showErrorBox(APP_NAME, `Could not start the harness core:\n${String(error)}`);
			app.exit(1);
		}
	});
}

/** Reset shell state and spawn a fresh core (used by the error-dialog retry). */
function respawnCore() {
	log("respawn core after failure");
	disposed = false;
	readyUrl = null;
	spawnCore();
}

/** Full core restart requested from the plugin panel (apply plugin changes). */
async function restartCore() {
	log("restarting core (plugin change)");
	restartExpected = true;
	await stopCore(0);
	coreExitCount = 0;
	disposed = false;
	readyUrl = null;
	spawnCore();
	return { ok: true };
}

function pluginPanelWindows() {
	return [...pluginPanels];
}

/** Open (or focus) the plugin market panel window. */
function openPluginPanel() {
	const existing = pluginPanels.find((win) => !win.isDestroyed());
	if (existing) {
		existing.show();
		existing.focus();
		return;
	}
	const win = new BrowserWindow({
		width: 1020,
		height: 720,
		minWidth: 720,
		minHeight: 480,
		title: "DSH Studio 插件市场",
		icon: nativeImage.createFromPath(TRAY_ICON),
		backgroundColor: "#111318",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: PANEL_PRELOAD
		}
	});
	pluginPanels.push(win);
	win.webContents.on("did-fail-load", (_event, code, description) => {
		log(`plugin panel failed to load: ${String(code)} ${String(description)}`);
	});
	win.webContents.on("console-message", (_event, level, message) => {
		if (String(message ?? "") !== "") log(`[plugin-panel console] ${String(message)}`);
	});
	win.webContents.on("preload-error", (_event, path, error) => {
		log(`plugin panel preload error: ${String(path)} ${String(error?.message ?? error)}`);
	});
	win.on("closed", () => {
		const index = pluginPanels.indexOf(win);
		if (index !== -1) pluginPanels.splice(index, 1);
	});
	log("opening plugin market panel");
	void win.loadFile(PANEL_FILE);
}

/** Open (or focus) the release-center panel (developer tool). */
function openReleasePanel() {
	const existing = releasePanels.find((win) => !win.isDestroyed());
	if (existing) {
		existing.show();
		existing.focus();
		return;
	}
	const win = new BrowserWindow({
		width: 860,
		height: 640,
		minWidth: 640,
		minHeight: 420,
		title: "DSH Studio 发布中心",
		icon: nativeImage.createFromPath(TRAY_ICON),
		backgroundColor: "#111318",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: RELEASE_PRELOAD
		}
	});
	releasePanels.push(win);
	win.webContents.on("did-fail-load", (_event, code, description) => {
		log(`release panel failed to load: ${String(code)} ${String(description)}`);
	});
	win.webContents.on("console-message", (_event, level, message) => {
		if (String(message ?? "") !== "") log(`[release-panel console] ${String(message)}`);
	});
	win.webContents.on("preload-error", (_event, path, error) => {
		log(`release panel preload error: ${String(path)} ${String(error?.message ?? error)}`);
	});
	win.on("closed", () => {
		const index = releasePanels.indexOf(win);
		if (index !== -1) releasePanels.splice(index, 1);
	});
	log("opening release center panel");
	void win.loadFile(RELEASE_FILE);
}

function createWindow(url) {
	mainWindow = new BrowserWindow({
		width: 1360,
		height: 880,
		minWidth: 900,
		minHeight: 600,
		title: titleWithVersion(),
		icon: nativeImage.createFromPath(TRAY_ICON),
		show: false,
		backgroundColor: "#101014",
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			preload: fileURLToPath(new URL("../preload/preload.cjs", import.meta.url))
		}
	});
	// Keep the versioned window title even when the web UI sets its own <title>.
	mainWindow.on("page-title-updated", (event) => {
		event.preventDefault();
		mainWindow?.setTitle(titleWithVersion());
	});

	mainWindow.loadURL(url);
	loadedUrl = url;
	mainWindow.once("ready-to-show", () => mainWindow?.show());
	mainWindow.on("close", (event) => {
		if (!quitting && !updaterState.installing) {
			event.preventDefault();
			mainWindow?.hide();
			if (!closeHintShown) {
				closeHintShown = true;
				notify("DSH Studio 仍在后台运行", "关闭窗口后应用驻留托盘；点此恢复主窗口，右键托盘图标可管理或退出。");
			}
		}
	});
	mainWindow.on("closed", () => {
		mainWindow = null;
	});
	mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
		// The web UI may open links in new windows — hand them to the OS browser.
		if (/^https?:\/\//u.test(target)) void shell.openExternal(target);
		return { action: "deny" };
	});
}

function buildTray() {
	let icon = nativeImage.createFromPath(TRAY_ICON);
	if (icon.isEmpty()) {
		log("tray icon file unavailable — using embedded fallback");
		icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_FALLBACK_B64}`);
	}
	icon = icon.resize({ width: 16, height: 16, quality: "best" });
	log(`tray icon: empty=${String(icon.isEmpty())} size=${icon.getSize().width}x${icon.getSize().height}`);
	tray = new Tray(icon);

	const menu = Menu.buildFromTemplate([
		{
			label: `${titleWithVersion()}（${runtimeLabel()} 运行）`,
			enabled: false
		},
		{ type: "separator" },
		{
			label: "打开主窗口",
			click: () => {
				if (isWebLike()) return;
				if (mainWindow === null && readyUrl !== null) createWindow(readyUrl);
				mainWindow?.show();
				mainWindow?.focus();
			}
		},
		{
			label: "在默认浏览器中打开（网页模式）",
			click: () => {
				if (readyUrl !== null) void shell.openExternal(readyUrl);
			}
		},
		{
			label: "插件市场…",
			click: () => openPluginPanel()
		},
		{
			label: "发布中心…（开发）",
			click: () => openReleasePanel()
		},
		{
			label: "开机自启",
			type: "checkbox",
			checked: isLoginItemEnabled(),
			click: (item) => applyLoginItem(item.checked, loadSettings().autoStartHidden)
		},
		{
			label: "自启时隐藏到托盘（下次登录生效）",
			type: "checkbox",
			checked: loadSettings().autoStartHidden,
			click: (item) => {
				saveSettings({ autoStartHidden: item.checked });
				if (isLoginItemEnabled()) applyLoginItem(true, item.checked);
			}
		},
		...(updaterState.enabled
			? [
					{ type: "separator" },
					{
						label: "检查更新…",
						click: () => void checkNow()
					},
					{
						label: "打开下载页（手动更新）",
						click: () => void shell.openExternal("https://github.com/well74741/dsh-desktop/releases/latest")
					}
				]
			: []),
		{ type: "separator" },
		{ label: "退出 " + APP_NAME, click: () => void quitApp() }
	]);
	tray.setToolTip(`${titleWithVersion()} — DeepSeek Harness`);
	tray.setContextMenu(menu);
	tray.on("double-click", focusMain);
}

async function onCoreReady(info) {
	readyUrl = info.url;
	coreExitCount = 0;
	log(`core ready: ${info.url} (port ${String(info.port)}, DSH_HOME=${info.dshHome})`);

	if (MODE_SELFCHECK) {
		// Self-check path: boot smoke is already shutting the core down; just leave.
		log("selfcheck: core booted and served a ready line OK");
		return;
	}

	// Verify the UI actually answers before opening a window (retry briefly:
	// the server may still be finishing route setup when the ready line lands).
	let ok = false;
	for (let attempt = 0; attempt < 10 && !ok; attempt++) {
		ok = await fetch(info.url).then((res) => res.status === 200).catch(() => false);
		if (!ok) await new Promise((resolve) => setTimeout(resolve, 500));
	}
	log(ok ? "web UI responds (HTTP 200)" : "warning: web UI did not answer HTTP 200 yet");

	buildTray();

	if (restartExpected) {
		restartExpected = false;
		const applied = "内核已重启（插件/变更已生效）";
		if (mainWindow !== null && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
			notify("DSH Studio", applied);
		} else {
			log(applied);
		}
	}

	// Clean/pure start: windowless to the tray (used by login autostart --hidden).
	if (hiddenAtStart && !isWebLike()) {
		notify("DSH Studio 已在后台启动", "主窗口未显示；双击托盘图标或点击此通知打开。");
		return;
	}

	if (isWebLike()) {
		log("web-mode fallback: opening in the default browser");
		await shell.openExternal(info.url);
		notify("DSH Studio · 网页模式", "内核已就绪并在默认浏览器中打开。关闭本程序将结束该内核，可从托盘退出。");
		return;
	}

	// On core restarts (plugin changes) the port/token change — reload the window.
	if (mainWindow !== null && !mainWindow.isDestroyed()) {
		if (loadedUrl !== info.url) {
			log("reloading main window onto the new core URL");
			loadedUrl = info.url;
			void mainWindow.loadURL(info.url);
		}
		return;
	}
	createWindow(info.url);

	// First-instance deep link (dsh://… on the command line) — once per boot.
	if (!deepLinkHandled && !MODE_SELFCHECK) {
		deepLinkHandled = true;
		handleDeepLink(process.argv);
	}
}

function isLoginItemEnabled() {
	try {
		return app.getLoginItemSettings().openAtLogin;
	} catch {
		return false;
	}
}

/** Apply the login item together with its start-hidden argument (Windows). */
function applyLoginItem(open, startHidden) {
	try {
		app.setLoginItemSettings({
			openAtLogin: open,
			...(startHidden ? { args: ["--hidden"] } : {})
		});
		log(`login item: open=${String(open)} hidden=${String(startHidden)}`);
	} catch (error) {
		log(`login item failed: ${String(error?.message ?? error)}`);
	}
}

function focusMain() {
	if (isWebLike()) {
		if (readyUrl !== null) void shell.openExternal(readyUrl);
		return;
	}
	if (mainWindow === null && readyUrl !== null) createWindow(readyUrl);
	mainWindow?.show();
	mainWindow?.focus();
}

/** Handle a dsh:// deep link (second-instance argv or first-instance startup). */
function handleDeepLink(argv) {
	const target = argv.find((arg) => /^dsh:/iu.test(arg));
	if (target === undefined) return false;
	log(`deep link received: ${target}`);
	if (/\/web(?:$|[?#])/iu.test(target) || isWebLike()) {
		if (readyUrl !== null) void shell.openExternal(readyUrl);
	} else {
		focusMain();
	}
	return true;
}

/** dsh:// protocol deep links (reserved; packaged only). */
function registerProtocol() {
	if (!app.isPackaged) return;
	try {
		app.setAsDefaultProtocolClient("dsh");
		log("protocol registered: dsh://");
	} catch (error) {
		log(`protocol registration failed: ${String(error?.message ?? error)}`);
	}
}

/** Application menu bar — mirrors the tray actions inside the main window. */
function buildAppMenu() {
	const releasesUrl = "https://github.com/well74741/dsh-desktop/releases/latest";
	const logDir = (() => {
		const file = logFilePath();
		return file === null ? null : dirname(file);
	})();
	const template = [
		{
			label: "文件",
			submenu: [
				{ label: "插件市场…", click: () => openPluginPanel() },
				{ label: "发布中心…（开发）", click: () => openReleasePanel() },
				{ type: "separator" },
				{
					label: "在默认浏览器中打开（网页模式）",
					enabled: () => readyUrl !== null,
					click: () => {
						if (readyUrl !== null) void shell.openExternal(readyUrl);
					}
				},
				{ type: "separator" },
				{ label: "检查更新…", click: () => void checkNow() },
				{ label: "打开下载页（手动更新）", click: () => void shell.openExternal(releasesUrl) },
				{ type: "separator" },
				{
					label: "开机自启",
					type: "checkbox",
					checked: isLoginItemEnabled(),
					click: (item) => applyLoginItem(item.checked, loadSettings().autoStartHidden)
				},
				{
					label: "自启时隐藏到托盘（下次登录生效）",
					type: "checkbox",
					checked: loadSettings().autoStartHidden,
					click: (item) => {
						saveSettings({ autoStartHidden: item.checked });
						if (isLoginItemEnabled()) applyLoginItem(true, item.checked);
					}
				},
				{ type: "separator" },
				{ label: "退出 " + APP_NAME, click: () => void quitApp() }
			]
		},
		{
			label: "视图",
			submenu: [
				{ role: "reload", label: "重新加载" },
				{ role: "forceReload", label: "强制重新加载" },
				{ role: "toggleDevTools", label: "开发者工具" },
				{ type: "separator" },
				{ role: "resetZoom", label: "实际大小" },
				{ role: "zoomIn", label: "放大" },
				{ role: "zoomOut", label: "缩小" },
				{ type: "separator" },
				{ role: "togglefullscreen", label: "全屏" }
			]
		},
		{
			label: "帮助",
			submenu: [
				...(logDir !== null
					? [
							{
								label: "打开日志目录",
								click: () => void shell.openPath(logDir).catch(() => log("open log dir failed"))
							}
						]
					: []),
				{ label: "GitHub 仓库", click: () => void shell.openExternal("https://github.com/well74741/dsh-desktop") },
				{ type: "separator" },
				{
					label: `关于 ${APP_NAME} v${appVersion()}`,
					click: () => {
						void dialog.showMessageBox({
							type: "info",
							title: `关于 ${APP_NAME}`,
							message: `${titleWithVersion()}\nDeepSeek Harness 桌面版（内核与 dsh web 同源）`,
							buttons: ["确定"]
						});
					}
				}
			]
		}
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function ensureSingleInstance() {
	// Dev/CI escape hatch: allows e.g. selfcheck while a real app instance is
	// open. Never set for end users.
	if (process.env.DSH_STUDIO_ALLOW_MULTI === "1") {
		log("multi-instance allowed (DSH_STUDIO_ALLOW_MULTI=1)");
		return true;
	}
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return false;
	}
	app.on("second-instance", (_event, argv) => {
		if (handleDeepLink(argv)) return;
		focusMain();
	});
	return true;
}

app.setName(APP_NAME);
initFileLog();

void (async () => {
	if (!(await ensureSingleInstance())) return;

	await app.whenReady();
	log(`${APP_NAME} starting (electron ${process.versions.electron}, node ${process.versions.node})`);

	// Windows notifications/taskbar identity + deep-link protocol (packaged).
	if (app.isPackaged) {
		try {
			app.setAppUserModelId("com.dshstudio.desktop");
		} catch {
			/* best effort */
		}
		registerProtocol();
	}

	configurePluginService({
		getPanelWindows: pluginPanelWindows,
		execPath: process.execPath
	});
	registerPluginIpc({ onRestartCore: restartCore });
	configureReleaseService({
		getWindows: releasePanelWindows,
		gitRepoRoot: REPO_ROOT,
		execPath: process.execPath
	});
	registerReleaseIpc();

	buildAppMenu();
	log(`start hidden=${String(hiddenAtStart)} (console-free GUI process)`);
	spawnCore();

	if (OPEN_PLUGINS && !MODE_SELFCHECK) openPluginPanel();

	// Auto-update only in packaged builds (setupUpdater is a no-op in dev).
	if (!MODE_SELFCHECK) setupUpdater({ delayMs: 10000 });
})();

app.on("before-quit", (event) => {
	// Updater-driven quit (quitAndInstall) must not be intercepted.
	if (quitting || updaterState.installing) return;
	event.preventDefault();
	void quitApp();
});

app.on("window-all-closed", () => {
	// Keep running in the tray; real exit goes through the tray menu / before-quit.
	if (process.platform === "darwin") return;
});
