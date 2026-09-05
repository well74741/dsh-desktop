/**
 * DSH Studio — preload. Kept deliberately minimal: the web UI is the official
 * DeepSeek Harness UI and must stay untouched; future native bridges (tray
 * actions, plugin management IPC, updater events) are added here behind a
 * namespaced, context-isolated surface.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("dshStudio", {
	runtime: "desktop",
	version: process.env.npm_package_version ?? "0.0.0"
});
