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
/** What the seeded check cache says is newest, so no lookup is needed. */
const LATEST = "0.10.0";

interface UiFrame {
	type: string;
	id?: string;
	method?: string;
	message?: string;
	title?: string;
	options?: string[];
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

	constructor(bin: string, home: string, quiet: string[], extraEnv: Record<string, string> = {}) {
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
				env: { ...process.env, HOME: home, ...extraEnv },
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

	/** Answer the next picker; resolves with the chosen option. */
	async select(pick: (options: string[]) => string, what: string): Promise<string> {
		const frame = await this.#next(
			(f) => f.type === "extension_ui_request" && f.method === "select",
			what,
		);
		const options = frame.options ?? [];
		const choice = pick(options);
		this.#child.stdin.write(
			`${JSON.stringify({ type: "extension_ui_response", id: frame.id, value: choice })}\n`,
		);
		return choice;
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

	/**
	 * Stop the host and wait until it has exited. A host still shutting down
	 * writes back into its HOME, so deleting that HOME has to wait for this.
	 */
	async close(): Promise<void> {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#child.once("exit", () => resolve());
		this.#child.kill("SIGTERM");
		await promise;
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

/**
 * Lay down a plugin that the host will discover as installed, without npm.
 *
 * Mirrors the real layout of each host: omp reads a lockfile entry and pi reads
 * node_modules, and discovery only reports a plugin that is present on disk.
 * Enough for a test about removing one, and no registry involved.
 */
async function seedInstalledPlugin(
	home: string,
	host: "omp" | "pi",
	plugins: Record<string, string>,
): Promise<void> {
	// Without a model the host refuses to start, and the extension never loads.
	// `auth: none` is a declaration, not a credential: no request is ever made.
	await fs.mkdir(path.join(home, `.${host}`, "agent"), { recursive: true });
	await fs.writeFile(path.join(home, `.${host}`, "agent", "config.yml"), "setupVersion: 2\n");
	await fs.writeFile(
		path.join(home, `.${host}`, "agent", "models.yml"),
		[
			"providers:",
			"  - id: sandbox",
			"    name: Sandbox",
			"    api: openai-completions",
			"    baseUrl: https://api.openai.com/v1",
			"    auth: none",
			"    models:",
			"      - id: sandbox-model",
			"        name: Sandbox Model",
			"",
		].join("\n"),
	);

	const names = Object.keys(plugins);
	if (host === "omp") {
		const dir = path.join(home, ".omp", "plugins");
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "package.json"),
			JSON.stringify({
				name: "omp-plugins",
				private: true,
				dependencies: Object.fromEntries(names.map((n) => [n, `npm:${n}@${plugins[n]}`])),
			}),
		);
		await fs.writeFile(
			path.join(dir, "omp-plugins.lock.json"),
			JSON.stringify({
				plugins: Object.fromEntries(names.map((n) => [n, { version: plugins[n], enabled: true }])),
				settings: {},
			}),
		);
		for (const name of names) {
			await fs.mkdir(path.join(dir, "node_modules", name), { recursive: true });
			await fs.writeFile(
				path.join(dir, "node_modules", name, "package.json"),
				JSON.stringify({ name, version: plugins[name] }),
			);
		}
		return;
	}
	const agent = path.join(home, ".pi", "agent");
	await fs.mkdir(path.join(agent, "npm"), { recursive: true });
	await fs.writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: names.map((n) => `npm:${n}`) }));
	await fs.writeFile(
		path.join(agent, "npm", "package.json"),
		JSON.stringify({ name: "pi-npm", private: true, dependencies: plugins }),
	);
	for (const name of names) {
		await fs.mkdir(path.join(agent, "npm", "node_modules", name), { recursive: true });
		await fs.writeFile(
			path.join(agent, "npm", "node_modules", name, "package.json"),
			JSON.stringify({ name, version: plugins[name] }),
		);
	}
}

/**
 * A registry the test controls, so "a newer version was just published" is a
 * fact of the fixture rather than of whatever npm says today.
 */
function startRegistry(latest: Record<string, string>) {
	return Bun.serve({
		port: 0,
		fetch(request) {
			const name = decodeURIComponent(new URL(request.url).pathname.split("/")[1] ?? "");
			const version = latest[name];
			return version ? Response.json({ version }) : new Response("not found", { status: 404 });
		},
	});
}

const registryEnv = (server: { port?: number }) => ({
	MAINTAIN_PLUGINS_REGISTRY: `http://127.0.0.1:${server.port}`,
});
/** Nothing listens on port 1: the registry is unreachable. */
const DEAD_REGISTRY = { MAINTAIN_PLUGINS_REGISTRY: "http://127.0.0.1:1" };

/** This plugin's own name, a stale copy of it, and a real published release newer than that. */
const SELF = "maintain-plugins";
const SELF_PIN = "0.3.0";
const SELF_LATEST = "0.4.1";

/**
 * Pretend a registry check just ran, so the version comparison costs no
 * network round trip.
 *
 * The update test below genuinely installs, and cannot avoid that. It can avoid
 * the *lookup* on top of it, which is the part that turned a slow runner into a
 * 120s timeout. Seeding the cache keeps the installed version the only variable,
 * so the assertion stays exact rather than "whatever npm says today".
 */
async function seedCheckCache(home: string, host: "omp" | "pi", latest: Record<string, string>): Promise<void> {
	const dir = path.join(home, `.${host}`, "agent", "state", "maintain-plugins");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "check.json"), JSON.stringify({ checkedAt: Date.now(), latest }));
}

describe("sandbox e2e", () => {
	for (const testCase of HOSTS) {
		describe(testCase.host, () => {
			let sandbox = "";
			let session: HostSession | undefined;
			let registry: Bun.Server<undefined> | undefined;
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
				// The install below is real and unavoidable, so the version it resolves
				// to is not left to a registry call: seeding the cache keeps the
				// assertion exact and removes the request that a slow runner would
				// otherwise spend the frame budget on.
				await seedCheckCache(sandbox, testCase.host, { [PACKAGE]: LATEST });
				// The forced check on /maint-update-all queries the registry, so the
				// version it resolves to is pinned here rather than read from npm.
				registry = startRegistry({ [PACKAGE]: LATEST });
			});

			afterAll(async () => {
				await session?.close();
				registry?.stop(true);
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

					session = new HostSession(testCase.bin, sandbox, [...testCase.quiet], registryEnv(registry!));

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
					const applied = await session.uncachedNotify(/Updated 1 plugin\(s\)/, "the applied update");
					expect(applied).toContain(`⬆️ ${PACKAGE} ->`);
					// An install takes seconds with nothing else on screen; the row
					// must be cleared once it is over, not left behind forever.
					expect(await session.widgetCleared("maintain-plugins-progress")).toBe(true);

					// The session still holds the old plugin code until pi reloads or omp
					// restarts. pi asks, naming each plugin it would activate. omp can
					// only restart itself from a terminal (under rpc, shutdown() does not
					// end the host), so here it says which command to run.
					if (testCase.host === "omp") {
						expect(applied).toContain("Run /restart to load it");
					} else {
						expect(await session.confirm(false, "the reload offer")).toBe("Reload now?");
						expect(session.lastConfirmMessage).toContain(`⬆️ ${PACKAGE}: ${PIN} ->`);
						expect(session.lastConfirmMessage).toContain("/reload");
					}

					// The notice listed exactly what was just applied, so it clears
					// itself rather than claiming updates that no longer exist.
					expect(await session.widgetCleared("maintain-plugins-notice")).toBe(true);

					const updated = await fs.readFile(manifest, "utf8");
					expect(updated).not.toContain(`@${PIN}`);
					expect(await sha256(testCase.realManifest())).toBe(realBefore);

					// The manifest is not the install. Check what the package manager
					// actually put on disk, at the version the cache promised, so a
					// "success" that installed nothing cannot pass.
					const installedPkg = path.join(
						testCase.pluginDir(sandbox),
						"node_modules",
						...PACKAGE.split("/"),
						"package.json",
					);
					expect(JSON.parse(await fs.readFile(installedPkg, "utf8")).version).toBe(LATEST);

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

			it(
				"removes a plugin only after an explicit confirmation",
				async () => {
					if (sandbox === "") {
						console.warn(`skipping ${testCase.host} e2e: '${testCase.bin}' is not on PATH`);
						return;
					}
					// Its own sandbox: this one deletes the plugin the other test
					// asserts on.
					//
					// Seeded by hand rather than through `sandbox-test.sh init`,
					// which resolves the pin from npm. Uninstalling needs a plugin
					// that is *listed and installed*, not one with a newer version, so
					// this test takes a stub manifest and never touches the registry.
					// That is what made it the slow one: a cold runner spends the
					// frame budget on a network round trip.
					const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-uninstall-"));
					registerTestSandbox(dir);
					await seedInstalledPlugin(dir, testCase.host, { [PACKAGE]: PIN });
					const fresh = new HostSession(testCase.bin, dir, [...testCase.quiet]);
					try {
						const realBefore = await sha256(testCase.realManifest());
						const manifestPath = path.join(testCase.pluginDir(dir), "package.json");

						fresh.run("/maint-uninstall-plugin");
						// Offered as a list of what is installed, each with its version.
						const chosen = await fresh.select((o) => o[0], "the plugin picker");
						expect(chosen).toBe(`${PACKAGE}@${PIN}`);

						// Declining must leave the manifest byte-identical: this is the
						// only command here that destroys something.
						expect(await fresh.confirm(false, "the removal confirmation")).toBe(
							`Remove ${PACKAGE}@${PIN}?`,
						);
						await fresh.notify(/nothing was removed/, "the cancellation");
						expect(await fs.readFile(manifestPath, "utf8")).toContain(PACKAGE);

						fresh.run("/maint-uninstall-plugin");
						await fresh.select((o) => o[0], "the plugin picker, second time");
						await fresh.confirm(true, "the removal confirmation, second time");
						await fresh.notify(new RegExp(`Removed ${PACKAGE}`), "the removal");

						// Gone from the manifest, and the real profile untouched.
						expect(await fs.readFile(manifestPath, "utf8")).not.toContain(PACKAGE);
						expect(await sha256(testCase.realManifest())).toBe(realBefore);
					} finally {
						// Deleted here rather than by the global teardown: each omp HOME
						// holds the host's natives, and the teardown has one 5 s budget
						// for all of them.
						await fresh.close();
						await fs.rm(dir, { recursive: true, force: true });
					}
				},
				180_000,
			);

			it(
				"refreshes on /maint-updates-check even when a fresh cache says everything is current",
				async () => {
					if (sandbox === "") {
						console.warn(`skipping ${testCase.host} e2e: '${testCase.bin}' is not on PATH`);
						return;
					}
					const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-refresh-"));
					registerTestSandbox(dir);
					await seedInstalledPlugin(dir, testCase.host, { [PACKAGE]: PIN });
					// A release published after the cache was written: the cache is
					// still inside its TTL and says there is nothing to do.
					await seedCheckCache(dir, testCase.host, { [PACKAGE]: PIN });
					const newer = startRegistry({ [PACKAGE]: LATEST });
					const fresh = new HostSession(testCase.bin, dir, [...testCase.quiet], registryEnv(newer));
					try {
						fresh.run("/maint-updates-check");
						const report = await fresh.uncachedNotify(/installed, \d+ update/, "the refreshed report");
						expect(report).toContain("1 update available");
						expect(report).toContain(`⬆️ ${PACKAGE}: ${PIN} -> ${LATEST}`);
						expect(report).toContain("/maint-update-all");
					} finally {
						await fresh.close();
						newer.stop(true);
						await fs.rm(dir, { recursive: true, force: true });
					}
				},
				180_000,
			);

			it(
				"checks the registry by itself when a session starts, whatever the cache says",
				async () => {
					if (sandbox === "") {
						console.warn(`skipping ${testCase.host} e2e: '${testCase.bin}' is not on PATH`);
						return;
					}
					const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-startup-"));
					registerTestSandbox(dir);
					await seedInstalledPlugin(dir, testCase.host, { [PACKAGE]: PIN });
					// Inside its TTL and claiming nothing is stale: only a refresh at
					// session start can show the release published since.
					await seedCheckCache(dir, testCase.host, { [PACKAGE]: PIN });
					const newer = startRegistry({ [PACKAGE]: LATEST });
					const fresh = new HostSession(testCase.bin, dir, [...testCase.quiet], registryEnv(newer));
					try {
						const notice = await fresh.widget(/plugin update.* available/, "the startup notice");
						expect(notice).toContain(`⬆️ ${PACKAGE}: ${PIN} -> ${LATEST}`);
					} finally {
						await fresh.close();
						newer.stop(true);
						await fs.rm(dir, { recursive: true, force: true });
					}
				},
				180_000,
			);

			it(
				"says when /maint-updates-check is showing cached versions because the registry is unreachable",
				async () => {
					if (sandbox === "") {
						console.warn(`skipping ${testCase.host} e2e: '${testCase.bin}' is not on PATH`);
						return;
					}
					const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-offline-"));
					registerTestSandbox(dir);
					await seedInstalledPlugin(dir, testCase.host, { [PACKAGE]: PIN });
					await seedCheckCache(dir, testCase.host, { [PACKAGE]: LATEST });
					const offline = new HostSession(testCase.bin, dir, [...testCase.quiet], DEAD_REGISTRY);
					try {
						offline.run("/maint-updates-check");
						const report = await offline.uncachedNotify(/installed, \d+ update/, "the cached report");
						expect(report).toMatch(/could not reach the registry/i);
						expect(report).toContain("cached");
						expect(report).toContain(`⬆️ ${PACKAGE}: ${PIN} -> ${LATEST}`);
						expect(report).toContain("/maint-update-all");
					} finally {
						await offline.close();
						await fs.rm(dir, { recursive: true, force: true });
					}
				},
				180_000,
			);

			it(
				"updates itself first, reloads, then offers the remaining plugins",
				async () => {
					if (sandbox === "") {
						console.warn(`skipping ${testCase.host} e2e: '${testCase.bin}' is not on PATH`);
						return;
					}
					const dir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-self-"));
					registerTestSandbox(dir);
					await seedInstalledPlugin(dir, testCase.host, { [PACKAGE]: PIN, [SELF]: SELF_PIN });
					const newer = startRegistry({ [PACKAGE]: LATEST, [SELF]: SELF_LATEST });
					const fresh = new HostSession(testCase.bin, dir, [...testCase.quiet], registryEnv(newer));
					const installed = (name: string) =>
						fs
							.readFile(path.join(testCase.pluginDir(dir), "node_modules", name, "package.json"), "utf8")
							.then((raw) => JSON.parse(raw).version as string);
					let restarted: HostSession | undefined;
					try {
						// This plugin leads the startup notice: it is what gets updated first.
						const notice = await fresh.widget(/plugin updates? available/, "the startup notice");
						expect(notice).toContain(`⬆️ ${SELF}: ${SELF_PIN} -> ${SELF_LATEST}`);
						expect(notice.indexOf(SELF)).toBeLessThan(notice.indexOf(PACKAGE));

						fresh.run("/maint-update-all");
						expect(await fresh.confirm(true, "the self-update confirmation")).toBe("Update all plugins?");
						// The dialog names the plugin going now and the one that waits.
						expect(fresh.lastConfirmMessage).toContain(`⬆️ ${SELF}: ${SELF_PIN} -> ${SELF_LATEST}`);
						expect(fresh.lastConfirmMessage).toContain(
							testCase.host === "omp" ? "after the restart" : "after the reload",
						);
						expect(fresh.lastConfirmMessage).toContain(`⬆️ ${PACKAGE}: ${PIN} -> ${LATEST}`);

						const applied = await fresh.uncachedNotify(/Updated 1 plugin\(s\)/, "the self-update");
						expect(await installed(SELF)).toBe(SELF_LATEST);

						// pi reloads in-process. Under rpc, omp cannot restart itself, so the
						// second host process on the same HOME stands in for the user's
						// /restart and finds the marker the first one left.
						let next = fresh;
						if (testCase.host === "pi") {
							expect(await fresh.confirm(true, "the reload offer")).toBe("Reload now?");
						} else {
							expect(applied).toContain("Run /restart to load it");
							expect(applied).toContain("remaining 1 plugin(s)");
							await fresh.close();
							next = restarted = new HostSession(testCase.bin, dir, [...testCase.quiet], registryEnv(newer));
						}

						// The new session picks the rest up on its own. Only the other
						// plugin is in it: this one is already current.
						expect(await next.confirm(true, "the continued update")).toBe("Update all plugins?");
						expect(next.lastConfirmMessage).toContain(`⬆️ ${PACKAGE}: ${PIN} -> ${LATEST}`);
						expect(next.lastConfirmMessage).not.toContain(`${SELF}:`);

						const done = await next.uncachedNotify(/Updated 1 plugin\(s\)/, "the second update");
						expect(done).toContain(`⬆️ ${PACKAGE} -> ${LATEST}`);
						expect(done).toContain(testCase.host === "omp" ? "Run /restart to load it" : "/reload");
						expect(await installed(PACKAGE)).toBe(LATEST);
					} finally {
						await fresh.close();
						await restarted?.close();
						newer.stop(true);
						await fs.rm(dir, { recursive: true, force: true });
					}
				},
				240_000,
			);
		});
	}
});

/**
 * omp's in-place restart only exists in the terminal UI: under rpc, shutdown()
 * does not end the host, so no rpc test can show it. This drives the real
 * terminal through tmux instead, and skips when tmux or omp is missing.
 */
describe("omp terminal restart", () => {
	const hasTools = ["omp", "tmux"].every((bin) => Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode === 0);

	const tmux = (...args: string[]) => Bun.spawnSync(["tmux", ...args]).stdout.toString();

	/**
	 * Poll until `check` holds. The delay between polls is the only real timer
	 * here: the screen of another process raises no event to await, and the
	 * deadline is a guard against a hang, not synchronisation.
	 */
	async function until(check: () => boolean | Promise<boolean>, what: string, describeState: () => string, timeoutMs = 120_000) {
		const deadline = Date.now() + timeoutMs;
		while (!(await check())) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}.\n${describeState()}`);
			await Bun.sleep(250);
		}
	}
	/** A terminal omp in a sandbox HOME with a stale `maintain-plugins` and a stale `system-prompt-switch`. */
	async function launch(extraFlags: string[]) {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-tui-"));
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-tui-proj-"));
		registerTestSandbox(home);
		registerTestSandbox(project);
		await seedInstalledPlugin(home, "omp", { [PACKAGE]: PIN, [SELF]: SELF_PIN });
		// A prompt is sent so that the session holds a conversation; point the
		// model at a closed port so that costs no network or money.
		const models = path.join(home, ".omp", "agent", "models.yml");
		await fs.writeFile(models, (await fs.readFile(models, "utf8")).replace("https://api.openai.com/v1", "http://127.0.0.1:1/v1"));
		const registry = startRegistry({ [PACKAGE]: LATEST, [SELF]: SELF_LATEST });
		const session = `maint-e2e-${process.pid}-${extraFlags.length}`;
		const quote = (value: string) => `'${value}'`;
		tmux(
			"new-session", "-d", "-s", session, "-x", "150", "-y", "50", "-c", project,
			[
				"env", `HOME=${quote(home)}`, `MAINTAIN_PLUGINS_REGISTRY=http://127.0.0.1:${registry.port}`,
				"omp", "--no-skills", "--no-rules", "--no-extensions", ...extraFlags,
				"-e", quote(path.join(REPO_ROOT, "extensions/index.ts")),
			].join(" "),
		);
		// `env` execs omp, so the pane's process is omp itself, and an in-place
		// restart keeps that pid.
		const pid = Number(tmux("display-message", "-p", "-t", session, "#{pane_pid}").trim());
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const screen = () => tmux("capture-pane", "-t", session, "-p");
		return {
			screen,
			send: (...keys: string[]) => tmux("send-keys", "-t", session, ...keys),
			waitScreen: async (match: RegExp, what: string) => {
				await until(() => match.test(screen()), what, () => `screen:\n${screen().slice(-800)}`);
				return screen();
			},
			/** True once a session file on disk holds the message: only then can omp resume it. */
			messageSaved: async () => {
				const root = path.join(home, ".omp", "agent", "sessions");
				const entries = await fs.readdir(root, { recursive: true }).catch(() => []);
				for (const entry of entries.filter((name) => name.endsWith(".jsonl"))) {
					if ((await fs.readFile(path.join(root, entry), "utf8")).includes("hello e2e")) return true;
				}
				return false;
			},
			installed: (name: string) =>
				fs
					.readFile(path.join(home, ".omp", "plugins", "node_modules", name, "package.json"), "utf8")
					.then((raw) => JSON.parse(raw).version as string),
			markerFile: path.join(home, ".omp", "agent", "state", "maintain-plugins", "continue.json"),
			describeScreen: () => `screen:\n${screen().slice(-800)}`,
			close: async () => {
				tmux("kill-session", "-t", session);
				// A host still shutting down writes back into its HOME.
				await until(() => !alive(), "omp to exit", () => `pid ${pid} still running`);
				registry.stop(true);
				await fs.rm(home, { recursive: true, force: true });
				await fs.rm(project, { recursive: true, force: true });
			},
		};
	}

	const exists = (file: string) => fs.access(file).then(() => true, () => false);

	it(
		"restarts omp in place into the same session and carries on with the remaining plugins",
		async () => {
			if (!hasTools) {
				console.warn("skipping omp terminal restart: 'omp' or 'tmux' is not on PATH");
				return;
			}
			const tui = await launch([]);
			try {
				await tui.waitScreen(/2 plugin updates available/, "the startup notice");

				// Saved only once there is a message; without one there is nothing to resume.
				tui.send("hello e2e", "Enter");
				await until(tui.messageSaved, "the message to be saved", tui.describeScreen);
				// The reply fails at once (closed port). A command typed while the
				// agent is still working is queued as a steering message instead of run.
				await until(() => !/Working/.test(tui.screen()), "the agent to go idle", tui.describeScreen);

				tui.send("/maint-update-all", "Enter");
				const first = await tui.waitScreen(/Update all plugins\?/, "the first confirmation");
				expect(first).toContain(`${SELF}: ${SELF_PIN} -> ${SELF_LATEST}`);
				expect(first).toContain("after the restart");
				tui.send("Enter");

				const offer = await tui.waitScreen(/Restart now\?/, "the restart offer");
				expect(offer).toContain("Restarting keeps this session");
				expect(await tui.installed(SELF)).toBe(SELF_LATEST);
				// Left for the next session to take.
				expect(await exists(tui.markerFile)).toBe(true);
				tui.send("Enter");

				// The extension in the new process consumed the marker, which is the
				// proof that omp really restarted; the conversation is the proof that
				// it came back on the same session.
				const resumed = await tui.waitScreen(/Update all plugins\?/, "the continued update after the restart");
				expect(resumed).toContain(`${PACKAGE}: ${PIN} -> ${LATEST}`);
				expect(resumed).not.toContain(`${SELF}: `);
				expect(resumed).toContain("hello e2e");
				expect(await exists(tui.markerFile)).toBe(false);
				tui.send("Enter");

				await tui.waitScreen(/Restart now\?/, "the second restart offer");
				expect(await tui.installed(PACKAGE)).toBe(LATEST);
			} finally {
				await tui.close();
			}
		},
		400_000,
	);

	it(
		"does not offer a restart that would drop an unsaved conversation",
		async () => {
			if (!hasTools) {
				console.warn("skipping omp terminal restart: 'omp' or 'tmux' is not on PATH");
				return;
			}
			// --no-session: the chat lives only in this process, so a restart would
			// come back empty while the dialog promises the session is kept.
			const tui = await launch(["--no-session"]);
			try {
				await tui.waitScreen(/2 plugin updates available/, "the startup notice");
				tui.send("hello e2e", "Enter");
				await tui.waitScreen(/hello e2e/, "the message on screen");
				await until(() => !/Working/.test(tui.screen()), "the agent to go idle", tui.describeScreen);

				tui.send("/maint-update-all", "Enter");
				await tui.waitScreen(/Update all plugins\?/, "the confirmation");
				tui.send("Enter");

				const done = await tui.waitScreen(/Run \/restart to load it/, "the manual restart hint");
				expect(done).not.toContain("Restart now?");
				expect(await tui.installed(SELF)).toBe(SELF_LATEST);
			} finally {
				await tui.close();
			}
		},
		400_000,
	);
});
