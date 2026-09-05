/**
 * DSH Studio — release center preload (context-isolated).
 */
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_INVOKE = ["release:info", "release:push", "release:publish", "release:open-actions"];

contextBridge.exposeInMainWorld("dshRelease", {
	invoke(channel, ...args) {
		if (!ALLOWED_INVOKE.includes(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
		return ipcRenderer.invoke(channel, ...args);
	},
	onEvent(callback) {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("release:event", listener);
		return () => ipcRenderer.removeListener("release:event", listener);
	}
});
