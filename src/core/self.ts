import pkg from "../../package.json";
import type { PluginRecord } from "./types/plugin-record.type";
import { SELF_NAME } from "./updater";

/** The version of the copy of this plugin that is executing right now. */
export const RUNNING_VERSION: string = pkg.version;

/**
 * The installed version of this plugin when it differs from the running one.
 *
 * Right after a self-update the disk holds the new release while the old code
 * is still in memory, until a reload. Undefined when the two agree, and when
 * this plugin is not installed at all (a dev checkout loaded with `-e`).
 */
export function reloadPending(
	records: PluginRecord[],
	running: string = RUNNING_VERSION,
): string | undefined {
	const installed = records.find((record) => record.name === SELF_NAME)?.installed;
	return installed !== undefined && installed !== running ? installed : undefined;
}
