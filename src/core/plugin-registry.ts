import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HostPlatform } from "./types/host-platform.type";
import type {
	InstalledPackageManifest,
	OmpPluginLock,
	OmpPluginManifest,
	PiSettings,
} from "./types/host-manifest.type";
import type { PluginRecord } from "./types/plugin-record.type";

/**
 * Read the installed plugins of a host.
 *
 * Discovery reads the host's own manifests rather than shelling out to
 * `omp plugin list` or `pi list`. Those outputs differ per host, pi's has no
 * JSON mode at all, and a CLI flag change would break discovery silently. A
 * missing or unreadable manifest yields an empty list, never a throw: this runs
 * on session start, where an exception would take the session down.
 */

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** `"npm:pkg@1.2.3"` -> `"pkg"`. Handles scoped names and the bare `"npm:pkg"` form. */
function normalizeName(spec: string): string {
	return spec
		.trim()
		.replace(/^npm:/, "")
		.replace(/@[0-9][^@/]*$/, "");
}

/** Where a host keeps its plugin directory, relative to the home directory. */
function pluginDirFor(host: HostPlatform): string {
	return host === HostPlatform.Omp
		? path.join(".omp", "plugins")
		: path.join(".pi", "agent", "npm");
}

async function discoverOmp(home: string): Promise<PluginRecord[]> {
	const dir = path.join(home, pluginDirFor(HostPlatform.Omp));
	const lock = (await readJson(path.join(dir, "omp-plugins.lock.json"))) as
		| OmpPluginLock
		| undefined;
	const manifest = (await readJson(path.join(dir, "package.json"))) as
		| OmpPluginManifest
		| undefined;

	const records: PluginRecord[] = [];
	for (const [name, value] of Object.entries(lock?.plugins ?? {})) {
		// Only a string version is usable; a lock entry without one has not
		// resolved to a real install, so there is nothing to compare or update.
		if (typeof value?.version !== "string") continue;

		records.push({
			name,
			installed: value.version,
			host: HostPlatform.Omp,
			enabled: value.enabled !== false,
		});
	}

	// A manifest dependency with no lockfile entry is a known edge: the host has
	// it requested but never resolved. Report it so the gap is visible instead
	// of surfacing later during an update.
	const known = new Set(records.map((r) => r.name));
	for (const spec of Object.keys(manifest?.dependencies ?? {})) {
		const name = normalizeName(spec);
		if (name && !known.has(name)) {
			records.push({ name, installed: "0.0.0", host: HostPlatform.Omp, enabled: true });
		}
	}

	return records;
}

async function discoverPi(home: string): Promise<PluginRecord[]> {
	const agent = path.join(home, ".pi", "agent");
	const settings = (await readJson(path.join(agent, "settings.json"))) as
		| PiSettings
		| undefined;

	const records: PluginRecord[] = [];
	for (const spec of settings?.packages ?? []) {
		if (typeof spec !== "string") continue;
		const name = normalizeName(spec);
		if (!name) continue;

		// The installed version lives in the package's own manifest; a name
		// listed in settings with nothing in node_modules is not installed.
		const pkg = (await readJson(
			path.join(agent, "npm", "node_modules", ...name.split("/"), "package.json"),
		)) as InstalledPackageManifest | undefined;
		if (typeof pkg?.version !== "string") continue;

		records.push({ name, installed: pkg.version, host: HostPlatform.Pi, enabled: true });
	}

	return records;
}

export async function discoverPlugins(
	host: HostPlatform,
	home: string = process.env.HOME ?? process.env.USERPROFILE ?? "",
): Promise<PluginRecord[]> {
	if (!home) return [];
	return host === HostPlatform.Omp ? discoverOmp(home) : discoverPi(home);
}
