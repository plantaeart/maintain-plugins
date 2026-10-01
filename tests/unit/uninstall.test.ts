import { describe, expect, it } from "bun:test";
import { buildUninstallCommand } from "../../src/core/uninstall";
import { HostPlatform } from "../../src/core/types/host-platform.type";

/**
 * The two hosts take different arguments for the same operation, verified
 * against both CLIs in sandboxes: omp wants a bare package name and rejects an
 * `npm:` spec, pi wants the spec and removes it from settings.json. Building the
 * wrong one fails with "not installed", which reads like the plugin is missing.
 */
describe("buildUninstallCommand", () => {
	it("gives omp a bare name, which is the form omp plugin uninstall accepts", () => {
		// Unquoted: a scoped name has no shell metacharacters, and quoting every
		// argument makes the command harder to read in the confirmation.
		expect(buildUninstallCommand(HostPlatform.Omp, "@tintinweb/pi-subagents")).toBe(
			"omp plugin uninstall @tintinweb/pi-subagents",
		);
	});

	it("gives pi the npm: spec, which is the form pi remove accepts", () => {
		expect(buildUninstallCommand(HostPlatform.Pi, "system-prompt-switch")).toBe(
			"pi remove npm:system-prompt-switch",
		);
	});

	it("keeps a scoped pi package fully qualified", () => {
		expect(buildUninstallCommand(HostPlatform.Pi, "@tintinweb/pi-subagents")).toBe(
			"pi remove npm:@tintinweb/pi-subagents",
		);
	});
});
