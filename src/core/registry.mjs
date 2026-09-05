/**
 * DSH Studio — npm registry helpers (pure Node, no Electron).
 * Search + latest-manifest lookups used by the plugin market panel.
 */
const REGISTRY = "https://registry.npmjs.org";

/** Query npm uses for the "热门/发现" feed (relevance+popularity sorting). */
export const POPULAR_QUERY = "dsh deepseek harness plugin";

function registryName(name) {
	return name.startsWith("@") ? name.replace("/", "%2f") : name;
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
				score: entry.score?.final ?? 0
			}))
			.filter((item) => item.name !== undefined),
		total: typeof data.total === "number" ? data.total : (data.objects ?? []).length
	};
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
