import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * A one-shot note that survives a restart: "this plugin just updated itself, so
 * the session that starts next should carry on with the remaining plugins".
 *
 * A file, because a restart tears the extension's memory down. It records the
 * working directory it was written in, so a window open on another project
 * does not take it (omp's `--continue` is per directory too). Consuming it
 * deletes it, so a later session never repeats the update, and a marker older
 * than `maxAgeMs` is dropped rather than honoured: it cannot mean "the restart
 * that just happened".
 */
export async function markContinue(
	file: string,
	cwd: string,
	now: () => number = Date.now,
): Promise<void> {
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify({ at: now(), cwd }));
	} catch {
		// Without the marker the user simply runs /maint-update-all again.
	}
}

/** Drop the marker without honouring it, e.g. when the reload it announced failed. */
export async function clearContinue(file: string): Promise<void> {
	await fs.rm(file, { force: true });
}

export async function consumeContinue(
	file: string,
	options: { cwd: string; maxAgeMs: number; now?: () => number },
): Promise<boolean> {
	const { cwd, maxAgeMs, now = Date.now } = options;
	let marker: { at?: unknown; cwd?: unknown } | null | undefined;
	try {
		marker = JSON.parse(await fs.readFile(file, "utf8")) as typeof marker;
	} catch {
		// Absent or corrupt: if it exists at all, it is cleared below.
	}
	// Another directory's marker is not ours to take or to delete.
	if (typeof marker?.cwd === "string" && marker.cwd !== cwd) return false;
	await clearContinue(file);
	return typeof marker?.at === "number" && now() - marker.at < maxAgeMs;
}
