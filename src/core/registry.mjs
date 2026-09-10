/**
 * DSH Studio — npm registry helpers (pure Node, no Electron).
 * Search + latest-manifest lookups used by the plugin market panel.
 */
const REGISTRY = "https://registry.npmjs.org";
const GH_API = "https://api.github.com/repos";

/** Query npm uses for the "热门/发现" feed (relevance+popularity sorting). */
export const POPULAR_QUERY = "dsh deepseek harness plugin";

function registryName(name) {
	return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

/** Extract { owner, repo } from a GitHub repository URL, or null. */
function githubRepoOf(value) {
	if (typeof value !== "string") return null;
	const clean = value.replace(/^git\+/u, "").replace(/^git@([^:]+):/u, "https://$1/").replace(/\.git$/u, "");
	const m = /github\.com\/([^/\s]+)\/([^/\s/]+)/u.exec(clean);
	return m ? { owner: m[1], repo: m[2].replace(/\/$/u, "") } : null;
}

// 会话内缓存：repo → stars（含 null=获取失败，避免反复请求撞 GitHub API 限流）。
const starCache = new Map();

import { get as httpsGet } from "node:https";

/** Minimal https GET → parsed JSON. TLS 校验失败时退回忽略证书（仅用于公开星数这类可选信息）。 */
function httpsJson(url) {
	return new Promise((resolve, reject) => {
		const done = (err, value) => (err ? reject(err) : resolve(value));
		const req = httpsGet(url, { headers: { "user-agent": "dsh-studio-plugin-market", accept: "application/vnd.github+json" }, rejectUnauthorized: false }, (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				done(new Error(`HTTP ${res.statusCode}`));
				return;
			}
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (body += c));
			res.on("end", () => {
				try { done(null, JSON.parse(body)); } catch (error) { done(error); }
			});
		});
		req.on("error", done);
		req.setTimeout(8000, () => req.destroy(new Error("timeout")));
	});
}

/** GitHub 星数；失败/网络问题返回 null（不阻塞列表）。 */
export async function fetchGithubStars(repository) {
	const gh = githubRepoOf(repository);
	if (gh === null) return null;
	const key = `${gh.owner}/${gh.repo}`;
	if (starCache.has(key)) return starCache.get(key);
	try {
		const body = await httpsJson(`${GH_API}/${gh.owner}/${gh.repo}`);
		const stars = typeof body.stargazers_count === "number" ? body.stargazers_count : null;
		starCache.set(key, stars);
		return stars;
	} catch {
		starCache.set(key, null);
		return null;
	}
}

/** Annotate a result list with `stars` where a GitHub repo is available. */
export async function annotateStars(results) {
	const list = Array.isArray(results) ? results : [];
	for (const item of list) {
		if (typeof item?.repository === "string") item.stars = await fetchGithubStars(item.repository);
	}
	return list;
}

// npm 月下载量缓存（会话内），避免反复请求。
const downloadCache = new Map();

/** npm 近 30 天下载量；失败返回 null（不阻塞列表）。 */
export async function fetchDownloads(name) {
	if (typeof name !== "string" || name === "") return null;
	const key = name;
	if (downloadCache.has(key)) return downloadCache.get(key);
	try {
		const url = `https://api.npmjs.org/downloads/point/last-month/${registryName(name)}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 6000);
		const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "dsh-studio-plugin-market" }, signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const body = await res.json();
		const value = typeof body.downloads === "number" ? body.downloads : null;
		downloadCache.set(key, value);
		return value;
	} catch {
		downloadCache.set(key, null);
		return null;
	}
}

/** Annotate a result list with `downloads`（npm 近 30 天）. */
export async function annotateDownloads(results) {
	const list = Array.isArray(results) ? results : [];
	for (const item of list) {
		if (typeof item?.name === "string") item.downloads = await fetchDownloads(item.name);
	}
	return list;
}

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`registry ${res.status} for ${url}`);
	return await res.json();
}

/**
 * npm search with paging. Returns { results, total }.
 * text  : query (may be "" for the popular feed query).
 * size  : items per page (npm cap 250).
 * from  : zero-based offset.
 */
export async function searchNpm(text, size = 12, from = 0) {
	const query = encodeURIComponent(text === "" ? POPULAR_QUERY : text);
	const data = await getJson(`${REGISTRY}/-/v1/search?text=${query}&size=${String(size)}&from=${String(from)}`);
	return {
		results: (data.objects ?? [])
			.map((entry) => ({
				name: entry.package?.name,
				version: entry.package?.version,
				description: entry.package?.description ?? "",
				date: entry.package?.date,
				score: entry.score?.final ?? 0,
				repository: (entry.package?.links && githubRepoOf(entry.package.links.repository)) ? entry.package.links.repository : null
			}))
			.filter((item) => item.name !== undefined),
		total: typeof data.total === "number" ? data.total : (data.objects ?? []).length
	};
}

/** 官方最新 @deepseek-ai/dsh 版本（官方源优先，失败换国内镜像）；取不到返回 null。 */
export async function fetchLatestKernelVersion() {
	for (const base of [REGISTRY, "https://registry.npmmirror.com"]) {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 10000);
			const res = await fetch(`${base}/@deepseek-ai/dsh/latest`, { headers: { accept: "application/json" }, signal: controller.signal });
			clearTimeout(timer);
			if (!res.ok) continue;
			const body = await res.json();
			if (typeof body?.version === "string" && body.version !== "") return { version: body.version, source: base };
		} catch {
			/* 试下一个源 */
		}
	}
	return null;
}

/** Latest manifest of one package: description, license, dsh.bundle, peers, links. */
export async function describePackage(name) {
	const data = await getJson(`${REGISTRY}/${registryName(name)}/latest`);
	const repo = data.repository?.url ?? data.repository ?? null;
	return {
		name,
		version: data.version,
		description: data.description ?? "",
		license: data.license,
		type: data.type,
		homepage: data.homepage ?? null,
		repository: typeof repo === "string" ? repo.replace(/^git\+/, "").replace(/\.git$/, "") : null,
		keywords: Array.isArray(data.keywords) ? data.keywords.slice(0, 8) : [],
		dshBundle: data.dsh?.bundle !== undefined,
		bundlePatch: data.dsh?.bundle?.patch ?? null,
		engines: data.engines ?? null,
		peerDependencies: data.peerDependencies ?? {}
	};
}

/** Annotate search results with the dsh.bundle flag (latest manifest each). */
export async function annotateWithBundle(results) {
	const out = new Array(results.length);
	const worker = async (index) => {
		const item = results[index];
		try {
			const meta = await describePackage(item.name);
			out[index] = { ...item, dshBundle: meta.dshBundle, bundlePatch: meta.bundlePatch, license: meta.license };
		} catch {
			out[index] = { ...item, dshBundle: false, license: null };
		}
	};
	// Fetch in small concurrent batches to stay fast even on flaky networks.
	const jobs = [...results.keys()];
	const CONCURRENCY = 5;
	while (jobs.length > 0) {
		await Promise.all(jobs.splice(0, CONCURRENCY).map(worker));
	}
	return out;
}
