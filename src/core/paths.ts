import * as os from "node:os";
import * as path from "node:path";
import { HostPlatform } from "./types/host-platform.type";

/**
 * Detect the host from the process that is actually running.
 *
 * ponytail: `OMPCODE` is NOT a host signal. pi sets `OMPCODE=1` too, so trusting
 * it misreads every pi session as omp - which silently checks the wrong plugin
 * directory. The real signal is the executable pi/omp was launched from, which
 * is present in argv[0] and in the resolved binary path.
 */
export function detectHost(
	env: Record<string, string | undefined> = process.env,
	argv: string[] = process.argv,
): HostPlatform {
	// argv[0] is the interpreter, argv[1] the entry script, and the resolved
	// binary is a fallback when the host is launched through a shim.
	const signature = [...argv, process.execPath ?? ""].join(" ").toLowerCase();

	// omp is checked first: its install path also contains "pi" as a substring
	// ("oh-my-pi"), so testing pi first would classify omp as pi.
	if (/oh-my-pi|(^|[^a-z])omp([^a-z]|$)|\/omp\//.test(signature)) return HostPlatform.Omp;
	if (/\/pi(\/|$)|pi-coding-agent|\.pi\/agent/.test(signature)) return HostPlatform.Pi;

	// Last resort: the host's own agent directory in the environment. An empty
	// environment yields Pi, the more common local setup.
	return env.PI_HOME !== undefined || env.PI_CODING_AGENT !== undefined
		? HostPlatform.Pi
		: HostPlatform.Pi;
}

/** The directory holding a host's installed plugins. */
export function pluginDirFor(host: HostPlatform, home: string = os.homedir()): string {
	return host === HostPlatform.Omp
		? path.join(home, ".omp", "plugins")
		: path.join(home, ".pi", "agent", "npm");
}

/** Where the version-check cache lives, scoped per host. */
export function cachePathFor(host: HostPlatform, home: string = os.homedir()): string {
	return path.join(
		home,
		host === HostPlatform.Omp ? ".omp" : ".pi",
		"agent",
		"state",
		"maintain-plugins",
		"check.json",
	);
}
