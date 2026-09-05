/**
 * DSH Studio — npm registry helpers (pure Node, no Electron).
 * Search + latest-manifest lookups used by the plugin market panel.
 */
const REGISTRY = "https://registry.npmjs.org";

function registryName(name) {
	return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: "application/json" } });
	if (!res.ok) throw new Error(`registry ${res.status} for ${url}`);
	return await res.json();
}

/** npm search, mapped to a small result shape. */
export async function searchNpm(text, size = 20) {
	const query = encodeURIComponent(text);
	const data = await getJson(`${REGISTRY}/-/v1/search?text=${query}&size=${String(size)}`);
	return (data.objects ?? []).map((entry) => ({
		name: entry.package?.name,
		version: entry.package?.version,
		description: entry.package?.description ?? "",
		date: entry.package?.date,
		score: entry.score?.final ?? 0
	})).filter((item) => item.name !== undefined);
}

/** Latest manifest of one package: description, license, dsh.bundle, peers. */
export async function describePackage(name) {
	const data = await getJson(`${REGISTRY}/${registryName(name)}/latest`);
	return {
		name,
		version: data.version,
		description: data.description ?? "",
		license: data.license,
		type: data.type,
		dshBundle: data.dsh?.bundle !== undefined,
		bundlePatch: data.dsh?.bundle?.patch ?? null,
		engines: data.engines ?? null,
		peerDependencies: data.peerDependencies ?? {}
	};
}

/** Annotate search results with the dsh.bundle flag (latest manifest each). */
export async function annotateWithBundle(results) {
	const out = [];
	for (const item of results) {
		try {
			const meta = await describePackage(item.name);
			out.push({ ...item, dshBundle: meta.dshBundle, bundlePatch: meta.bundlePatch, license: meta.license });
		} catch {
			out.push({ ...item, dshBundle: false, license: null });
		}
	}
	return out;
}
