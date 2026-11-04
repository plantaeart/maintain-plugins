// Runs the real discovery + registry check + applyUpdates against $HOME.
// Launched by upgrade-repro.sh with HOME pointing at the throwaway sandbox.
import { discoverPlugins } from "../../../../src/core/plugin-registry";
import { cachePathFor, pluginDirFor } from "../../../../src/core/paths";
import { applyUpdates } from "../../../../src/core/updater";
import { DEFAULT_TTL_MS, checkVersions } from "../../../../src/core/version-check";
import { lookupNpmVersion } from "../../../../src/ports/registry.port";
import { HostPlatform } from "../../../../src/core/types/host-platform.type";
import { isUpdateAvailable } from "../../../../src/core/types/plugin-record.type";

const host = (process.env.REPRO_HOST as HostPlatform | undefined) ?? HostPlatform.Omp;
const dir = pluginDirFor(host);

const discovered = await discoverPlugins(host);
const checked = await checkVersions(discovered, {
	lookup: lookupNpmVersion,
	cacheFile: cachePathFor(host),
	ttlMs: -1,
});

for (const r of checked) {
	console.log(`before  ${r.name} ${r.installed} -> latest ${r.latest ?? "?"}${isUpdateAvailable(r) ? "  (stale)" : ""}`);
}

const result = await applyUpdates(checked, {
	pluginDirs: new Map([[host, dir]]),
	onProgress: (u, i, n) => console.log(`install ${i}/${n} ${u.name}@${u.latest}`),
});

if (!result.ok) {
	console.log("RESULT  FAILED");
	for (const e of result.errors) console.log(`  ${e}`);
	for (const f of result.failures) console.log(`  [${f.kind}] ${f.name}: ${f.detail}`);
	process.exit(1);
}

const after = await discoverPlugins(host);
for (const r of after) console.log(`after   ${r.name} ${r.installed}`);
const stale = checked.filter(isUpdateAvailable).filter((c) => {
	const now = after.find((a) => a.name === c.name);
	return now?.installed !== c.latest;
});
if (stale.length > 0) {
	console.log(`RESULT  NOT UPGRADED: ${stale.map((s) => s.name).join(", ")}`);
	process.exit(2);
}
console.log(`RESULT  OK (${result.applied.length} upgraded)`);
