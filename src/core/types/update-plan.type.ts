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

export interface UpdateResult {
	ok: boolean;
	/** The version actually installed per plugin, when the run succeeded. */
	applied: PluginUpdate[];
	backups: BackupEntry[];
	/** Human-readable failures, safe to show in the UI. */
	errors: string[];
}
