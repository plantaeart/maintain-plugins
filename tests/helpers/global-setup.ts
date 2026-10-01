import { afterAll, beforeAll } from "bun:test";
import { cleanupTestSandboxes, findOrphanedSandboxes, sweepStaleSandboxes } from "./test-sandbox-registry";

/**
 * Global safety net, loaded via bunfig preload.
 *
 * beforeAll:  remove sandbox directories left behind by an earlier crashed run
 * afterAll:   remove every sandbox a test in this run registered, pass or fail
 *
 * Only temp directories are deleted here. A `~/.omp/sandbox-maint` is reported
 * rather than swept: it can be hundreds of megabytes of host natives, but it is
 * also whatever a human may be testing by hand in another terminal.
 */
beforeAll(() => {
	const removed = sweepStaleSandboxes();
	if (removed.length > 0) {
		console.log(`[test setup] removed ${removed.length} stale test sandbox(es):`);
		for (const dir of removed) console.log(`  - ${dir}`);
	}
	const orphans = findOrphanedSandboxes();
	if (orphans.length > 0) {
		console.log("[test setup] sandbox HOME(s) still on disk (not removed):");
		for (const dir of orphans) {
			console.log(`  - ${dir}   (sandbox-test.sh remove when done)`);
		}
	}
});

afterAll(() => {
	const removed = cleanupTestSandboxes();
	if (removed.length > 0) {
		console.log(`[test teardown] removed ${removed.length} test sandbox(es):`);
		for (const dir of removed) console.log(`  - ${dir}`);
	}
});
