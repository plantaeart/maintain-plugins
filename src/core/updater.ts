import * as fs from "node:fs/promises";
import * as path from "node:path";
import { quote, runCommand, type RunCommand } from "../ports/process.port";
import { HostPlatform } from "./types/host-platform.type";
import { isUpdateAvailable, type PluginRecord } from "./types/plugin-record.type";
import type {
	BackupEntry,
	PluginUpdate,
	UpdateFailure,
	UpdateFailureKind,
	UpdatePlan,
	UpdateResult,
} from "./types/update-plan.type";

/**
 * Apply version bumps to a host's plugin directory.
 *
 * Each host pins its plugins in a private package.json and resolves them with
 * its own package manager, so the update is: rewrite the pin, then let that
 * manager install it. The manifest is copied first and restored if the manager
 * fails, because a manifest pinned to a version that was never installed leaves
 * the host in a worse state than not having tried.
 *
 * ponytail: self-update is out of scope. A plugin cannot meaningfully roll back
 * the copy of itself that is currently executing.
 */

/**
 * Each host installs with its own CLI, so its own lockfile stays authoritative.
 *
 * omp discovers the installed version from `omp-plugins.lock.json`, which
 * `bun add` does not rewrite, so a bun install leaves the next check reporting
 * the version just replaced as still stale. pi reads the version out of
 * `node_modules`, which `npm install` writes directly.
 *
 * `needsCwd` because the two installers say where they are going differently:
 * `npm install --prefix` does, `omp plugin install` does not.
 */
const INSTALL: Record<
	HostPlatform,
	{ command: (dir: string, name: string, version: string) => string; needsCwd: boolean }
> = {
	[HostPlatform.Omp]: {
		command: (_dir, name, version) => `omp plugin install ${quote(`${name}@${version}`)}`,
		needsCwd: true,
	},
	[HostPlatform.Pi]: {
		command: (dir, name, version) =>
			`npm install --prefix ${quote(dir)} ${quote(`${name}@${version}`)}`,
		needsCwd: false,
	},
};

export function buildUpdatePlan(records: PluginRecord[]): UpdatePlan {
	const updates: PluginUpdate[] = [];
	const skipped: UpdatePlan["skipped"] = [];

	for (const record of records) {
		if (!record.enabled) {
			skipped.push({ name: record.name, reason: "disabled" });
			continue;
		}
		if (!isUpdateAvailable(record)) {
			// Only an unknown latest is worth naming; a current plugin is just
			// current and would only add noise to the report.
			if (record.latest === undefined) {
				skipped.push({ name: record.name, reason: "unknown-latest" });
			}
			continue;
		}
		updates.push({
			name: record.name,
			installed: record.installed,
			latest: record.latest as string,
			host: record.host,
		});
	}

	const byHost = new Map<HostPlatform, PluginUpdate[]>();
	for (const update of updates) {
		const list = byHost.get(update.host) ?? [];
		list.push(update);
		byHost.set(update.host, list);
	}

	return { updates, skipped, byHost };
}

export interface ApplyOptions {
	/** Absolute plugin directory per host. */
	pluginDirs: Map<HostPlatform, string>;
	run?: RunCommand;
	/**
	 * Called immediately before each install.
	 *
	 * Installing a package can take a while and produces no output of its own,
	 * so without this a long run is an unexplained pause. Fired for every
	 * plugin in the batch: a failure does not stop the loop, the whole batch is
	 * rolled back afterwards.
	 */
	onProgress?: (update: PluginUpdate, index: number, total: number) => void;
}

async function readManifest(dir: string): Promise<Record<string, unknown>> {
	const raw = await fs.readFile(path.join(dir, "package.json"), "utf8");
	return JSON.parse(raw) as Record<string, unknown>;
}

async function backupManifest(host: HostPlatform, dir: string): Promise<BackupEntry> {
	const source = path.join(dir, "package.json");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupFile = path.join(dir, `package.json.maintain-plugins-backup-${stamp}`);
	await fs.copyFile(source, backupFile);
	return { host, file: source, backupFile };
}

async function restoreEntries(entries: BackupEntry[]): Promise<void> {
	for (const entry of entries) {
		try {
			await fs.copyFile(entry.backupFile, entry.file);
		} catch {
			// Nothing further to try: the error is reported by the caller, and a
			// failed restore must not mask the original failure.
		}
	}
}

/**
 * Tell a failed install apart from a plugin that installed but will not load.
 *
 * The second case is not rare and not the user's fault: a plugin can start
 * using a host API that only exists in the other host, and the package manager
 * is perfectly happy about it. Reporting that as "install failed" sends them
 * looking at npm for a problem that is not there.
 */
function classifyFailure(stderr: string | undefined): UpdateFailureKind {
	if (stderr && /Failed to load extension|is not a function/.test(stderr)) return "load-failed";
	return "install-failed";
}

/** The lines that actually explain the failure, out of whatever the host said. */
function failureDetail(stderr: string | undefined): string {
	if (!stderr) return "";
	return stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /Failed to load extension|is not a function|Error:/i.test(line))
		.slice(0, 2)
		.join(" ");
}

export async function applyUpdates(
	records: PluginRecord[],
	options: ApplyOptions,
): Promise<UpdateResult> {
	const plan = buildUpdatePlan(records);
	if (plan.updates.length === 0) {
		return { ok: true, applied: [], backups: [], errors: [], failures: [] };
	}

	const run = options.run ?? runCommand;
	const backups: BackupEntry[] = [];
	const failures: UpdateFailure[] = [];

	for (const [host, updates] of plan.byHost) {
		const dir = options.pluginDirs.get(host);
		if (!dir) {
			failures.push({
				name: updates.map((u) => u.name).join(", "),
				kind: "install-failed",
				host,
				detail: "plugin directory not resolved",
			});
			continue;
		}

		let manifest: Record<string, unknown>;
		try {
			manifest = await readManifest(dir);
		} catch (error) {
			failures.push({
				name: updates.map((u) => u.name).join(", "),
				kind: "install-failed",
				host,
				detail: `cannot read package.json (${String(error)})`,
			});
			continue;
		}

		backups.push(await backupManifest(host, dir));

		// omp writes bare keys with an "npm:" scheme in the value; pi writes bare
		// keys and bare values. So the style is read from the values, not the keys.
		const existing = (manifest.dependencies as Record<string, unknown>) ?? {};
		const styleIsNpmPrefixed = Object.values(existing).some(
			(spec) => typeof spec === "string" && spec.startsWith("npm:"),
		);
		const deps = { ...existing };
		for (const update of updates) {
			deps[update.name] = styleIsNpmPrefixed
				? `npm:${update.name}@${update.latest}`
				: `${update.name}@${update.latest}`;
		}
		manifest.dependencies = deps;
		await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(manifest, null, 2));

		for (const [index, update] of updates.entries()) {
			options.onProgress?.(update, index + 1, updates.length);
			const result = await run(INSTALL[host].command(dir, update.name, update.latest), {
				cwd: INSTALL[host].needsCwd ? dir : undefined,
			});
			if (result.code !== 0) {
				const kind = classifyFailure(result.stderr);
				failures.push({
					name: update.name,
					kind,
					host,
					detail: failureDetail(result.stderr) || result.stderr?.trim().split("\n").pop() || "",
				});
			}
		}
	}

	if (failures.length > 0) {
		// Roll the whole batch back: a partial upgrade is harder to reason about
		// than no upgrade.
		await restoreEntries(backups);
		// A load failure keeps the host's own words out of it: the raw stderr is
		// a full path and a function signature, and what the user needs is the
		// verdict and the remedy, not the trace.
		const errors = failures.map((f) =>
			f.kind === "load-failed"
				? `${f.name}: installed, but this host cannot load it on ${f.host}.`
				: `${f.name}: install failed on ${f.host} — ${f.detail}`,
		);
		return { ok: false, applied: [], backups, errors, failures };
	}

	return { ok: true, applied: plan.updates, backups, errors: [], failures };
}

export async function restoreFromBackup(entries: BackupEntry[]): Promise<void> {
	await restoreEntries(entries);
}
