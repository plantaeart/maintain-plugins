import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverPlugins } from "../../src/core/plugin-registry";
import { HostPlatform } from "../../src/core/types/host-platform.type";
import { PluginRecord } from "../../src/core/types/plugin-record.type";

/**
 * The two hosts store plugins differently, so discovery is the part most
 * likely to silently return nothing on one host. These fixtures reproduce the
 * real on-disk layouts: omp keeps a private package.json plus a lockfile with
 * a `plugins` map, pi keeps a packages array in settings.json and the installed
 * versions under node_modules.
 */

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maint-plugins-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value, null, 2));
}

/** Lay down an omp plugin dir and return its root. */
async function makeOmpHome(lock: Record<string, { version: string; enabled: boolean }>): Promise<string> {
	const home = path.join(tmp, "omp-home");
	const dir = path.join(home, ".omp", "plugins");
	await writeJson(path.join(dir, "package.json"), {
		name: "omp-plugins",
		private: true,
		dependencies: {
			"@scope/pkg": "npm:@scope/pkg",
			"plain-pkg": "npm:plain-pkg@0.1.3",
		},
	});
	await writeJson(path.join(dir, "omp-plugins.lock.json"), { plugins: lock });
	return home;
}

/** Lay down a pi home and return its root. */
async function makePiHome(versions: Record<string, string>): Promise<string> {
	const home = path.join(tmp, "pi-home");
	const agent = path.join(home, ".pi", "agent");
	await writeJson(path.join(agent, "settings.json"), {
		packages: Object.keys(versions).map((name) => `npm:${name}`),
	});
	await writeJson(path.join(agent, "npm", "package.json"), {
		name: "pi-extensions",
		private: true,
	});
	for (const [name, version] of Object.entries(versions)) {
		await writeJson(path.join(agent, "npm", "node_modules", name, "package.json"), {
			name,
			version,
		});
	}
	return home;
}

describe("discoverPlugins", () => {
	it("reads omp plugins from the lockfile, with the enabled flag", async () => {
		const home = await makeOmpHome({
			"@scope/pkg": { version: "1.2.3", enabled: true },
			"plain-pkg": { version: "0.1.3", enabled: false },
		});

		const records: PluginRecord[] = await discoverPlugins(HostPlatform.Omp, home);

		expect(records).toHaveLength(2);
		const scoped = records.find((r) => r.name === "@scope/pkg");
		expect(scoped?.installed).toBe("1.2.3");
		expect(scoped?.enabled).toBe(true);
		expect(records.find((r) => r.name === "plain-pkg")?.enabled).toBe(false);
		expect(records.every((r) => r.host === HostPlatform.Omp)).toBe(true);
	});

	it("strips the npm: prefix and any pinned version from omp dependency specs", async () => {
		const home = await makeOmpHome({
			"@scope/pkg": { version: "1.2.3", enabled: true },
			"plain-pkg": { version: "0.1.3", enabled: true },
		});

		const records = await discoverPlugins(HostPlatform.Omp, home);

		// A name must never leak the "npm:" scheme or a @version pin, or the
		// registry lookup below would request a package that does not exist.
		expect(records.map((r) => r.name).sort()).toEqual(["@scope/pkg", "plain-pkg"]);
	});

	it("reads pi plugins from settings.json plus the installed node_modules versions", async () => {
		const home = await makePiHome({ "pi-sidebar-tui": "1.7.4", "other-plugin": "0.3.0" });

		const records = await discoverPlugins(HostPlatform.Pi, home);

		expect(records).toHaveLength(2);
		expect(records.find((r) => r.name === "pi-sidebar-tui")?.installed).toBe("1.7.4");
		expect(records.find((r) => r.name === "other-plugin")?.installed).toBe("0.3.0");
		expect(records.every((r) => r.host === HostPlatform.Pi)).toBe(true);
	});

	it("returns an empty list when the host has no plugin dir", async () => {
		const records = await discoverPlugins(HostPlatform.Omp, path.join(tmp, "absent"));

		expect(records).toEqual([]);
	});

	it("returns an empty list when the manifest is missing or unparseable", async () => {
		const home = path.join(tmp, "broken-home");
		const dir = path.join(home, ".omp", "plugins");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(path.join(dir, "omp-plugins.lock.json"), "{ not json");

		expect(await discoverPlugins(HostPlatform.Omp, home)).toEqual([]);
	});

	it("leaves latest undefined until a registry check runs", async () => {
		const home = await makeOmpHome({ "plain-pkg": { version: "0.1.3", enabled: true } });

		const [record] = await discoverPlugins(HostPlatform.Omp, home);

		// undefined is what lets the caller tell "not checked" from "current".
		expect(record.latest).toBeUndefined();
	});

	it("omits a pi package listed in settings but absent from node_modules", async () => {
		const home = await makePiHome({ "pi-sidebar-tui": "1.7.4" });
		// A package can be listed in settings before or after it is installed.
		await writeJson(path.join(home, ".pi", "agent", "settings.json"), {
			packages: ["npm:pi-sidebar-tui", "npm:never-installed"],
		});

		const records = await discoverPlugins(HostPlatform.Pi, home);

		expect(records.map((r) => r.name)).toEqual(["pi-sidebar-tui"]);
	});
});
