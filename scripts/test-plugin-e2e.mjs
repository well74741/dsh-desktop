/**
 * DSH Studio plugin-market E2E (dev only):
 *   install a local test bundle into an isolated DSH_HOME profile,
 *   boot the core and assert the bundle plugin activates,
 *   uninstall and assert it is gone.
 * Usage: node ./scripts/test-plugin-e2e.mjs
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installPlugin, listPlugins, uninstallPlugin } from "../src/core/pluginctl.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Outside the project tree on purpose: pnpm profile operations behave like a
// real ~/.dsh (no enclosing npm project to confuse project-root detection).
const HOME = fileURLToPath(new URL("../../dsh-e2e-home/", import.meta.url));
const TEST_BUNDLE = join(ROOT, "plugins", "test-bundle");
const BUNDLE_NAME = "@dsh-studio/test-bundle";

let failures = 0;
function check(label, ok, extra = "") {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures += 1;
}

async function bootOnce(label) {
	return await new Promise((resolve2) => {
		const child = spawn(process.execPath, [join("src", "core", "run.mjs"), "--smoke"], {
			cwd: ROOT,
			env: { ...process.env, DSH_HOME: HOME },
			stdio: ["ignore", "pipe", "pipe"]
		});
		let out = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c) => (out += c));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (c) => (out += c));
		child.on("exit", (code) => {
			console.log(`--- boot (${label}) exit ${code} ---`);
			resolve2({ code, out });
		});
	});
}

console.log(`E2E home: ${HOME}`);
console.log(`bundle: ${TEST_BUNDLE}`);

// 1) fresh install
await installPlugin(`file:${TEST_BUNDLE.replaceAll("\\", "/")}`, {
	dshHome: HOME,
	onOutput: (line) => console.log(`   pnpm> ${line}`)
});
const afterInstall = listPlugins(HOME);
check(
	"dependency recorded",
	afterInstall.dependencies[BUNDLE_NAME] !== undefined,
	JSON.stringify(afterInstall.dependencies)
);
check(
	"added to bundles layer",
	afterInstall.bundles.includes(BUNDLE_NAME),
	`bundles=${JSON.stringify(afterInstall.bundles)}`
);

// 2) core boot activates the bundle plugin
const boot1 = await bootOnce("after install");
check("core boots after install", boot1.code === 0, `exit=${String(boot1.code)}`);
check("bundle plugin activated in core", boot1.out.includes("[test-bundle] active"), boot1.out.split("\n").find((l) => l.includes("test-bundle")) ?? "no marker");

// 3) uninstall
await uninstallPlugin(BUNDLE_NAME, { dshHome: HOME });
const afterRemove = listPlugins(HOME);
check("dependency removed", afterRemove.dependencies[BUNDLE_NAME] === undefined);
check("removed from bundles layer", !afterRemove.bundles.includes(BUNDLE_NAME), `bundles=${JSON.stringify(afterRemove.bundles)}`);

// 4) boot again — clean
const boot2 = await bootOnce("after uninstall");
check("core boots after uninstall", boot2.code === 0, `exit=${String(boot2.code)}`);
check("bundle plugin no longer active", !boot2.out.includes("[test-bundle] active"));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
