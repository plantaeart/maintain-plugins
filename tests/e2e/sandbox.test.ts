import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerTestSandbox } from "../helpers/test-sandbox-registry";

/**
 * End-to-end: the real host CLI, the real extension, a real npm install.
 *
 * `/maint-update-all` rewrites the host's plugin manifest, and that manifest is
 * what every real plugin install reads, so a test running against the live
 * profile would rewrite the user's working setup. These tests get a throwaway
 * HOME first, seeded by the `sandbox-test` skill.
 *
 * The host runs in `--mode rpc` rather than a TUI: commands go in on stdin and
 * the extension's user-facing output comes back as `extension_ui_request`
 * frames on stdout. That is what lets a test answer the update confirmation
 * with nobody present.
 *
 * No API key is involved. The sandbox seeds a credential-free `models.yml` with
 * `auth: none`, so the host boots and loads the extension without ever making a
 * model call.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SANDBOX_SCRIPT = path.join(REPO_ROOT, ".agents/skills/sandbox-test/scripts/sandbox-test.sh");

/** The plugin the sandbox seeds, and the version it is pinned below. */
const PACKAGE = "system-prompt-switch";
const PIN = "0.9.5";

interface UiFrame {
	type: string;
	id?: string;
	method?: string;
	message?: string;
	title?: string;
	/** setWidget carries either lines or nothing; nothing means "clear it". */
	widgetKey?: string;
	widgetLines?: string[];
}

/**
 * One host session, as a queue of UI frames.
 *
 * Frames arrive on stdout at whatever pace the host emits them, so every
 * assertion awaits the frame it needs rather than a delay. Each `next*` call
 * consumes one matching frame, which is what makes the two `/maint-update-all`
 * rounds distinguishable.
 */
class HostSession {
	readonly #child: ChildProcessWithoutNullStreams;
	#notifies: string[] = [];
	/** Body of the most recent confirm dialog, for asserting its guidance. */
	lastConfirmMessage = "";
	#pending: UiFrame[] = [];
	#readers: { match: (frame: UiFrame) => boolean; resolve: (frame: UiFrame) => void }[] = [];
	#buffer = "";
	#stderr = "";
	#cleared = new Map<string, number>();

	constructor(bin: string, home: string, quiet: string[]) {
		this.#child = spawn(
			bin,
			[
				...quiet,
				// This package is also installed in the test runner's own profile.
				// Without this the host discovers that copy too, and the test
				// observes a mix of the code under test and the published one.
				"--no-extensions",
				"--mode",
				"rpc",
				"-e",
				path.join(REPO_ROOT, "extensions/index.ts"),
			],
			{
				// HOME is what isolates; os.tmpdir() is only tidiness.
				cwd: os.tmpdir(),
				env: { ...process.env, HOME: home },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.#child.stdout.on("data", (chunk: Buffer) => this.#consume(chunk.toString()));
		this.#child.stderr.on("data", (chunk: Buffer) => {
			this.#stderr += chunk.toString();
		});
	}

	#consume(chunk: string) {
		const lines = (this.#buffer + chunk).split("\n");
		// Whatever follows the last newline is a partial line. Dropping it would
		// split a JSON frame across two reads and lose it; holding it is why a
		// chunk boundary is not a frame boundary.
		this.#buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let frame: UiFrame;
			try {
				frame = JSON.parse(line) as UiFrame;
			} catch {
				continue;
			}
			if (
				frame.type === "extension_ui_request" &&
				frame.method === "setWidget" &&
				frame.widgetKey !== undefined &&
				(frame.widgetLines === undefined || frame.widgetLines.length === 0)
			) {
				const key = frame.widgetKey;
				this.#cleared.set(key, (this.#cleared.get(key) ?? 0) + 1);
			}
			const index = this.#readers.findIndex((reader) => reader.match(frame));
			if (index >= 0) {
				const [reader] = this.#readers.splice(index, 1);
				reader.resolve(frame);
			} else {
				this.#pending.push(frame);
			}
		}
	}

	/**
	 * How many times a named widget has been cleared.
	 */
	clearedWidgets(key: string): number {
		return this.#cleared.get(key) ?? 0;
	}

	/**
	 * Await the next frame satisfying `match`.
	 *
	 * The timer is a deadlock guard, not synchronisation: the test proceeds the
	 * instant the frame lands, and only fails if it never does.
	 */
	#next(match: (frame: UiFrame) => boolean, what: string, timeoutMs = 120_000): Promise<UiFrame> {
		const queued = this.#pending.findIndex(match);
		if (queued >= 0) {
			const [frame] = this.#pending.splice(queued, 1);
			return Promise.resolve(frame);
		}
		const { promise, resolve, reject } = Promise.withResolvers<UiFrame>();
		const reader = { match, resolve };
		this.#readers.push(reader);
		const deadline = setTimeout(() => {
			const index = this.#readers.indexOf(reader);
			if (index >= 0) this.#readers.splice(index, 1);
			reject(new Error(`timed out waiting for ${what}. stderr: ${this.#stderr.slice(-400)}`));
		}, timeoutMs);
		return promise.finally(() => clearTimeout(deadline));
	}

	run(command: string) {
		this.#child.stdin.write(`${JSON.stringify({ type: "prompt", message: command })}\n`);
	}

	async notify(match: RegExp, what: string): Promise<string> {
		const cached = this.#notifies.find((line) => match.test(line));
		if (cached !== undefined) return cached;
		return this.uncachedNotify(match, what);
	}

	/**
	 * Await a notification that has not already been seen.
	 *
	 * `notify` replays from history, which is wrong when the same query is asked
	 * twice: asking /maint-updates-check before and after an update wants the
	 * second answer, and a replay would hand back the first.
	 */
	async uncachedNotify(match: RegExp, what: string): Promise<string> {
		const frame = await this.#next(
			(f) => f.type === "extension_ui_request" && f.method === "notify" && match.test(f.message ?? ""),
			what,
		);
		const message = frame.message ?? "";
		this.#notifies.push(message);
		return message;
	}

	/** Answer the next confirmation dialog; resolves with its title. */
	async confirm(answer: boolean, what: string): Promise<string> {
		const frame = await this.#next(
			(f) => f.type === "extension_ui_request" && f.method === "confirm",
			what,
		);
		this.lastConfirmMessage = frame.message ?? "";
		this.#child.stdin.write(
			`${JSON.stringify({ type: "extension_ui_response", id: frame.id, confirmed: answer })}\n`,
		);
		return frame.title ?? "";
	}

	/**
	 * Await a widget line matching `match`.
	 *
	 * Widget content arrives as an array of lines; the extension replaces the
	 * whole array on every update, so this resolves on the line it wants rather
	 * than on any later state.
	 */
	async widget(match: RegExp, what: string): Promise<string> {
		const frame = await this.#next(
			(f) =>
				f.type === "extension_ui_request" &&
				f.method === "setWidget" &&
				(f.widgetLines ?? []).some((line) => match.test(line)),
			what,
		);
		return (frame.widgetLines ?? []).join("\n");
	}

	/**
	 * Resolve once the named widget has been cleared.
	 *
	 * A widget left on screen after its moment passed would sit above the editor
	 * for the rest of the session claiming work that is already done.
	 */
	async widgetCleared(key: string, timeoutMs = 30_000): Promise<boolean> {
		try {
			await this.#next(
				(f) =>
					f.type === "extension_ui_request" &&
					f.method === "setWidget" &&
					f.widgetKey === key &&
					(f.widgetLines === undefined || f.widgetLines.length === 0),
				`the ${key} widget to be cleared`,
				timeoutMs,
			);
			return true;
		} catch {
			return false;
		}
	}

	close() {
		this.#child.kill("SIGTERM");
	}
}

const HOSTS = [
	{
		host: "omp",
		bin: "omp",
		// The two hosts do not share a flag set: pi has no --no-rules.
		quiet: ["--no-session", "--no-skills", "--no-rules"],
		// The manifest `/maint-update-all` rewrites inside the sandbox.
		pluginDir: (home: string) => path.join(home, ".omp/plugins"),
		// The one in the live profile, which must never change.
		realManifest: () => path.join(os.homedir(), ".omp/plugins/package.json"),
	},
	{
		host: "pi",
		bin: "pi",
		quiet: ["--no-session", "--no-skills"],
		pluginDir: (home: string) => path.join(home, ".pi/agent/npm"),
		realManifest: () => path.join(os.homedir(), ".pi/agent/npm/package.json"),
	},
] as const;

async function sha256(file: string): Promise<string> {
	try {
		return createHash("sha256")
			.update(await fs.readFile(file))
			.digest("hex");
	} catch {
		return "absent";
	}
}

describe("sandbox e2e", () => {
	for (const testCase of HOSTS) {
		describe(testCase.host, () => {
			let sandbox = "";
			let session: HostSession | undefined;

			beforeAll(async () => {
				if (Bun.spawnSync(["sh", "-c", `command -v ${testCase.bin}`]).exitCode !== 0) return;
				// os.tmpdir() rather than the skill's default: a test must not share
				// a sandbox with a human who is using it right now.
				sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `maint-e2e-${testCase.host}-`));
				// Registered so tests/helpers/global-setup.ts removes it even if this
				// run is killed before afterAll runs. The registry is the safety net
				// for a host binary left running and a half-seeded directory.
				registerTestSandbox(sandbox);
				// --pin so the fixture cannot drift under a run. Left to itself the
				// script picks the second-newest published version, which is the right
				// default for a human and the wrong one for a fixed assertion.
				const seeded = Bun.spawnSync(
					[
						"bash",
						SANDBOX_SCRIPT,
						"init",
						"--host",
						testCase.host,
						"--package",
						PACKAGE,
						"--pin",
						PIN,
						"--path",
						sandbox,
					],
					{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
				);
				if (seeded.exitCode !== 0) throw new Error(`sandbox init: ${seeded.stderr.toString()}`);
			});

			afterAll(async () => {
				session?.close();
				if (sandbox !== "") await fs.rm(sandbox, { recursive: true, force: true });
			});

			it(
				"updates the sandbox manifest and leaves the real one untouched",
				async () => {
					if (sandbox === "") {
						console.warn(`skipping ${testCase.host} e2e: '${testCase.bin}' is not on PATH`);
						return;
					}

					const realBefore = await sha256(testCase.realManifest());
					const manifest = path.join(testCase.pluginDir(sandbox), "package.json");
					const seeded = await fs.readFile(manifest, "utf8");
					// pi pins a bare version, omp an `npm:` spec; both name the pin.
					expect(seeded).toContain(PIN);

					session = new HostSession(testCase.bin, sandbox, [...testCase.quiet]);

					// The startup notice is a widget, not a notify: notify("info")
					// lands on a replaceable status line that another plugin can clobber,
					// and this check is async so it cannot win that race by ordering.
					// Match the stable part of the title, not its exact wording.
					const notice = await session.widget(/plugin update.* available/, "the startup notice");
					expect(notice).toContain("⬆️ 1 plugin update available");
					expect(notice).toContain(`⬆️ ${PACKAGE}: ${PIN} ->`);
					expect(notice).toContain("Run /maint-updates-check for the full list.");

					// Using the session must take the banner down. A slash command
					// never ends a turn, so waiting on turn_end alone left it up for
					// the rest of the session - and it stacked on top of the report
					// the command itself produced.
					session.run("/maint-updates-check");
					expect(await session.widgetCleared("maintain-plugins-notice")).toBe(true);
					// Exactly one clear: dismissNotice cancels the expiry timer, so a
					// later expiry must not re-clear a widget that may have been set
					// again in the meantime.
					await new Promise((resolve) => setTimeout(resolve, 500));
					expect(session.clearedWidgets("maintain-plugins-notice")).toBe(1);

					const report = await session.uncachedNotify(
						/installed, 1 update available/,
						"the check report",
					);
					expect(report).toContain(`⬆️ ${PACKAGE}: ${PIN} ->`);
					expect(await fs.readFile(manifest, "utf8")).toBe(seeded);

					// Declining must not touch a single byte.
					session.run("/maint-update-all");
					expect(await session.confirm(false, "the first confirmation")).toBe("Update all plugins?");
					await session.notify(/Update cancelled/, "the cancellation");
					expect(await fs.readFile(manifest, "utf8")).toBe(seeded);

					session.run("/maint-update-all");
					expect(await session.confirm(true, "the second confirmation")).toBe("Update all plugins?");
					// The progress row is a widget, which is a real rpc frame - so
					// unlike setWorkingMessage it can be asserted here at all. The
					// leading braille glyph is the spinner; the row is re-set on a
					// timer so it animates instead of looking frozen.
					await session.widget(/Updating 1\/1/, "the progress widget");
					expect(await session.widget(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] ⬆️ Updating/, "the spinner frame"));
					expect(await session.uncachedNotify(/Updated 1 plugin\(s\)/, "the applied update")).toContain(
						`⬆️ ${PACKAGE} ->`,
					);
					// An install takes seconds with nothing else on screen; the row
					// must be cleared once it is over, not left behind forever.
					expect(await session.widgetCleared("maintain-plugins-progress")).toBe(true);

					// The session still holds the old plugin code until it reloads,
					// and the dialog has to say which plugins it would activate -
					// the question is "what am I about to reload", not "how many".
					const reloadPrompt = await session.confirm(false, "the reload offer");
					expect(reloadPrompt).toBe("Reload now?");
					expect(session.lastConfirmMessage).toContain(`⬆️ ${PACKAGE}: ${PIN} ->`);
					expect(session.lastConfirmMessage).toContain(
						testCase.host === "omp" ? "/reload-plugins" : "/reload",
					);

					// The notice listed exactly what was just applied, so it clears
					// itself rather than claiming updates that no longer exist.
					expect(await session.widgetCleared("maintain-plugins-notice")).toBe(true);

					const updated = await fs.readFile(manifest, "utf8");
					expect(updated).not.toContain(`@${PIN}`);
					expect(await sha256(testCase.realManifest())).toBe(realBefore);

					// The regression this sandbox was built for: the host
					// discovers omp plugins from omp-plugins.lock.json, so an
					// install that skips the lock leaves the next check reporting
					// the version just replaced as still stale.
					session.run("/maint-updates-check");
					const recheck = await session.uncachedNotify(
						/installed, \d+ update/,
						"the re-check",
					);
					expect(recheck).toContain("0 updates available");
					expect(recheck).not.toContain(`${PACKAGE}: ${PIN} ->`);
				},
				180_000,
			);
		});
	}
});
