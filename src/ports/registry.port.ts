/** Ask the npm registry for a package's newest published version. */
export type RegistryLookup = (name: string) => Promise<string | undefined>;

/** Read the newest version of a package from the npm registry. */
export async function lookupNpmVersion(name: string): Promise<string | undefined> {
	try {
		const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`);
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
