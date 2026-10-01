import { describe, expect, it } from "bun:test";
import { detectHost } from "../../src/core/paths";
import { HostPlatform } from "../../src/core/types/host-platform.type";

/**
 * Host detection was originally driven by `OMPCODE`. It is not a host signal:
 * a real pi session on this machine runs with `OMPCODE=1` set, so every pi
 * session was detected as omp and read the wrong plugin directory. These
 * fixtures use the argv values observed from the two real binaries.
 */

const PI_ARGV = [
	"/home/plantae/.nvm/versions/node/v24.15.0/bin/node",
	"/home/plantae/.pi/agent/install/releases/0.99.1/node_modules/.bin/pi",
	"--mode",
	"rpc",
];

const OMP_ARGV = [
	"/home/plantae/.nvm/versions/node/v24.15.0/bin/node",
	"/home/plantae/.omp/agent/install/releases/18.4.5/node_modules/.bin/omp",
];

describe("detectHost", () => {
	it("detects pi from the binary path", () => {
		expect(detectHost({}, PI_ARGV)).toBe(HostPlatform.Pi);
	});

	it("detects omp from the binary path", () => {
		expect(detectHost({}, OMP_ARGV)).toBe(HostPlatform.Omp);
	});

	it("does not read pi as omp just because pi sets OMPCODE", () => {
		// The regression this whole file exists for: pi runs with OMPCODE=1,
		// which the first implementation treated as proof it was omp.
		expect(detectHost({ OMPCODE: "1" }, PI_ARGV)).toBe(HostPlatform.Pi);
	});

	it("does not read omp as pi just because oh-my-pi contains pi", () => {
		// "oh-my-pi" contains "pi" as a substring, so pi must not be tested
		// first or every omp session would be classified as pi.
		expect(detectHost({}, ["/opt/oh-my-pi/bin/omp"])).toBe(HostPlatform.Omp);
	});

	it("prefers the binary over the environment", () => {
		// A stale OMPCODE or an unrelated PI_HOME in the environment must not
		// override what the process actually is.
		expect(detectHost({ OMPCODE: "0", PI_HOME: "/somewhere" }, OMP_ARGV)).toBe(HostPlatform.Omp);
		expect(detectHost({ OMPCODE: "1" }, PI_ARGV)).toBe(HostPlatform.Pi);
	});

	it("falls back to pi when nothing identifies the binary", () => {
		expect(detectHost({}, ["/usr/bin/node", "/tmp/script.js"])).toBe(HostPlatform.Pi);
	});
});
