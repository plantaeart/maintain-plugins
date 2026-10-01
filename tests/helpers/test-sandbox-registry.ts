import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Central registry of the sandbox directories a test creates.
 *
 * A test calls `registerTestSandbox()` for each one it builds;
 * `tests/helpers/global-setup.ts` (loaded via bunfig preload) then removes the
 * whole registry on exit — pass or fail — so a killed run cannot leave a
 * throwaway HOME full of host binaries behind.
 *
 * ponytail: no prompt-file enum like the sibling repo. This extension writes no
 * user content; the only thing a test creates is a sandbox directory, and a
 * name prefix under os.tmpdir() identifies those unambiguously.
 */

/** Temp dirs matching this belong to a test run and are safe to delete. */
const SANDBOX_PREFIX = "maint-e2e-";

const registry = new Set<string>();

/** Record a sandbox directory a test created, so it gets cleaned up afterwards. */
export function registerTestSandbox(dir: string): void {
	registry.add(dir);
}

/** Remove every registered sandbox. Safe to call when nothing is registered. */
export function cleanupTestSandboxes(): string[] {
	const removed: string[] = [];
	for (const dir of registry) {
		if (remove(dir)) removed.push(dir);
	}
	registry.clear();
	return removed;
}

/**
 * Sweep leftovers from an earlier crashed or killed run.
 *
 * Only the temp dirs are swept unconditionally: they live under os.tmpdir(),
 * are named by a prefix no real directory uses, and holding a locked one open
 * is the only cost of trying.
 */
export function sweepStaleSandboxes(tmp = os_tmpdir()): string[] {
	if (!tmp) return [];
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(tmp);
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.startsWith(SANDBOX_PREFIX)) continue;
		if (registry.has(path.join(tmp, entry))) continue;
		if (remove(path.join(tmp, entry))) removed.push(path.join(tmp, entry));
	}
	return removed;
}

/**
 * Report sandbox HOME directories that outlived their session.
 *
 * `sandbox-test.sh init` writes a digest of the real plugin manifest at
 * `<sandbox>/.agents/real-manifest.cksum`. If the live manifest still matches,
 * nothing ran outside the sandbox and the directory is inert; if it does not
 * match, something touched the real profile and the sandbox may hold the only
 * evidence, so it is reported rather than deleted.
 *
 * Deliberately does not remove these. A sandbox can be hundreds of megabytes of
 * host natives, but it is also the thing a human is testing by hand right now,
 * and "my TUI session vanished mid-run" is a worse outcome than a large
 * directory. `sandbox-test.sh remove` is the deliberate delete.
 */
export function findOrphanedSandboxes(home = process.env.HOME ?? ""): string[] {
	if (!home) return [];
	const found: string[] = [];
	for (const dir of [
		path.join(home, ".omp", "sandbox-maint"),
		path.join(home, ".pi", "sandbox-maint"),
	]) {
		if (!fs.existsSync(dir)) continue;
		found.push(dir);
	}
	return found;
}

/** Best effort: cleanup must never be the reason a test fails. */
function remove(dir: string): boolean {
	try {
		if (!fs.existsSync(dir)) return false;
		// Refuse anything that is not a directory, or is the temp root itself.
		if (!fs.statSync(dir).isDirectory()) return false;
		if (path.basename(dir) === path.basename(path.dirname(dir))) return false;
		fs.rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/** os.tmpdir() late-bound so a test can point TMPDIR before the suite loads. */
function os_tmpdir(): string {
	return process.env.TMPDIR || "/tmp";
}
