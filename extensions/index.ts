import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { discoverPlugins } from "../src/core/plugin-registry";
import { cachePathFor, detectHost, pluginDirFor } from "../src/core/paths";
import { uninstallPlugin } from "../src/core/uninstall";
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
 * Widget slot for the session-start notice; cleared on the first message.
 *
 * A widget, not ctx.ui.notify(): notify("info") lands on a status line that the
 * host *replaces* rather than appends, so two plugins notifying at startup
 * silently clobber each other and the loser's message is simply never seen.
 * This extension's check is asynchronous, so it cannot win that race by
 * ordering alone. A widget is its own render layer and cannot be overwritten.
 */
const NOTICE_WIDGET_KEY = "maintain-plugins-notice";

/**
 * How long the notice may stay up when nothing observable dismisses it.
 *
 * Host built-in commands — `/plugin`, `/model`, `/help` — fire no event an
 * extension can observe. There is no hook for them: extensions are notified
 * about the agent loop, not about the host's own commands. Without a deadline
 * the banner would sit above the editor for the whole session after `/plugin`.
 *
 * ponytail: 20s, not a configurable setting. It only has to outlive the
 * startup burst long enough to be read; if it ever proves too short, the
 * dismissal on the first message already covers the common case.
 */
const NOTICE_TTL_MS = 20_000;

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

	/** `⬆️ name: installed -> latest` — shared by the notice and both dialogs. */
	function staleRow(update: Pick<PluginRecord, "name" | "installed" | "latest">): string {
		return `⬆️ ${update.name}: ${update.installed} -> ${update.latest}`;
	}

	/**
	 * Draw the notice as an open-right box: top rule, left edge, bottom rule.
	 *
	 * Deliberately no right border, which means the rows need no padding to line
	 * up — only the two rules do, and both are drawn to the widest row. A closed
	 * box would have to pad every row to a common display width, and an emoji
	 * like ⬆️ occupies one cell while its string is two code points, so a naive
	 * pad leaves every emoji row a column short.
	 */
	function boxBanner(title: string, rows: string[]): string[] {
		const widest = Math.max(
			visibleWidth(title) + 4,
			...rows.map((row) => visibleWidth(row) + 2),
		);
		return [
			`╭─ ${title} ${"─".repeat(Math.max(1, widest - visibleWidth(title) - 4))}`,
			...rows.map((row) => `│ ${row}`),
			`╰─${"─".repeat(Math.max(1, widest - 2))}`,
		];
	}

	function formatReport(checked: PluginRecord[]): string {
		if (checked.length === 0) {
			return `No ${host} plugins found under ${pluginDir}`;
		}
		const stale = new Set(checked.filter(isUpdateAvailable));
		const lines = checked.map((record) => {
			// A marker per line rather than a colour: ctx.ui.notify() takes only
			// info|warning|error, so the host paints every one of these the same
			// grey. A glyph is the only way to make a stale plugin scannable.
			const isStale = stale.has(record);
			const target = isStale ? ` -> ${record.latest}` : "";
			const flag = record.enabled ? "" : " (disabled)";
			const state = isStale ? "update available" : "current";
			return `  ${isStale ? "⬆️" : "·"} ${record.name}: ${record.installed}${target}  [${state}${flag}]`;
		});
		const header = `${host} plugins (${checked.length} installed, ${stale.size} update${
			stale.size === 1 ? "" : "s"
		} available)`;
		return [header, ...lines].join("\n");
	}

	/**
	 * The startup notice: a boxed title plus one row per stale plugin, capped so
	 * a machine with many stale plugins gets a summary rather than a wall of
	 * text. `formatStale` supplies the rows, so the notice and the update dialog
	 * always read the same.
	 */
	function formatStale(checked: PluginRecord[], cap = 4): string {
		const rows = checked.filter(isUpdateAvailable).map(staleRow);
		return boxBanner(staleTitle(rows.length, cap), [
			...rows.slice(0, cap),
			...(rows.length > cap ? [`… and ${rows.length - cap} more`] : []),
			`Run /${ExtensionCommand.UPDATES_CHECK} for the full list.`,
		]).join("\n");
	}

	function staleTitle(count: number, cap = 4): string {
		const shown = Math.min(count, cap);
		const rest = count > cap ? ` (showing ${shown})` : "";
		return `⬆️ ${count} plugin update${count === 1 ? "" : "s"} available${rest}`;
	}

	// The notice has done its job as soon as the user acts on the session, so it
	// leaves on any use of it: a slash command, a typed message, or a completed
	// update. turn_end only covers messages, and a command never ends a turn, so
	// waiting for it alone left the banner up for the rest of the session.
	// The expiry is cancelled here too, so an explicit dismissal does not race a
	// later clear of a widget that has since been set again.
	let expiry: NodeJS.Timeout | undefined;
	const dismissNotice = (ctx: ExtensionContext): void => {
		if (expiry !== undefined) {
			clearTimeout(expiry);
			expiry = undefined;
		}
		ctx.ui.setWidget(NOTICE_WIDGET_KEY, undefined);
	};

	// --- Commands ---

	pi.registerCommand(ExtensionCommand.UPDATES_CHECK, {
		description: EXTENSION_COMMAND_CATALOG[ExtensionCommand.UPDATES_CHECK].description,
		handler: async (_args: string, ctx: ExtensionContext) => {
			// The banner is replaced by this report, so it goes first rather than
			// sitting above the editor while the answer is already on screen.
			dismissNotice(ctx);
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
			const summary = plan.updates.map((u) => `  ${staleRow(u)}`).join("\n");
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
			// The row is re-set on a timer so the spinner animates, because
			// setWidget calls requestRender() on every call. `text` holds the line
			// unprefixed and the glyph is added at paint time — feeding paint() its
			// own output back would prepend a second glyph every tick.
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
				// A load failure is the actionable case: the install worked, the
				// host cannot run the new code, and the way out is to remove it.
				const unloadable = result.failures.filter((f) => f.kind === "load-failed");
				const hint =
					unloadable.length > 0
						? `\n\nRun /${ExtensionCommand.UNINSTALL_PLUGIN} to remove the plugins that can't work with ${host} anymore.`
						: "";
				ctx.ui.notify(
					`❌ Update failed, plugin manifest restored:\n${result.errors.join("\n")}${hint}`,
					"error",
				);
				return;
			}

			// The cached versions are now stale in the other direction; drop them
			// so the next check reflects what is actually installed.
			inFlight = undefined;
			// The startup notice listed exactly what was just applied, so it is now
			// stale itself; leaving it would claim updates that no longer exist.
			// dismissNotice, not a bare clear, so the expiry is cancelled with it.
			dismissNotice(ctx);
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
			const reloading = result.applied.map((u) => `  ${staleRow(u)}`).join("\n");
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

	pi.registerCommand(ExtensionCommand.UNINSTALL_PLUGIN, {
		description: EXTENSION_COMMAND_CATALOG[ExtensionCommand.UNINSTALL_PLUGIN].description,
		handler: async (_args: string, ctx: ExtensionContext) => {
			// Refresh first: the list must reflect what is installed now, not what
			// was found at startup.
			const installed = await discoverPlugins(host);
			if (installed.length === 0) {
				ctx.ui.notify(`No ${host} plugins found under ${pluginDir}.`, "info");
				return;
			}

			// Cancelling the picker is the answer, so there is no separate "never mind".
			const picked = await ctx.ui.select(
				"Remove which plugin?",
				installed.map((record) => `${record.name}@${record.installed}`),
			);
			if (picked === undefined) return;

			// Deleting is not undoable from here, so it always takes a second,
			// explicit step. Nothing is removed on a single keypress.
			const confirmed = await ctx.ui.confirm(
				`Remove ${picked}?`,
				`This runs the host's own uninstaller, which removes ${picked} from the plugin ` +
					`manifest, the lockfile and node_modules.\n\nIt is not backed up here.`,
			);
			if (!confirmed) {
				ctx.ui.notify("Cancelled; nothing was removed.", "info");
				return;
			}

			const result = await uninstallPlugin(host, picked);
			ctx.ui.notify(result.message, result.ok ? "info" : "error");
			// The plugin is gone, so anything cached about it is now wrong.
			if (result.ok) inFlight = undefined;
		},
	});

	// --- Lifecycle ---

	pi.on(ExtensionEventType.SessionStart, (_event: SessionStartEvent, ctx: ExtensionContext) => {
		// Detached and silent: a registry round trip must never delay or block a
		// session, and the notice only appears when something is actually stale.
		void records()
			.then((checked) => {
				if (!checked.some(isUpdateAvailable)) return;
				// Names the stale plugins rather than only counting them: this is the
				// one message shown without the user asking for it, so a bare
				// "1 update available" costs a follow-up command to become useful.
				// One widget holding the whole box, not one per line: separate
				// entries stack vertically and the top and bottom rules would drift
				// apart from the rows between them.
				ctx.ui.setWidget(NOTICE_WIDGET_KEY, formatStale(checked).split("\n"));
				// An expiry, because not every way of using the session is visible
				// to this extension. Host built-in commands (/plugin, /model, /help)
				// fire no event an extension can observe - there is no hook for them -
				// so the dismissal below cannot catch those, and without a deadline
				// the banner would sit above the editor for the whole session.
				expiry = setTimeout(() => {
					expiry = undefined;
					dismissNotice(ctx);
				}, NOTICE_TTL_MS);
			})
			.catch(() => {
				// Never surface a check failure on its own; the command is the
				// place where an error is actionable.
			});
	});

	pi.on(ExtensionEventType.TurnEnd, (_event: unknown, ctx: ExtensionContext) => {
		dismissNotice(ctx);
	});
}

export { HostPlatform };
