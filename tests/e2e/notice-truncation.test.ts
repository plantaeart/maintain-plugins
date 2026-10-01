import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerTestSandbox } from "../helpers/test-sandbox-registry";

/**
 * The session-start notice must name the stale plugins without becoming a wall
 * of text.
 *
 * The cap lives inside the extension's session_start handler, which cannot be
 * imported without a host, so this drives a real `omp` process and reads the
 * notification it emits. That is the only way to assert the shipped wording
 * rather than a copy of it.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Six stale entries: past the cap, so the truncation branch is exercised.
 *
 * The names are arbitrary and the newest versions come from a pre-seeded check
 * cache, so no registry call decides what this test asserts. Using real npm
 * names instead would make the expected versions drift with the registry, and
 * a name that stops resolving would quietly drop it from the stale set.
 */
const STALE = ["alpha-plugin", "beta-plugin", "gamma-plugin", "delta-plugin", "epsilon-plugin", "zeta-plugin"];
const CAP = 4;
const LATEST = "9.9.9";

describe("session-start notice", () => {
	it(
		"names each stale plugin and caps the list",
		async () => {
			if (Bun.spawnSync(["sh", "-c", "command -v omp"]).exitCode !== 0) {
				console.warn("skipping notice test: 'omp' is not on PATH");
				return;
			}

			const home = await fs.mkdtemp(path.join(os.tmpdir(), "maint-e2e-notice-"));
			registerTestSandbox(home);
			const dir = path.join(home, ".omp", "plugins");
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(
				path.join(dir, "package.json"),
				JSON.stringify({
					name: "omp-plugins",
					private: true,
					dependencies: Object.fromEntries(STALE.map((n) => [n, `npm:${n}@1.0.0`])),
				}),
			);
			await fs.writeFile(
				path.join(dir, "omp-plugins.lock.json"),
				JSON.stringify({
					plugins: Object.fromEntries(STALE.map((n) => [n, { version: "1.0.0", enabled: true }])),
					settings: {},
				}),
			);
			// Same credential-free model declaration the sandbox skill seeds, so
			// the host boots without an API key.
			await fs.mkdir(path.join(home, ".omp", "agent"), { recursive: true });
			await fs.writeFile(
				path.join(home, ".omp", "agent", "models.yml"),
				"providers:\n  - id: sandbox\n    name: Sandbox\n    api: openai-completions\n    baseUrl: https://api.openai.com/v1\n    auth: none\n    models:\n      - id: sandbox-model\n        name: Sandbox Model\n",
			);
			await fs.writeFile(path.join(home, ".omp", "agent", "config.yml"), "setupVersion: 2\n");

			// A seeded check cache makes every entry stale at a known version with
			// no registry request, so the assertion below cannot drift.
			const stateDir = path.join(home, ".omp", "agent", "state", "maintain-plugins");
			await fs.mkdir(stateDir, { recursive: true });
			await fs.writeFile(
				path.join(stateDir, "check.json"),
				JSON.stringify({
					checkedAt: Date.now(),
					latest: Object.fromEntries(STALE.map((n) => [n, LATEST])),
				}),
			);

			const child = spawn(
				"omp",
				["--no-session", "--no-skills", "--no-rules", "--mode", "rpc", "-e", path.join(REPO_ROOT, "extensions/index.ts")],
				{ cwd: REPO_ROOT, env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] },
			);

			const notice = await new Promise<string>((resolve, reject) => {
				let buffer = "";
				const timer = setTimeout(() => {
					child.kill("SIGTERM");
					reject(new Error("no session-start notice arrived"));
				}, 60_000);
				child.stdout.on("data", (chunk: Buffer) => {
					buffer += chunk.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						let frame: { type?: string; method?: string; message?: string };
						try {
							frame = JSON.parse(line);
						} catch {
							continue;
						}
						if (frame.type === "extension_ui_request" && frame.method === "notify" && /plugin update/.test(frame.message ?? "")) {
							clearTimeout(timer);
							child.kill("SIGTERM");
							resolve(frame.message ?? "");
						}
					}
				});
				child.on("error", reject);
			});

			const rows = notice.split("\n").filter((line) => /⬆️ \S+:/.test(line));
			expect(rows.length).toBe(CAP);
			// The withheld ones are named in the summary rather than silently dropped.
			expect(notice).toContain("… and 2 more");
			expect(notice).not.toContain("⬆️ f:");
			expect(notice).toContain("Run /maint-updates-check for the full list.");
		},
		90_000,
	);
});