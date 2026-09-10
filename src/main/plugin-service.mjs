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
import { existsSync } from "node:fs";
import {
	effectiveDshHome,
	listPlugins,
	installPlugin,
	uninstallPlugin
} from "../core/pluginctl.mjs";
import { searchNpm, annotateWithBundle, annotateStars, annotateDownloads, describePackage, POPULAR_QUERY, fetchLatestKernelVersion } from "../core/registry.mjs";
import semver from "semver";
import { analyzeManifest, bundledVersions } from "../core/compat.mjs";

/** windows that should receive progress events (the panel windows). */
let panelWindows = () => [];
let executorPath = process.execPath;

// 插件市场搜索结果池：key = `查询词\0只看dsh\0排序` → { pool, done }
// “只看 dsh”需要跨更多候选过滤，否则一页常只有一两个；这里按需多取几屏并缓存。
const marketPool = new Map();
const MARKET_PAGE = 12;
const MARKET_CHUNK = 24;
// 覆盖多组关键词，减少“真插件没被搜到”的遗漏（npm 搜索只看名字/描述/关键词）。
const COVER_QUERIES = [POPULAR_QUERY, "keywords:dsh-plugin", "keywords:deepseek-harness", "dsh plugin"];

/** 本次搜索要扫的候选词集合：用户输入了就用它，否则用覆盖词集合。 */
function queriesFor(query) {
	return query === "" ? [...new Set(COVER_QUERIES)] : [query];
}

/**
 * 取候选池：
 * - 普通搜索：单查询按页取（快）；
 * - 只看 dsh / 热门：多关键词并集 + 对候选打 bundle 标记后再过滤，最后只给入池项取星数
 *   （避免对上百个无关包请求 GitHub 撞限流）。
 */
async function marketSearch(query, page, only, sort) {
	const key = `${query}\x00${only ? 1 : 0}\x00${sort || ""}`;
	let entry = marketPool.get(key);
	if (!entry) {
		entry = { pool: [], done: false };
		marketPool.set(key, entry);
	}
	const multi = only || query === "";
	const need = page * MARKET_PAGE;
	if (multi && !entry.done) {
		const seen = new Set(entry.pool.map((i) => i.name));
		for (const q of queriesFor(query)) {
			for (let chunk = 0; chunk < 3; chunk += 1) {
				const { results } = await searchNpm(q, MARKET_CHUNK, chunk * MARKET_CHUNK);
				if (results.length === 0) break;
				const annotated = await annotateWithBundle(results);
				for (const item of annotated) {
					if (seen.has(item.name)) continue;
					seen.add(item.name);
					if (only && !item.dshBundle) continue;
					entry.pool.push(item);
				}
				if (entry.pool.length >= need && chunk > 0) break;
			}
		}
		entry.done = true;
	} else if (!multi) {
		while (entry.pool.length < need) {
			const from = entry.pool.length;
			const { results } = await searchNpm(query, MARKET_CHUNK, from);
			if (results.length === 0) break;
			entry.pool.push(...(await annotateWithBundle(results)));
		}
	}
	const pool = entry.pool.slice();
	if (sort === "downloads") {
		await annotateDownloads(pool);
		pool.sort((a, b) => (b.downloads ?? -1) - (a.downloads ?? -1));
	} else if (sort === "stars" || (only && !sort)) {
		await annotateStars(pool);
		pool.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1));
	}
	return {
		results: pool.slice((page - 1) * MARKET_PAGE, page * MARKET_PAGE),
		total: pool.length,
		exhausted: entry.done || pool.length <= need
	};
}

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

	// 内核版本 + 是否有官方更新（内核随安装包内置，更新=发布新版安装包）。
	ipcMain.handle("plugins:kernel-check", async () => {
		const bundled = bundledVersions()["@deepseek-ai/dsh"] ?? null;
		const latest = await fetchLatestKernelVersion();
		if (latest === null) return { ok: false, error: "无法访问 npm 源（国内网络常抖动），可稍后重试", bundled };
		let hasUpdate = false;
		try {
			hasUpdate = typeof bundled === "string" && semver.valid(bundled) !== null && semver.gt(latest.version, bundled);
		} catch {
			hasUpdate = false;
		}
		return { ok: true, bundled, latest: latest.version, source: latest.source, hasUpdate };
	});

	// text "" = 热门（推荐）feed；page 从 1 开始；only=true 只看 dsh；sort=stars|downloads。
	ipcMain.handle("plugins:search", async (_event, text, page = 1, only = false, sort = "") => {
		const query = typeof text === "string" ? text.trim() : "";
		const pageNum = Math.max(1, Number(page) || 1);
		try {
			broadcast({ kind: "phase", text: query === "" ? "加载热门插件…" : `搜索 npm: ${query}` });
			const { results, total, exhausted } = await marketSearch(query, pageNum, Boolean(only), String(sort || ""));
			return { ok: true, results, total, page: pageNum, exhausted };
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

	// 从 GitHub / 本地路径安装：插件市场只搜 npm，没上 npm 的插件（如 dsh-watcher）
	// 搜不到，这里给一个直接安装入口。
	ipcMain.handle("plugins:install-spec", async (_event, spec) => {
		const s = typeof spec === "string" ? spec.trim() : "";
		if (s === "") return { ok: false, error: "请填写 github:owner/repo 或本地文件夹路径" };
		const isGit = /^(github:|git\+https:\/\/|https:\/\/github\.com\/|git@github\.com:)/iu.test(s);
		const isFile = /^file:/iu.test(s) || /^[a-zA-Z]:[\\/]/u.test(s) || s.startsWith("./") || s.startsWith("../") || s.startsWith("\\\\");
		if (!isGit && !isFile) {
			return { ok: false, error: "只支持 github:owner/repo、https://github.com/… 或本地文件夹路径（也可 file:…）" };
		}
		if (isFile && !/^file:/iu.test(s) && !existsSync(s)) return { ok: false, error: `本地路径不存在：${s}` };
		return await runWithEvents(
			async () => ({
				info: await installPlugin(s, {
					dshHome: home(),
					execPath: executorPath,
					onOutput: (line) => broadcast({ kind: "line", text: line })
				})
			}),
			`安装 ${s}…（GitHub 拉取可能较慢；装完需重启内核生效）`
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
