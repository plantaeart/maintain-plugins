/**
 * The command line that relaunches this omp on the same session.
 *
 * Mirrors what omp's own `/restart` builds, which an extension cannot call:
 * the launch flags stay, any earlier resume target and any launch prompt go,
 * and `--resume <session file>` is added. omp keeps its table of flags that
 * take a value private, so this carries its own, read off `omp --help`.
 * A flag outside both tables followed by a bare word is ambiguous (its value,
 * or a launch prompt), and guessing wrong either resends a prompt or breaks the
 * launch. That case answers `undefined`, and the caller asks the user to run
 * `/restart` instead.
 */

/** Flags that take the next argument as their value. */
const VALUE_FLAGS: readonly string[] = [
	"--model", "--smol", "--slow", "--plan", "--prewalk-into", "--plan-yolo-into", "--provider",
	"--api-key", "--system-prompt", "--system-prompt-template", "--append-system-prompt",
	"--profile", "--alias", "--cwd", "--mode", "--config", "--add-dir", "--session-dir",
	"--models", "--tools", "--thinking", "--service-tier", "--hook", "-e", "--extension",
	"--skills", "--export", "--max-time", "--warn-cost", "--max-cost", "--approval-mode",
];

/** Flags that choose which session to open. A restart replaces them. */
const SESSION_FLAGS: readonly string[] = [
	"--resume", "-r", "--restore", "--session", "--continue", "-c", "--fork",
	"--from-claude", "--from-codex", "--goal",
];

export interface RestartInput {
	execPath: string;
	/** `process.argv`. */
	argv: string[];
	/** `process.execArgv`. */
	execArgv: string[];
	/** The session to resume; absent when nothing has been saved yet. */
	sessionFile?: string;
	/**
	 * True when the session holds messages but has no file (`--no-session`). A
	 * restart would start an empty one, so it is declined rather than done.
	 */
	unsavedConversation?: boolean;
}

export function restartCommand(input: RestartInput): string[] | undefined {
	if (input.sessionFile === undefined && input.unsavedConversation) return undefined;
	// A compiled omp reports a virtual path inside the executable as argv[1];
	// run from source, argv[1] is the script the runtime has to be given again.
	const compiled = input.argv[1]?.startsWith("/$bunfs/") ?? false;
	// A compiled executable carries its own runtime flags (`--user-agent=omp/…`
	// was observed) and supplies them again on relaunch. From source, flags like
	// --inspect would be lost, so that case is left to the user.
	if (!compiled && input.execArgv.length > 0) return undefined;

	const command = compiled ? [input.execPath] : [input.execPath, input.argv[1]];
	const args = input.argv.slice(2);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		const next = args[i + 1];
		const nextIsWord = next !== undefined && !next.startsWith("-");

		if (!arg.startsWith("-")) continue; // a launch prompt: not resent

		const name = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
		if (SESSION_FLAGS.includes(name)) {
			// The word after it is either its value or a launch prompt; both go.
			if (!arg.includes("=") && nextIsWord) i++;
			continue;
		}
		command.push(arg);
		if (arg.includes("=")) continue;
		if (VALUE_FLAGS.includes(arg)) {
			if (next !== undefined) {
				command.push(next);
				i++;
			}
		} else if (nextIsWord) {
			return undefined;
		}
	}

	if (input.sessionFile !== undefined) command.push("--resume", input.sessionFile);
	return command;
}

export interface RestartDeps {
	now(): number;
	/** Run `callback` when the process exits. */
	onExit(callback: () => void): void;
	/** Replace the current process with `command`; only returns on failure by throwing. */
	exec(command: string[]): void;
	fail(message: string): void;
}

/**
 * Relaunch `command` in place of this process once it exits.
 *
 * The relaunch is only honoured within `graceMs`: the caller asks the host to
 * shut down straight after arming, so an exit later than that is the user's own
 * quit after a refused shutdown, and must stay a quit.
 */
export function armRestart(command: string[], graceMs: number, deps: RestartDeps): void {
	const deadline = deps.now() + graceMs;
	deps.onExit(() => {
		if (deps.now() > deadline) return;
		try {
			deps.exec(command);
		} catch (error) {
			deps.fail(`Restart failed (${error instanceof Error ? error.message : String(error)}). Run omp --continue.`);
		}
	});
}
