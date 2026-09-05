/**
 * DSH Studio — plugin market IPC service (main process side).
 *
 * Bridges the panel renderer to:
 *   - pluginctl (install/uninstall/list, official pnpm-forward semantics on the
 *     shared $DSH_HOME profile — identical data `dsh web` reads next boot),
 *   - registry helpers (npm search + dsh.bundle annotation),
 *   - a restart-core request handled by the shell (main.mjs).
 */
import { app, ipcMain, shell } from "electron";
import {
	effectiveDshHome,
	listPlugins,
	installPlugin,
	uninstallPlugin
} from "../core/pluginctl.mjs";
import { searchNpm, annotateWithBundle, describePackage } from "../core/registry.mjs";
import { analyzeManifest, bundledVersions } from "../core/compat.mjs";

/** windows that should receive progress events (the panel windows). */
let panelWindows = () => [];
let executorPath = process.execPath;

export function configurePluginService({ getPanelWindows, execPath }) {
	if (getPanelWindows) panelWindows = getPanelWindows;
	if (execPath) executorPath = execPath;
}

function broadcast(payload) {
	for (const win of panelWindows()) {
		if (!win.isDestroyed()) win.webContents.send("plugin:event", payload);
	}
}

function home() {
	return effectiveDshHome();
}

async function runWithEvents(fn, initial) {
	broadcast({ kind: "phase", text: initial });
	try {
		const result = await fn();
		broadcast({ kind: "phase", text: "完成" });
		return { ok: true, ...result };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		broadcast({ kind: "phase", text: `失败: ${message}` });
		return { ok: false, error: message };
	}
}

const PLAIN_NAME = /^(@[^/]+\/)?[a-zA-Z0-9._-]+$/;

/** Best-effort compatibility analysis for a plain registry package name. */
async function compatOf(spec) {
	const name = spec.trim();
	if (!PLAIN_NAME.test(name)) return null;
	try {
		const meta = await describePackage(name);
		return analyzeManifest(meta);
	} catch {
		return null;
	}
}

function announceCompat(compat) {
	if (compat === null) {
		broadcast({ kind: "line", text: "（非 registry 包名，跳过兼容检查）" });
		return;
	}
	broadcast({ kind: "line", text: `兼容检查 ${compat.name}@${compat.version}：${compat.ok ? "OK" : "存在风险项"}` });
	for (const issue of compat.issues) {
		broadcast({
			kind: "line",
			text: `${issue.kind === "danger" ? "!!" : "!!"} ${issue.package} 要求 ${issue.range}，内核带 ${issue.installed ?? "无"}：${issue.note}`
		});
	}
	if (compat.bundle) broadcast({ kind: "line", text: "该包声明 dsh.bundle（将加入 profile 插件层）" });
	else broadcast({ kind: "line", text: "该包未声明 dsh.bundle：只会作为普通依赖加入（不会成为插件层）" });
}

export function registerPluginIpc({ onRestartCore } = {}) {
	ipcMain.handle("plugins:info", async () => {
		const info = listPlugins(home());
		const bundled = bundledVersions();
		return {
			ok: true,
			home: info.home,
			profile: info.profile,
			profileDir: info.profileDir,
			appVersion: (() => { try { return app.getVersion(); } catch { return "0.0.0"; } })(),
			node: process.versions.node,
			core: {
				dsh: bundled["@deepseek-ai/dsh"] ?? null,
				cordis: bundled["@deepseek-ai/cordis"] ?? null,
				webApp: bundled["@deepseek-ai/dsh-web-app"] ?? null,
				scopePackages: Object.keys(bundled).length
			}
		};
	});

	ipcMain.handle("plugins:list", async () => {
		return runWithEvents(async () => ({ info: listPlugins(home()) }), "读取插件清单…");
	});

	// text "" = 热门（推荐）feed；page 从 1 开始，每页 12（3×4）。
	ipcMain.handle("plugins:search", async (_event, text, page = 1) => {
		const query = typeof text === "string" ? text.trim() : "";
		const from = Math.max(0, ((Number(page) || 1) - 1) * 12);
		try {
			broadcast({ kind: "phase", text: query === "" ? "加载热门插件…" : `搜索 npm: ${query}` });
			const { results, total } = await searchNpm(query, 12, from);
			const annotated = await annotateWithBundle(results);
			return { ok: true, results: annotated, total, page: from / 12 + 1 };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("plugins:describe", async (_event, name) => {
		if (typeof name !== "string" || name.trim() === "") return { ok: false, error: "缺少包名" };
		try {
			const meta = await describePackage(name.trim());
			return { ok: true, meta };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

	ipcMain.handle("plugins:open-url", async (_event, url) => {
		if (typeof url !== "string" || !/^https?:\/\//u.test(url)) return { ok: false, error: "非法地址" };
		await shell.openExternal(url);
		return { ok: true };
	});

	ipcMain.handle("plugins:compat", async (_event, spec) => {
		if (typeof spec !== "string" || spec.trim() === "") return { ok: false, error: "缺少包名" };
		const compat = await compatOf(spec);
		return compat === null ? { ok: true, compat: null } : { ok: true, compat };
	});

	ipcMain.handle("plugins:install", async (_event, spec) => {
		if (typeof spec !== "string" || spec.trim() === "") return { ok: false, error: "缺少包名" };
		const compat = await compatOf(spec);
		announceCompat(compat);
		return await runWithEvents(
			async () => ({
				info: await installPlugin(spec.trim(), {
					dshHome: home(),
					execPath: executorPath,
					onOutput: (line) => broadcast({ kind: "line", text: line })
				}),
				compat
			}),
			`安装 ${spec}…（安装完成后需重启内核生效；该 profile 与 dsh web 共用）`
		);
	});

	ipcMain.handle("plugins:uninstall", async (_event, name) => {
		if (typeof name !== "string" || name.trim() === "") return { ok: false, error: "缺少包名" };
		return await runWithEvents(
			async () => ({
				info: await uninstallPlugin(name.trim(), {
					dshHome: home(),
					execPath: executorPath,
					onOutput: (line) => broadcast({ kind: "line", text: line })
				})
			}),
			`卸载 ${name}…（完成后建议重启内核）`
		);
	});

	// Restart is executed by the shell (main.mjs holds the core lifecycle).
	ipcMain.handle("plugins:restart-core", async () => {
		if (typeof onRestartCore === "function") {
			const result = await onRestartCore();
			return result ?? { ok: true };
		}
		return { ok: true };
	});
}
