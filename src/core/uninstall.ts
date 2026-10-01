import { quote, runCommand, type RunCommand } from "../ports/process.port";
import { HostPlatform } from "./types/host-platform.type";

/**
 * `npm:pkg@1.2.3` -> `pkg`, and `pkg@1.2.3` -> `pkg`.
 *
 * The picker labels a plugin as `name@version`, and a spec may still carry the
 * scheme. The host takes neither, so both are stripped here rather than
 * reaching into the registry for a helper that also does other work.
 */
function stripVersion(spec: string): string {
	return spec.trim().replace(/^npm:/, "").replace(/@[0-9][^@/]*$/, "");
}

/**
 * Removing a plugin through the host's own CLI keeps the manifest, the
 * lockfile/settings and `node_modules` consistent; rewriting the manifest alone
 * would leave the other two behind.
 *
 * The argument differs per host: omp takes a bare name and rejects an `npm:`
 * spec, pi takes the spec.
 */
const UNINSTALL: Record<HostPlatform, (name: string) => string> = {
	[HostPlatform.Omp]: (name) => `omp plugin uninstall ${quote(name)}`,
	[HostPlatform.Pi]: (name) => `pi remove ${quote(`npm:${name}`)}`,
};

/** The host command that removes `name` on this platform. */
export function buildUninstallCommand(host: HostPlatform, name: string): string {
	return UNINSTALL[host](stripVersion(name));
}

export interface UninstallResult {
	ok: boolean;
	/** Ready to show: the name is already in it. */
	message: string;
}

export async function uninstallPlugin(
	host: HostPlatform,
	name: string,
	run: RunCommand = runCommand,
): Promise<UninstallResult> {
	const spec = stripVersion(name);
	const result = await run(buildUninstallCommand(host, spec));
	// A not-found is not a failure worth alarming about: the user asked for the
	// plugin to be gone and it is. Both hosts word it differently.
	if (result.code !== 0) {
		const stderr = result.stderr ?? "";
		if (/not installed|not found|no such/i.test(stderr)) {
			return { ok: true, message: `${spec} was not installed; nothing to do.` };
		}
		return {
			ok: false,
			message: `Could not remove ${spec}: ${stderr.trim().split("\n").pop() ?? `exit ${result.code}`}`,
		};
	}
	return { ok: true, message: `Removed ${spec}. Restart or reload the host to drop it.` };
}
