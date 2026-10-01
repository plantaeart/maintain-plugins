import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The on-disk shape of the version-check cache. */
export interface CheckCache {
	/** Epoch millis of the last completed registry check. */
	checkedAt: number;
	/** Newest known version per package name. */
	latest: Record<string, string>;
}

/** A cache that holds nothing, used when no file is configured. */
const NO_CACHE: CheckCache | undefined = undefined;

export async function readCache(file: string | undefined): Promise<CheckCache | undefined> {
	if (!file) return NO_CACHE;
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		const checkedAt = (parsed as { checkedAt?: unknown } | null)?.checkedAt;
		const latest = (parsed as { latest?: unknown } | null)?.latest;
		// A cache is an optimisation. Anything unreadable is simply absent, so a
		// corrupt or half-written file costs one re-check and never an error.
		if (typeof checkedAt !== "number" || typeof latest !== "object" || latest === null) {
			return undefined;
		}
		return {
			checkedAt,
			latest: Object.fromEntries(
				Object.entries(latest).filter((entry): entry is [string, string] => {
					return typeof entry[1] === "string";
				}),
			),
		};
	} catch {
		return undefined;
	}
}

export async function writeCache(file: string | undefined, cache: CheckCache): Promise<void> {
	if (!file) return;
	try {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(cache, null, 2));
	} catch {
		// A cache that cannot be written only means the next start re-queries.
	}
}
