/** Ask the npm registry for a package's newest published version. */
export type RegistryLookup = (name: string) => Promise<string | undefined>;

/**
 * Read the newest version of a package from the npm registry.
 *
 * `MAINTAIN_PLUGINS_REGISTRY` redirects the lookup; the e2e suite points it at
 * a local server so "a new version was just published" is a fixture, not
 * whatever npm says today.
 */
export async function lookupNpmVersion(
	name: string,
	timeoutMs = 5000,
): Promise<string | undefined> {
	try {
		const base = process.env.MAINTAIN_PLUGINS_REGISTRY ?? "https://registry.npmjs.org";
		// A deadline, because every check now waits on this: a network that drops
		// packets silently would otherwise freeze the command and hide the cache
		// fallback, which only triggers on an answer of "unknown".
		const response = await fetch(`${base}/${encodeURIComponent(name)}/latest`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		const version = (body as { version?: unknown } | null)?.version;
		// A registry response without a usable version string is treated as
		// unknown, never as "up to date".
		return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}
