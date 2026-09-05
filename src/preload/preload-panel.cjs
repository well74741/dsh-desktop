/**
 * DSH Studio — plugin market panel preload (context-isolated).
 */
const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_INVOKE = [
	"plugins:info",
	"plugins:list",
	"plugins:search",
	"plugins:compat",
	"plugins:install",
	"plugins:uninstall",
	"plugins:restart-core"
];

contextBridge.exposeInMainWorld("dshPlugins", {
	invoke(channel, ...args) {
		if (!ALLOWED_INVOKE.includes(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
		return ipcRenderer.invoke(channel, ...args);
	},
	onEvent(callback) {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("plugin:event", listener);
		return () => ipcRenderer.removeListener("plugin:event", listener);
	}
});
