import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { checkVersions } from "../../src/core/version-check";
import { HostPlatform } from "../../src/core/types/host-platform.type";
import type { PluginRecord } from "../../src/core/types/plugin-record.type";
import { compareVersions, isUpdateAvailable } from "../../src/core/types/plugin-record.type";

/**
 * A registry lookup is a network call per plugin, so these tests drive a fake
 * rather than npm. What matters is that a stale plugin is flagged, a current
 * one is not, and a lookup that fails does not take the whole check down.
 */

let tmp: string;

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maint-check-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

function record(name: string, installed: string): PluginRecord {
	return { name, installed, host: HostPlatform.Omp, enabled: true };
}

describe("checkVersions", () => {
	it("fills in latest and flags only the genuinely stale plugins", async () => {
		const latest: Record<string, string> = { stale: "2.0.0", current: "1.0.0" };

		const { records: result } = await checkVersions([record("stale", "1.0.0"), record("current", "1.0.0")], {
			lookup: async (name) => latest[name],
		});

		expect(result.find((r) => r.name === "stale")?.latest).toBe("2.0.0");
		expect(isUpdateAvailable(result.find((r) => r.name === "stale")!)).toBe(true);
		expect(result.find((r) => r.name === "current")?.latest).toBe("1.0.0");
		expect(isUpdateAvailable(result.find((r) => r.name === "current")!)).toBe(false);
	});

	it("leaves latest undefined when the lookup fails, so no update is offered", async () => {
		const { records: result } = await checkVersions([record("offline", "1.0.0")], {
			lookup: async () => {
				throw new Error("registry unreachable");
			},
		});

		// An unknown latest must never read as "update available": that would
		// invite an update with no version to install.
		expect(result[0].latest).toBeUndefined();
		expect(isUpdateAvailable(result[0])).toBe(false);
	});

	it("leaves latest undefined when the package is not on the registry", async () => {
		const { records: result } = await checkVersions([record("gone", "1.0.0")], {
			lookup: async () => undefined,
		});

		expect(result[0].latest).toBeUndefined();
	});

	it("leaves latest undefined when the lookup returns something that is not a version", async () => {
		const { records: result } = await checkVersions([record("weird", "1.0.0")], {
			lookup: async () => "" as string,
		});

		expect(result[0].latest).toBeUndefined();
	});

	it("does not throw when there are no plugins", async () => {
		expect((await checkVersions([], { lookup: async () => "1.0.0" })).records).toEqual([]);
	});
});

describe("check cache", () => {
	const stale = () => [record("stale", "1.0.0")];

	it("asks the registry every time, so a release published since the last check shows up", async () => {
		const cacheFile = path.join(tmp, "check.json");
		await checkVersions(stale(), { lookup: async () => "2.0.0", cacheFile });

		const second = await checkVersions(stale(), { lookup: async () => "3.0.0", cacheFile });

		expect(second.records[0].latest).toBe("3.0.0");
		expect(second.live).toBe(true);
	});

	it("writes what it found, so the next unreachable check can fall back to it", async () => {
		const cacheFile = path.join(tmp, "check.json");
		await checkVersions(stale(), { lookup: async () => "2.0.0", cacheFile });
		await checkVersions(stale(), { lookup: async () => "3.0.0", cacheFile });

		// An offline machine must still get a stale notice from the last known
		// state rather than silently reporting nothing.
		const offline = await checkVersions(stale(), {
			lookup: async () => {
				throw new Error("offline");
			},
			cacheFile,
		});

		expect(offline.records[0].latest).toBe("3.0.0");
	});

	it("says the answer is cached, and how old it is, when the registry is unreachable", async () => {
		const cacheFile = path.join(tmp, "check.json");
		await checkVersions(stale(), { lookup: async () => "2.0.0", cacheFile, now: () => 1_000 });

		const offline = await checkVersions(stale(), {
			lookup: async () => {
				throw new Error("offline");
			},
			cacheFile,
			now: () => 9_000,
		});

		expect(offline.live).toBe(false);
		// The age of what is being shown, not of the failed attempt, and a total
		// outage does not reset the clock.
		expect(offline.checkedAt).toBe(1_000);
	});

	it("is not live when only some plugins answered", async () => {
		const { live } = await checkVersions([record("up", "1.0.0"), record("down", "1.0.0")], {
			lookup: async (name) => {
				if (name === "down") throw new Error("offline");
				return "2.0.0";
			},
		});
		expect(live).toBe(false);
	});

	it("ignores a corrupt cache file rather than failing the check", async () => {
		const cacheFile = path.join(tmp, "check.json");
		await fs.writeFile(cacheFile, "{ not json");

		const { records: result } = await checkVersions(stale(), {
			lookup: async () => "2.0.0",
			cacheFile,
		});

		expect(result[0].latest).toBe("2.0.0");
	});
});

describe("compareVersions", () => {
	it("orders numerically, so 0.9.10 is above 0.9.9", () => {
		// String comparison gets this wrong, and a plugin using zero-padded
		// patch numbers would then never be offered an update.
		expect(compareVersions("0.9.9", "0.9.10")).toBe(-1);
		expect(compareVersions("0.9.10", "0.9.9")).toBe(1);
	});

	it("treats equal versions as equal and missing fields as zero", () => {
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
		expect(compareVersions("1.2", "1.2.0")).toBe(0);
		expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
	});

	it("ignores a pre-release suffix rather than misreading it as newer", () => {
		expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(0);
	});
});
