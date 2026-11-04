import { describe, expect, it } from "bun:test";
import { armRestart, restartCommand, type RestartDeps } from "../../src/core/restart";

const EXEC = "/usr/local/bin/omp";
const SESSION = "/home/me/.omp/agent/sessions/proj/abc.jsonl";
/** What a compiled omp reports: argv[1] is a virtual path inside the executable. */
const COMPILED = ["omp", "/$bunfs/root/omp-linux-x64"];

function restart(
	userArgs: string[],
	extra: { sessionFile?: string; execArgv?: string[]; head?: string[]; unsavedConversation?: boolean } = {},
) {
	return restartCommand({
		execPath: EXEC,
		argv: [...(extra.head ?? COMPILED), ...userArgs],
		execArgv: extra.execArgv ?? [],
		sessionFile: "sessionFile" in extra ? extra.sessionFile : SESSION,
		unsavedConversation: extra.unsavedConversation,
	});
}

describe("restartCommand", () => {
	it("relaunches the same executable and resumes the session file", () => {
		expect(restart([])).toEqual([EXEC, "--resume", SESSION]);
	});

	it("keeps flags that configure the session, with their values", () => {
		expect(restart(["--no-skills", "-e", "/x/ext.ts", "--mode", "rpc", "--model=opus"])).toEqual([
			EXEC,
			"--no-skills",
			"-e",
			"/x/ext.ts",
			"--mode",
			"rpc",
			"--model=opus",
			"--resume",
			SESSION,
		]);
	});

	it("replaces an earlier --resume or --continue instead of stacking a second one", () => {
		// A restart that was itself started by a restart must not carry the old target.
		expect(restart(["--resume", "/old.jsonl"])).toEqual([EXEC, "--resume", SESSION]);
		expect(restart(["-r", "abc12345"])).toEqual([EXEC, "--resume", SESSION]);
		expect(restart(["--resume=abc12345"])).toEqual([EXEC, "--resume", SESSION]);
		expect(restart(["--continue"])).toEqual([EXEC, "--resume", SESSION]);
		expect(restart(["-c", "--no-skills"])).toEqual([EXEC, "--no-skills", "--resume", SESSION]);
	});

	it("does not send the launch prompt a second time", () => {
		expect(restart(["Fix the build"])).toEqual([EXEC, "--resume", SESSION]);
		expect(restart(["--continue", "What did we discuss?"])).toEqual([EXEC, "--resume", SESSION]);
		expect(restart(["-e", "/x.ts", "Fix the build"])).toEqual([EXEC, "-e", "/x.ts", "--resume", SESSION]);
	});

	it("drops everything after -- , which can only be messages", () => {
		expect(restart(["--no-skills", "--", "-not-a-flag", "text"])).toEqual([
			EXEC,
			"--no-skills",
			"--resume",
			SESSION,
		]);
	});

	it("declines when a flag it does not know is followed by a bare word", () => {
		// Could be that flag's value or a launch prompt. Guessing wrong either
		// resends a prompt or breaks the launch, so the caller falls back to asking
		// the user.
		expect(restart(["--some-new-flag", "value"])).toBeUndefined();
		expect(restart(["--no-skills", "Fix the build"])).toBeUndefined();
	});

	it("relaunches through the script when omp runs from source, not from a compiled binary", () => {
		expect(restart(["--no-skills"], { head: ["bun", "/opt/omp/cli.ts"] })).toEqual([
			EXEC,
			"/opt/omp/cli.ts",
			"--no-skills",
			"--resume",
			SESSION,
		]);
	});

	it("ignores runtime flags of a compiled omp, which are baked into the executable", () => {
		// Observed in a real omp: execArgv is ["--user-agent=omp/18.16.0"], and the
		// executable supplies it again on its own when it is relaunched.
		expect(restart([], { execArgv: ["--user-agent=omp/18.16.0"] })).toEqual([EXEC, "--resume", SESSION]);
	});

	it("declines when a source run was started with runtime flags it cannot reproduce", () => {
		expect(restart([], { head: ["bun", "/opt/omp/cli.ts"], execArgv: ["--inspect"] })).toBeUndefined();
	});

	it("starts a fresh session when there is nothing saved to resume and nothing to lose", () => {
		expect(restart(["--no-skills"], { sessionFile: undefined })).toEqual([EXEC, "--no-skills"]);
	});

	it("declines when the conversation is not saved, because a restart would silently drop it", () => {
		// `omp --no-session` after an hour of chat: there is no file to resume.
		expect(restart(["--no-session"], { sessionFile: undefined, unsavedConversation: true })).toBeUndefined();
	});

	it("still resumes a saved session even when asked about unsaved work", () => {
		expect(restart([], { unsavedConversation: true })).toEqual([EXEC, "--resume", SESSION]);
	});
});

describe("armRestart", () => {
	/** A host whose exit the test triggers by hand, with a clock it controls. */
	function fakeHost(startAt = 1_000) {
		let clock = startAt;
		let onExit: (() => void) | undefined;
		const execd: string[][] = [];
		const failures: string[] = [];
		const deps: RestartDeps = {
			now: () => clock,
			onExit: (callback) => {
				onExit = callback;
			},
			exec: (command) => {
				execd.push(command);
			},
			fail: (message) => failures.push(message),
		};
		return {
			deps,
			execd,
			failures,
			advance: (ms: number) => {
				clock += ms;
			},
			exit: () => onExit?.(),
			armed: () => onExit !== undefined,
		};
	}

	it("replaces the process with the command when the host exits straight away", () => {
		const host = fakeHost();
		armRestart([EXEC, "--resume", SESSION], 15_000, host.deps);

		host.advance(300);
		host.exit();

		expect(host.execd).toEqual([[EXEC, "--resume", SESSION]]);
	});

	it("does nothing until the host actually exits", () => {
		const host = fakeHost();
		armRestart([EXEC], 15_000, host.deps);

		expect(host.armed()).toBe(true);
		expect(host.execd).toEqual([]);
	});

	it("lets a later, ordinary quit stay a quit when the shutdown was refused", () => {
		// If shutdown() never went through, the user's own quit minutes later must
		// not relaunch omp behind their back.
		const host = fakeHost();
		armRestart([EXEC], 15_000, host.deps);

		host.advance(5 * 60_000);
		host.exit();

		expect(host.execd).toEqual([]);
	});

	it("says so instead of throwing when the relaunch fails", () => {
		const host = fakeHost();
		host.deps.exec = () => {
			throw new Error("ENOENT");
		};
		armRestart([EXEC], 15_000, host.deps);

		host.exit();

		expect(host.failures).toHaveLength(1);
		expect(host.failures[0]).toContain("ENOENT");
	});
});
