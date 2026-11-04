import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { consumeContinue, markContinue } from "../../src/ports/continue.port";
import { registerTestSandbox } from "../helpers/test-sandbox-registry";

let file: string;
let tmp: string;
const CWD = "/work/project";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "maint-continue-"));
	registerTestSandbox(tmp);
	file = path.join(tmp, "state", "continue.json");
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("continue marker", () => {
	it("is absent until something marks it", async () => {
		expect(await consumeContinue(file, { cwd: CWD, maxAgeMs: 60_000 })).toBe(false);
	});

	it("is honoured exactly once, so a later session never repeats the update", async () => {
		await markContinue(file, CWD);

		expect(await consumeContinue(file, { cwd: CWD, maxAgeMs: 60_000 })).toBe(true);
		expect(await consumeContinue(file, { cwd: CWD, maxAgeMs: 60_000 })).toBe(false);
	});

	it("is dropped, not honoured, when it is too old to mean 'the restart just happened'", async () => {
		await markContinue(file, CWD, () => 1_000);

		expect(await consumeContinue(file, { cwd: CWD, maxAgeMs: 60_000, now: () => 1_000 + 61_000 })).toBe(false);
		await expect(fs.access(file)).rejects.toThrow();
	});

	it("is left for the session in the directory that wrote it, not taken by another project's window", async () => {
		await markContinue(file, CWD);

		expect(await consumeContinue(file, { cwd: "/work/other", maxAgeMs: 60_000 })).toBe(false);
		// Untouched, so the window it was meant for still finds it.
		expect(await consumeContinue(file, { cwd: CWD, maxAgeMs: 60_000 })).toBe(true);
	});

	it("treats a corrupt marker as absent", async () => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, "{ not json");

		expect(await consumeContinue(file, { cwd: CWD, maxAgeMs: 60_000 })).toBe(false);
	});
});
