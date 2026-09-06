/**
 * DSH Studio — preload. Kept deliberately minimal: the web UI is the official
 * DeepSeek Harness UI and must stay untouched; shell additions (LAN/phone
 * access controls) are exposed here behind a namespaced, context-isolated
 * surface with a strict channel whitelist.
 */
const { contextBridge, ipcRenderer } = require("electron");

// 主窗口注入的“手机访问”按钮允许调用的通道（白名单）。
const ALLOWED_INVOKE = ["lan:get", "lan:set", "lan:copy", "lan:qr"];

contextBridge.exposeInMainWorld("dshStudio", {
	runtime: "desktop",
	version: process.env.npm_package_version ?? "0.0.0",
	invoke(channel, ...args) {
		if (!ALLOWED_INVOKE.includes(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
		return ipcRenderer.invoke(channel, ...args);
	},
	onLanState(callback) {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("lan:event", listener);
		return () => ipcRenderer.removeListener("lan:event", listener);
	}
});
