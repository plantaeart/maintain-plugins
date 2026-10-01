import { HostPlatform } from "./host-platform.type";

/**
 * One installed plugin, as read from the host's plugin manifest.
 *
 * `installed` is what is on disk. `latest` is filled in by the registry check
 * and stays undefined until then, so "not yet checked" is distinguishable from
 * "checked, and already current".
 */
export interface PluginRecord {
	/** npm package name, without any `npm:` prefix. */
	name: string;
	/** Version currently installed, e.g. "1.7.4". */
	installed: string;
	/** Newest version on the registry, once a check has run. */
	latest?: string;
	/** The host whose plugin directory this record came from. */
	host: HostPlatform;
	/** False when the host has the plugin listed but switched off. */
	enabled: boolean;
}

/** True when a record has a known newer version available. */
export function isUpdateAvailable(record: PluginRecord): boolean {
	return record.latest !== undefined && compareVersions(record.installed, record.latest) < 0;
}

/**
 * The numeric release only: "1.0.0-rc.1" -> "1.0.0".
 *
 * The suffix is dropped before splitting, not after. "1.0.0-rc.1" splits into
 * four parts, and its trailing "1" would otherwise compare as a higher fourth
 * field than the plain "1.0.0".
 */
function releaseOnly(version: string): number[] {
	return version.split("-")[0].split(".").map((part) => {
		const digits = /^(\d+)/.exec(part);
		return digits ? Number.parseInt(digits[1], 10) : 0;
	});
}

/**
 * Compare two dotted numeric versions.
 *
 * ponytail: pre-release suffixes are read as the plain number they lead with, so
 * a pre-release never looks newer than its release. Full semver precedence
 * would need a pre-release ordering table; add one only if a pre-release is ever
 * actually adopted by mistake.
 */
export function compareVersions(a: string, b: string): number {
	const left = releaseOnly(a);
	const right = releaseOnly(b);
	const length = Math.max(left.length, right.length);

	for (let i = 0; i < length; i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff < 0 ? -1 : 1;
	}
	return 0;
}
