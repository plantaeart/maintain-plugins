import { describe, expect, it } from "bun:test";
import { reloadPending } from "../../src/core/self";
import { SELF_NAME } from "../../src/core/updater";
import { HostPlatform } from "../../src/core/types/host-platform.type";
import type { PluginRecord } from "../../src/core/types/plugin-record.type";

function record(name: string, installed: string): PluginRecord {
	return { name, installed, host: HostPlatform.Omp, enabled: true };
}

describe("reloadPending", () => {
	it("returns the installed version when the running copy is older than the one on disk", () => {
		expect(reloadPending([record(SELF_NAME, "0.5.0")], "0.4.1")).toBe("0.5.0");
	});

	it("is quiet when the running copy is the installed one", () => {
		expect(reloadPending([record(SELF_NAME, "0.5.0")], "0.5.0")).toBeUndefined();
	});

	it("is quiet when this plugin is not installed, as in a dev checkout loaded with -e", () => {
		expect(reloadPending([record("other", "9.9.9")], "0.4.1")).toBeUndefined();
	});
});
