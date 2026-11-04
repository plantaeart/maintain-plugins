import { readCache, writeCache } from "../ports/cache.port";
import type { RegistryLookup } from "../ports/registry.port";
import type { PluginRecord } from "./types/plugin-record.type";

export interface CheckOptions {
	/** Registry lookup; injected so tests never touch the network. */
	lookup: RegistryLookup;
	/** Cache file. Omit to disable the offline fallback entirely. */
	cacheFile?: string;
	/** Injectable clock, so the reported age is deterministic under test. */
	now?: () => number;
}

export interface CheckResult {
	records: PluginRecord[];
	/** True only when the registry answered for every plugin in this call. */
	live: boolean;
	/** When the versions shown were fetched; undefined when nothing is known. */
	checkedAt?: number;
}

/**
 * Fill in each record's `latest` version.
 *
 * The registry is asked every time: a session start, `/maint-updates-check` and
 * `/maint-update-all` all want what is published now. The cache file is only the
 * offline path - a machine that cannot reach the registry still reports the
 * last known stale state instead of going quiet, and `live` says so.
 */
export async function checkVersions(
	records: PluginRecord[],
	options: CheckOptions,
): Promise<CheckResult> {
	const { lookup, cacheFile, now = Date.now } = options;
	if (records.length === 0) return { records: [], live: true, checkedAt: now() };

	const cache = await readCache(cacheFile);

	// Any previously known version is a floor: if a lookup fails now, the last
	// known value is still better than reporting nothing.
	const known: Record<string, string> = { ...cache?.latest };
	let answered = 0;

	const checked = await Promise.all(
		records.map(async (record) => {
			try {
				const latest = await lookup(record.name);
				if (latest) {
					known[record.name] = latest;
					answered++;
					return { ...record, latest };
				}
			} catch {
				// Fall through to the cached value below.
			}
			const fallback = known[record.name];
			return fallback ? { ...record, latest: fallback } : { ...record };
		}),
	);

	// Only stamp the cache when a lookup actually answered, so a total outage
	// does not reset the clock and make stale data look recent.
	if (answered > 0) {
		await writeCache(cacheFile, { checkedAt: now(), latest: known });
	}

	return {
		records: checked,
		live: answered === records.length,
		checkedAt: answered > 0 ? now() : cache?.checkedAt,
	};
}
