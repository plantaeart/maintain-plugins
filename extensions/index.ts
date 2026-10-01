import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { discoverPlugins } from "../src/core/plugin-registry";
import { cachePathFor, detectHost, pluginDirFor } from "../src/core/paths";
import { applyUpdates, buildUpdatePlan } from "../src/core/updater";
import { DEFAULT_TTL_MS, checkVersions } from "../src/core/version-check";
import { lookupNpmVersion } from "../src/ports/registry.port";
import { HostPlatform } from "../src/core/types/host-platform.type";
import { isUpdateAvailable, type PluginRecord } from "../src/core/types/plugin-record.type";
import {
	EXTENSION_COMMAND_CATALOG,
	ExtensionCommand,
	ExtensionEventType,
} from "../src/core/types/extension-command.type";

/** Widget slot for the update progress row; cleared when the run ends. */
const PROGRESS_WIDGET_KEY = "maintain-plugins-progress";

/**
 * The host's own spinner frames, reused so the progress row matches it.
 *
 * From `examples/extensions/working-indicator.ts` in the host package: the
 * host's default indicator cannot be borrowed directly, because
 * `setWorkingIndicator()` and `setWorkingMessage()` only draw while
 * `activeStatusIndicator?.kind === "working"` - that is, only while the agent
 * is streaming. A command handler runs between turns, so both are silent here.
 * A widget re-renders on every `setWidget` call, which a timer can drive.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export default function maintainPluginsExtension(pi: ExtensionAPI): void {
	const host = detectHost();
	// Resolved once: the host directory does not move while the session runs.
	const pluginDir = pluginDirFor(host);
	const cacheFile = cachePathFor(host);

	// One check per session, shared by the startup notice and both commands, so
	// a start followed by /maint-updates-check does not re-query the registry.
	let inFlight: Promise<PluginRecord[]> | undefined;

	function records(): Promise<PluginRecord[]> {
		inFlight ??= (async () => {
			const discovered = await discoverPlugins(host);
			return checkVersions(discovered, {
				lookup: lookupNpmVersion,
				cacheFile,
				ttlMs: DEFAULT_TTL_MS,
			});
		})().catch(() => {
			// A failed check must not poison later calls in this session.
			inFlight = undefined;
			return [];
		});
		return inFlight;
	}

	function formatReport(checked: PluginRecord[]): string {
		if (checked.length === 0) {
			return `No ${host} plugins found under ${pluginDir}`;
		}
		const stale = checked.filter(isUpdateAvailable);
		const lines = checked.map((record) => {
			// A marker per line rather than a colour: ctx.ui.notify() takes only
			// info|warning|error, so the host paints every one of these the same
			// grey. A glyph is the only way to make a stale plugin scannable.
			const marker = isUpdateAvailable(record) ? "⬆️" : "·";
			const target = isUpdateAvailable(record) ? ` -> ${record.latest}` : "";
			const flag = record.enabled ? "" : " (disabled)";
			const state = isUpdateAvailable(record) ? "update available" : "current";
			return `  ${marker} ${record.name}: ${record.installed}${target}  [${state}${flag}]`;
		});
		const header = `${host} plugins (${checked.length} installed, ${stale.length} update${
			stale.length === 1 ? "" : "s"
		} available)`;
		return [header, ...lines].join("\n");
	}

	/**
	 * One line per stale plugin, capped so a machine with many stale plugins
	 * gets a summary rather than a wall of text at session start.
	 */
	function formatStale(checked: PluginRecord[], cap = 4): string {
		const rows = checked
			.filter(isUpdateAvailable)
			.map((record) => `  ⬆️ ${record.name}: ${record.installed} -> ${record.latest}`);
		return rows.length > cap
			? `${rows.slice(0, cap).join("\n")}\n  … and ${rows.length - cap} more`
			: rows.join("\n");
	}

	// --- Commands ---

	pi.registerCommand(ExtensionCommand.UPDATES_CHECK, {
		description: EXTENSION_COMMAND_CATALOG[ExtensionCommand.UPDATES_CHECK].description,
		handler: async (_args: string, ctx: ExtensionContext) => {
			const checked = await records();
			ctx.ui.notify(formatReport(checked), "info");
		},
	});

	pi.registerCommand(ExtensionCommand.UPDATE_ALL, {
		description: EXTENSION_COMMAND_CATALOG[ExtensionCommand.UPDATE_ALL].description,
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const checked = await records();
			const plan = buildUpdatePlan(checked);

			if (plan.updates.length === 0) {
				ctx.ui.notify(`All ${host} plugins are up to date.`, "info");
				return;
			}

			// Every version delta is shown before anything is written: this
			// rewrites the host's plugin manifest, and a plugin pinned for a
			// reason is the user's call, not this plugin's.
			const summary = plan.updates
				.map((u) => `  ⬆️ ${u.name}: ${u.installed} -> ${u.latest}`)
				.join("\n");
			const confirmed = await ctx.ui.confirm(
				"Update all plugins?",
				`${plan.updates.length} plugin(s) will be updated:\n${summary}\n\nA backup of the manifest is kept and restored automatically if an install fails.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Update cancelled.", "info");
				return;
			}

			// A widget above the editor, not setWorkingMessage: the working
			// message only draws while the agent is streaming, and a command
			// handler runs between turns. An install produces no output of its
			// own, so without this a long run is an unexplained pause.
			//
			// The row is re-set on a timer so the spinner animates: setWidget
			// calls requestRender() on every call, and a plain one-shot line
			// looks frozen next to the host's own animated spinner.
			// The text is stored unprefixed and the glyph is added at paint time.
			// Feeding paint() its own output back would prepend a second glyph on
			// every tick and grow the row by a character per frame.
			let frame = 0;
			let text = `⬆️ Updating 0/${plan.updates.length}…`;
			const paint = () => {
				const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
				frame++;
				ctx.ui.setWidget(PROGRESS_WIDGET_KEY, [`${glyph} ${text}`]);
			};
			paint();
			const spinner = setInterval(paint, SPINNER_INTERVAL_MS);

			const result = await applyUpdates(checked, {
				pluginDirs: new Map([[host, pluginDir]]),
				onProgress: (update, index, total) => {
					text = `⬆️ Updating ${index}/${total} — ${update.name}`;
					paint();
				},
			});
			clearInterval(spinner);
			ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);

			if (!result.ok) {
				// The manifest has already been rolled back by applyUpdates.
				ctx.ui.notify(
					`❌ Update failed, plugin manifest restored:\n${result.errors.join("\n")}`,
					"error",
				);
				return;
			}

			// The cached versions are now stale in the other direction; drop them
			// so the next check reflects what is actually installed.
			inFlight = undefined;
			ctx.ui.notify(
				`✅ Updated ${result.applied.length} plugin(s):\n` +
					result.applied.map((u) => `  ⬆️ ${u.name} -> ${u.latest}`).join("\n"),
				"info",
			);

			// The running session still holds the old plugin code: the extension
			// in memory, and every other extension that session started. Only a
			// reload picks up what was just written to disk. The dialog names each
			// plugin, because the whole point of the question is "what am I about
			// to reload", and a bare count answers nothing.
			const reloading = result.applied.map((u) => `  ⬆️ ${u.name} ${u.installed} -> ${u.latest}`).join("\n");
			const reloadNow = await ctx.ui.confirm(
				"Reload now?",
				`${result.applied.length} plugin(s) updated. Reloading activates:\n${reloading}\n\n` +
					`Or run ${host === HostPlatform.Omp ? "/reload-plugins" : "/reload"} yourself later.`,
			);
			if (reloadNow) {
				await ctx.reload();
			}
		},
	});

	// --- Lifecycle ---

	pi.on(ExtensionEventType.SessionStart, (_event: SessionStartEvent, ctx: ExtensionContext) => {
		// Detached and silent: a registry round trip must never delay or block a
		// session, and the notice only appears when something is actually stale.
		void records()
			.then((checked) => {
				const stale = checked.filter(isUpdateAvailable);
				if (stale.length === 0) return;
				// Names the stale plugins rather than only counting them: this is the
				// one message shown without the user asking for it, so a bare
				// "1 update available" costs a follow-up command to become useful.
				ctx.ui.notify(
					`⬆️ ${stale.length} plugin update(s) available:\n${formatStale(checked)}\n` +
						`Run /${ExtensionCommand.UPDATES_CHECK} for the full list.`,
					"info",
				);
			})
			.catch(() => {
				// Never surface a check failure on its own; the command is the
				// place where an error is actionable.
			});
	});
}

export { HostPlatform };
