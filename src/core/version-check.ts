import { readCache, writeCache } from "../ports/cache.port";
import type { RegistryLookup } from "../ports/registry.port";
import type { PluginRecord } from "./types/plugin-record.type";

/** How long a completed check stays fresh. */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export interface CheckOptions {
	/** Registry lookup; injected so tests never touch the network. */
	lookup: RegistryLookup;
	/** Cache file. Omit to disable caching entirely. */
	cacheFile?: string;
	/** Freshness window. Negative forces a re-query, which tests use. */
	ttlMs?: number;
	/** Injectable clock, so TTL behaviour is deterministic under test. */
	now?: () => number;
}

/**
 * Fill in each record's `latest` version.
 *
 * A check happens on every session start, so the result is cached: without it,
 * each start would make one registry request per installed plugin. The cache
 * also doubles as the offline path - a machine that cannot reach the registry
 * still reports the last known stale state instead of going quiet.
 *
 * ponytail: sequential lookups. With a handful of plugins this is tens of
 * milliseconds; parallelise with Promise.all if the plugin count ever grows
 * large enough for the added failure surface to be worth it.
 */
export async function checkVersions(
	records: PluginRecord[],
	options: CheckOptions,
): Promise<PluginRecord[]> {
	const { lookup, cacheFile, ttlMs = DEFAULT_TTL_MS, now = Date.now } = options;
	if (records.length === 0) return [];

	const cache = await readCache(cacheFile);
	const fresh = cache !== undefined && now() - cache.checkedAt < ttlMs;

	if (fresh) {
		return records.map((record) => ({ ...record, latest: cache.latest[record.name] }));
	}

	// Any previously known version is a floor: if a lookup fails now, the last
	// known value is still better than reporting nothing.
	const known: Record<string, string> = { ...cache?.latest };
	let queried = false;

	const checked = await Promise.all(
		records.map(async (record) => {
			try {
				const latest = await lookup(record.name);
				if (latest) {
					known[record.name] = latest;
					queried = true;
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
	// does not reset the clock and suppress checks for another full TTL.
	if (queried) {
		await writeCache(cacheFile, { checkedAt: now(), latest: known });
	}

	return checked;
}
