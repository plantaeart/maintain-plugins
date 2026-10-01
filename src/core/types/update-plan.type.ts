import { HostPlatform } from "./host-platform.type";

/** One plugin to move from `installed` to `latest`. */
export interface PluginUpdate {
	name: string;
	installed: string;
	latest: string;
	host: HostPlatform;
}

/** A plugin left out of the update, and why. */
export interface SkippedUpdate {
	name: string;
	reason: "disabled" | "unknown-latest";
}

export interface UpdatePlan {
	updates: PluginUpdate[];
	skipped: SkippedUpdate[];
	byHost: Map<HostPlatform, PluginUpdate[]>;
}

/** A copy of a host manifest, kept so a failed update can be undone. */
export interface BackupEntry {
	host: HostPlatform;
	/** The file that was copied, as it was before the update. */
	file: string;
	/** Where the copy lives. */
	backupFile: string;
}

/** Why one plugin did not end up updated. */
export type UpdateFailureKind =
	/** The package manager failed: network, bad version, or a broken manifest. */
	| "install-failed"
	/** Installed, but the host could not load it. Usually a host-API mismatch. */
	| "load-failed";

/** One plugin that failed, with enough detail to act on. */
export interface UpdateFailure {
	name: string;
	kind: UpdateFailureKind;
	/** The host it was installed on; the message names it, since one host often
	 *  accepts a version the other cannot load. */
	host: HostPlatform;
	/** The host's own words, for an install failure. Empty for a load failure. */
	detail: string;
}

export interface UpdateResult {
	ok: boolean;
	/** The version actually installed per plugin, when the run succeeded. */
	applied: PluginUpdate[];
	backups: BackupEntry[];
	/** Human-readable failures, safe to show in the UI. */
	errors: string[];
	/** The same failures, structured. `errors` is derived from these. */
	failures: UpdateFailure[];
}
