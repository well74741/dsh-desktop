/**
 * DSH Studio — Harness core entry.
 *
 * Boots the OFFICIAL `dsh web` profile (profile "web" = @deepseek-ai/dsh-base +
 * @deepseek-ai/dsh-web-app bundles) exactly like the dsh CLI does, so the
 * desktop UI is byte-for-byte the same kernel + frontend dist as `dsh web`.
 *
 * Process model:
 *   - In dev/smoke this file runs under plain Node (`node src/core/run.mjs`).
 *   - Inside the desktop app it is spawned by Electron's main process using
 *     the SAME executable (process.execPath = electron.exe) with
 *     ELECTRON_RUN_AS_NODE=1, i.e. the Electron binary acts as a plain Node
 *     runtime. This keeps every Node-native assumption of the harness intact
 *     (worker_threads, spawn(process.execPath, ...), koffi FFI, ESM), which
 *     would break if the harness ran inside the Electron main process.
 *
 * Sync with the web version is by construction:
 *   - same kernel entry (runProfile over the pinned @deepseek-ai/dsh),
 *   - same frontend dist served by the kernel itself,
 *   - same DSH_HOME (defaults to the standard CLI home, so sessions,
 *     settings, credentials and installed plugins are shared on disk).
 *
 * Protocol with the Electron main process (stdout/stderr/stdin):
 *   - stdout line  "DSH_STUDIO_READY <json>" once the web server is listening
 *     (json: { url, port, dshHome }).
 *   - stderr/stdout prefixed log lines are passed through by the shell.
 *   - stdin line  "shutdown" requests a graceful tree dispose + process exit.
 *   - SIGTERM/SIGINT are handled by the dsh boot machinery itself.
 */
import { createInterface } from "node:readline";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Core-only flags consumed here, never forwarded to the web app's own parser. */
const CORE_ONLY_FLAGS = new Set(["--smoke"]);

const FLAGS = Object.freeze({
	/** Boot, print the ready line, then shut down and exit (used by smoke tests). */
	smoke: process.argv.includes("--smoke"),
	/** Extra inner args forwarded to the web app (defaults mirror `dsh web`). */
	webArgs: process.argv
		.slice(2)
		.filter((arg) => !arg.startsWith("--dsh-studio-") && !CORE_ONLY_FLAGS.has(arg))
});

/** Port 0 = OS-assigned port; --no-open keeps the browser handoff off (the shell owns the window). */
const DEFAULT_WEB_ARGS = ["--port", "0", "--no-open"];

/**
 * The published dsh CLI ships its profile boot under hashed filenames
 * (lib/profile-boot-*.js). Locate whichever exports `runProfile` (the wrapper
 * re-export, or the hashed core's `o`) so core upgrades do not require
 * changing this file.
 */
async function resolveRunProfile() {
	const packageUrl = import.meta.resolve("@deepseek-ai/dsh/package.json");
	const packageDir = dirname(fileURLToPath(packageUrl));
	const libDir = join(packageDir, "lib");
	for (const file of await readdir(libDir)) {
		if (!/^profile-boot-[A-Za-z0-9_-]+\.js$/.test(file)) continue;
		const namespace = await import(pathToFileURL(join(libDir, file)).href);
		const runProfile = namespace.runProfile ?? namespace.o;
		if (typeof runProfile === "function") return runProfile;
	}
	throw new Error("dsh-studio: cannot locate the dsh profile-boot entry under @deepseek-ai/dsh/lib");
}

function log(message) {
	process.stdout.write(`[dsh-studio:core] ${message}\n`);
}

async function waitForPort(ctx, timeoutMs = 15000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const port = ctx.get("webServer")?.port;
		if (typeof port === "number") return port;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("dsh-studio: web server did not report a port in time");
}

async function main() {
	// The official resolver: honors $DSH_HOME, otherwise the CLI's default home.
	// Desktop and `dsh web` therefore share sessions/settings/plugins on disk.
	const dshHome = resolveDshHome();
	if (process.env.DSH_HOME === undefined) process.env.DSH_HOME = dshHome;

	const webArgs =
		FLAGS.webArgs.length > 0
			? [...DEFAULT_WEB_ARGS, ...FLAGS.webArgs]
			: DEFAULT_WEB_ARGS;

	log(`boot profile "web" (DSH_HOME=${dshHome})`);
	const { loadLayeredEnv } = await import("@deepseek-ai/dsh-app-boot");

	const environment = loadLayeredEnv("dsh");
	const runProfileFn = await resolveRunProfile();

	const { ctx, shutdown } = await runProfileFn({
		environment,
		profile: "web",
		patchFiles: [],
		args: webArgs
	});

	const port = await waitForPort(ctx);
	const webUrl = `http://127.0.0.1:${String(port)}`;
	// Mirror the CLI's browser handoff: prefer the connection-authenticated URL
	// (carries the session token) so the window opens straight into the session.
	let url = webUrl;
	try {
		const connection = ctx.get("connection");
		if (typeof connection?.authenticatedUrl === "function") url = connection.authenticatedUrl(webUrl);
	} catch {
		/* keep the plain loopback URL */
	}
	log(`ready: ${url}`);

	const payload = JSON.stringify({ url, port, dshHome });
	process.stdout.write(`DSH_STUDIO_READY ${payload}\n`);

	if (FLAGS.smoke) {
		log("smoke: shutting down");
		await shutdown.shutdown(0);
		process.exit(0);
		return;
	}

	await new Promise((resolve) => {
		const lines = createInterface({ input: process.stdin, terminal: false });
		lines.on("line", (line) => {
			if (line.trim() === "shutdown") {
				log("shutdown requested via stdin");
				lines.close();
				resolve();
			}
		});
		process.stdin.on("end", () => resolve());
	});

	log("disposing harness tree");
	await shutdown.shutdown(0);
	process.exit(0);
}

main().catch((error) => {
	console.error(`[dsh-studio:core] fatal: ${error instanceof Error ? error.stack : String(error)}`);
	process.exit(1);
});
