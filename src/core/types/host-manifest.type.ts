/**
 * The on-disk shapes this plugin reads. Each host stores its plugin list
 * differently, so both are named here rather than being probed field by field
 * at the call site.
 */

/** `~/.omp/plugins/omp-plugins.lock.json` — one entry per resolved plugin. */
export interface OmpPluginLock {
	plugins?: Record<string, { version?: unknown; enabled?: unknown }>;
}

/** `~/.omp/plugins/package.json` — dependency specs, `npm:pkg@1.2.3` in practice. */
export interface OmpPluginManifest {
	dependencies?: Record<string, unknown>;
}

/** `~/.pi/agent/settings.json` — the requested packages, as `npm:pkg` strings. */
export interface PiSettings {
	packages?: unknown[];
}

/** Any `package.json` in node_modules. */
export interface InstalledPackageManifest {
	version?: unknown;
}
