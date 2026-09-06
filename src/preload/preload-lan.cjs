/**
 * DSH Studio — 手机访问面板 preload（context-isolated）。
 * 只暴露白名单内的 invoke 通道，页面拿不到 Node/Electron 能力。
 */
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_INVOKE = ["lan:get", "lan:set", "lan:copy", "lan:qr", "lan:open-panel"];

contextBridge.exposeInMainWorld("dshLan", {
	invoke(channel, ...args) {
		if (!ALLOWED_INVOKE.includes(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
		return ipcRenderer.invoke(channel, ...args);
	},
	onState(callback) {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("lan:event", listener);
		return () => ipcRenderer.removeListener("lan:event", listener);
	}
});
