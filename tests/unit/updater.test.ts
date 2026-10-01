import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyUpdates, buildUpdatePlan, restoreFromBackup } from "../../src/core/updater";
import { HostPlatform } from "../../src/core/types/host-platform.type";
import type { PluginRecord } from "../../src/core/types/plugin-record.type";

/**
 * Updating rewrites the host's own plugin directory, so these tests use a
 * throwaway copy of that layout. The behaviour that matters most is the
 * failure path: a package manager that exits non-zero must leave the host
 * exactly as it was.
 */

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maint-updater-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

async function makeOmpPluginDir(deps: Record<string, string>): Promise<string> {
	const dir = path.join(tmp, "omp", ".omp", "plugins");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "omp-plugins", private: true, dependencies: deps }, null, 2),
	);
	return dir;
}

async function makePiPluginDir(deps: Record<string, string>): Promise<string> {
	const agent = path.join(tmp, "pi", ".pi", "agent");
	const dir = path.join(agent, "npm");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(agent, "settings.json"),
		JSON.stringify({ packages: Object.keys(deps).map((d) => `npm:${d}`) }, null, 2),
	);
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "pi-extensions", private: true, dependencies: deps }, null, 2),
	);
	return dir;
}

function record(name: string, installed: string, latest: string, host = HostPlatform.Omp): PluginRecord {
	return { name, installed, latest, host, enabled: true };
}

describe("buildUpdatePlan", () => {
	it("lists only the plugins that actually have a newer version", () => {
		const plan = buildUpdatePlan([
			record("stale", "1.0.0", "2.0.0"),
			record("current", "1.0.0", "1.0.0"),
			record("unknown", "1.0.0", undefined as unknown as string),
		]);

		// An unknown latest must never appear as an update: there would be no
		// version to install.
		expect(plan.updates.map((u) => u.name)).toEqual(["stale"]);
	});

	it("excludes a plugin the user disabled, without asking", () => {
		const disabled = { ...record("stale", "1.0.0", "2.0.0"), enabled: false };

		expect(buildUpdatePlan([disabled]).updates).toEqual([]);
		expect(buildUpdatePlan([disabled]).skipped).toHaveLength(1);
	});

	it("reports which host each update targets", () => {
		const plan = buildUpdatePlan([
			record("a", "1.0.0", "2.0.0", HostPlatform.Omp),
			record("b", "1.0.0", "2.0.0", HostPlatform.Pi),
		]);

		expect(plan.byHost.get(HostPlatform.Omp)?.map((u) => u.name)).toEqual(["a"]);
		expect(plan.byHost.get(HostPlatform.Pi)?.map((u) => u.name)).toEqual(["b"]);
	});
});

describe("applyUpdates", () => {
	it("pins the new version in the host manifest before running its package manager", async () => {
		// Real omp manifests use "npm:" prefixed specs, so the fixture does too:
		// the writer matches whatever style it finds.
		const dir = await makeOmpPluginDir({ "keep-me": "npm:keep-me@1.0.0" });
		const seen: string[] = [];

		const result = await applyUpdates(
			[record("stale", "1.0.0", "2.0.0")],
			{
				pluginDirs: new Map([[HostPlatform.Omp, dir]]),
				run: async (cmd) => {
					seen.push(cmd);
					return { code: 0 };
				},
			},
		);

		expect(result.ok).toBe(true);
		const manifest = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
		expect(manifest.dependencies["stale"]).toBe("npm:stale@2.0.0");
		// A plugin that was not stale must be left alone, in the style it had.
		expect(manifest.dependencies["keep-me"]).toBe("npm:keep-me@1.0.0");
		expect(seen.join(" ")).toContain("stale@2.0.0");
	});

	it("uses the host's own installer so the host's own lockfile stays authoritative", async () => {
		const ompDir = await makeOmpPluginDir({});
		const piDir = await makePiPluginDir({});
		const seen: string[] = [];

		await applyUpdates(
			[record("a", "1.0.0", "2.0.0", HostPlatform.Omp), record("b", "1.0.0", "2.0.0", HostPlatform.Pi)],
			{
				pluginDirs: new Map([
					[HostPlatform.Omp, ompDir],
					[HostPlatform.Pi, piDir],
				]),
				run: async (cmd) => {
					seen.push(cmd);
					return { code: 0 };
				},
			},
		);

		// `omp plugin install` and not `bun add`: omp discovers the installed
		// version from omp-plugins.lock.json, which `bun add` never rewrites, so
		// a bun install leaves the next check reporting the version we just
		// replaced as still stale.
		expect(seen.some((c) => c.startsWith("omp plugin install"))).toBe(true);
		expect(seen.some((c) => c.startsWith("npm install"))).toBe(true);
		expect(seen.some((c) => c.startsWith("bun add"))).toBe(false);
	});

	it("installs into the plugin directory rather than the session's working directory", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });
		const cwds: (string | undefined)[] = [];

		await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async (_cmd, options) => {
				cwds.push(options?.cwd);
				return { code: 0 };
			},
		});

		// `omp plugin install` has no --prefix or --cwd, so the only way to aim
		// it at the right manifest is to run it from there.
		expect(cwds).toEqual([dir]);
	});

	it("reports each plugin before installing it, so a long run shows progress", async () => {
		const dir = await makeOmpPluginDir({ "a": "npm:a@1.0.0", "b": "npm:b@1.0.0" });
		const seen: string[] = [];

		await applyUpdates([record("a", "1.0.0", "2.0.0"), record("b", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			onProgress: (update, index, total) => seen.push(`${index}/${total} ${update.name}`),
			run: async () => ({ code: 0 }),
		});

		expect(seen).toEqual(["1/2 a", "2/2 b"]);
	});

	it("keeps reporting the remaining plugins after one fails, so a stalled run is visible", async () => {
		const dir = await makeOmpPluginDir({ "a": "npm:a@1.0.0", "b": "npm:b@1.0.0" });
		const seen: string[] = [];

		// The batch is attempted in full and rolled back afterwards, so every
		// plugin is announced before its install; a failure must not truncate the
		// list and leave the user unsure which one actually stalled.
		await applyUpdates([record("a", "1.0.0", "2.0.0"), record("b", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			onProgress: (update, index, total) => seen.push(`${index}/${total} ${update.name}`),
			run: async (cmd) => (cmd.includes("npm:a@") ? { code: 1 } : { code: 0 }),
		});

		expect(seen).toEqual(["1/2 a", "2/2 b"]);
	});

	it("reports a plugin that installed but will not load as its own kind, not a failed install", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });

		const result = await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async () => ({
				code: 1,
				stderr:
					"src/index.ts: Failed to load extension: pi.registerEntryRenderer is not a function.",
			}),
		});

		expect(result.ok).toBe(false);
		expect(result.failures).toHaveLength(1);
		// The install itself worked; only the host's load of the new code failed,
		// so saying "install failed" sends the user looking at npm for a problem
		// that is not there. The message names the host, because "works on pi" is
		// the explanation and the host is what it is being compared against.
		expect(result.failures[0].kind).toBe("load-failed");
		expect(result.failures[0].name).toBe("stale");
		expect(result.failures[0].host).toBe(HostPlatform.Omp);
		expect(result.errors[0]).toBe(
			"stale: installed, but this host cannot load it on omp.",
		);
	});

	it("reports a non-zero exit with no load failure as a plain install failure", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });

		const result = await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async () => ({ code: 1, stderr: "ENOTFOUND registry.npmjs.org" }),
		});

		expect(result.failures[0].kind).toBe("install-failed");
		expect(result.errors[0]).toContain("install failed on omp");
		expect(result.errors[0]).toContain("ENOTFOUND");
	});

	it("keeps the failure list empty when everything installs", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });

		const result = await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async () => ({ code: 0 }),
		});

		expect(result.ok).toBe(true);
		expect(result.failures).toEqual([]);
	});

	it("restores the manifest and reports the failure when the package manager exits non-zero", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });
		const before = await fs.readFile(path.join(dir, "package.json"), "utf8");

		const result = await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async () => ({ code: 1, stderr: "network down" }),
		});

		expect(result.ok).toBe(false);
		// The host must be left byte-identical after a failed update, or the
		// user has a manifest pinned to a version that was never installed.
		expect(await fs.readFile(path.join(dir, "package.json"), "utf8")).toBe(before);
	});

	it("keeps a backup the user can restore from by hand", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });

		const result = await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async () => ({ code: 0 }),
		});

		expect(result.backups.length).toBeGreaterThan(0);
		for (const backup of result.backups) {
			// The copy, not backup.file - that path is the live manifest, which
			// now holds the new version.
			expect(await fs.readFile(backup.backupFile, "utf8")).toContain("stale@1.0.0");
		}
	});

	it("does nothing at all when there is no update to apply", async () => {
		let ran = false;

		const result = await applyUpdates([record("current", "1.0.0", "1.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, path.join(tmp, "omp", ".omp", "plugins")]]),
			run: async () => {
				ran = true;
				return { code: 0 };
			},
		});

		expect(ran).toBe(false);
		expect(result.ok).toBe(true);
	});
});

describe("restoreFromBackup", () => {
	it("puts the original manifest back", async () => {
		const dir = await makeOmpPluginDir({ "stale": "npm:stale@1.0.0" });
		const original = await fs.readFile(path.join(dir, "package.json"), "utf8");

		const result = await applyUpdates([record("stale", "1.0.0", "2.0.0")], {
			pluginDirs: new Map([[HostPlatform.Omp, dir]]),
			run: async () => ({ code: 0 }),
		});
		expect(await fs.readFile(path.join(dir, "package.json"), "utf8")).not.toBe(original);

		await restoreFromBackup(result.backups);

		expect(await fs.readFile(path.join(dir, "package.json"), "utf8")).toBe(original);
	});
});
