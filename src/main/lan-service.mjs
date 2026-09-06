/**
 * DSH Studio — 手机/局域网访问 IPC 服务（main 进程侧）。
 *
 * 外壳层功能：这个模块只负责把「手机访问」面板/聊天按钮的请求接到外壳逻辑上
 * （保存开关状态、请求重启内核、复制地址、生成二维码）。内核如何监听由
 * src/core/run.mjs 依据 DSH_STUDIO_LAN_MODE 环境变量决定；本模块与
 * 内核代码没有任何交集。
 */
import { clipboard, ipcMain } from "electron";
import QRCode from "qrcode";

/** 应该收到状态推送的窗口（手机访问面板窗口 + 桌面主窗口）。 */
let panelWindows = () => [];
/** 由 main.mjs 提供的开关处理器（保存设置 + 重启内核）。 */
let restartCoreFn = null;
/** 由 main.mjs 提供的当前状态快照函数。 */
let snapshotFn = () => ({ enabled: false, ready: false, port: null, lanUrl: null, lanAddresses: [] });
/** 由 main.mjs 提供的“打开手机访问面板”函数（右上角悬浮按钮用）。 */
let openPanelFnValue = null;

function broadcast(payload) {
	for (const win of panelWindows()) {
		if (!win.isDestroyed()) win.webContents.send("lan:event", payload);
	}
}

/** 供 main.mjs 在状态变化（内核就绪/重启中）时推送给已打开的窗口。 */
export function broadcastLanState(state) {
	broadcast({ type: "state", state });
}

export function registerLanIpc({ getPanelWindows, onRestartCore, getSnapshot, openPanelFn } = {}) {
	if (typeof getPanelWindows === "function") panelWindows = getPanelWindows;
	if (typeof onRestartCore === "function") restartCoreFn = onRestartCore;
	if (typeof getSnapshot === "function") snapshotFn = getSnapshot;
	if (typeof openPanelFn === "function") openPanelFnValue = openPanelFn;

	ipcMain.handle("lan:get", async () => snapshotFn());

	ipcMain.handle("lan:set", async (_event, enabled) => {
		if (restartCoreFn === null) return { ok: false, error: "内核重启不可用" };
		const result = await restartCoreFn(Boolean(enabled));
		return { ok: true, ...result };
	});

	// 右上角悬浮按钮点击 → 打开/聚焦“手机访问”面板窗口。
	ipcMain.handle("lan:open-panel", async () => {
		if (openPanelFnValue === null) return { ok: false, error: "面板不可用" };
		openPanelFnValue();
		return { ok: true };
	});

	ipcMain.handle("lan:copy", async (_event, text) => {
		if (typeof text === "string" && text.length > 0 && text.length <= 4096) {
			clipboard.writeText(text);
			return { ok: true };
		}
		return { ok: false, error: "复制失败" };
	});

	// 把当前“带钥匙的局域网地址”画成二维码图片返回（页面 <img> 直接用）。
	ipcMain.handle("lan:qr", async () => {
		try {
			const snapshot = snapshotFn();
			const target = snapshot && typeof snapshot.lanUrl === "string" && snapshot.lanUrl !== "" ? snapshot.lanUrl : null;
			if (target === null) return { ok: true, dataUrl: null };
			const dataUrl = await QRCode.toDataURL(target, {
				errorCorrectionLevel: "M",
				margin: 1,
				width: 560,
				color: { dark: "#0b0d10", light: "#ffffff" }
			});
			return { ok: true, dataUrl };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});
}
