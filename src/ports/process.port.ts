import { spawn } from "node:child_process";

export interface RunResult {
	code: number;
	stdout?: string;
	stderr?: string;
}

/**
 * Quote a value for the shell.
 *
 * Shared because two core modules build host commands and both got their own
 * copy; a command built with the wrong quoting can be split into two arguments,
 * which for an uninstaller means removing the wrong thing.
 */
export function quote(value: string): string {
	return /[\s"'|&;<>()$`]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

/** Where to run a command. Needed by installers that take no target flag. */
export interface RunOptions {
	cwd?: string;
}

/** Run a command and resolve with its exit code. Never rejects. */
export type RunCommand = (command: string, options?: RunOptions) => Promise<RunResult>;

/** Default runner, used by the extension. */
export const runCommand: RunCommand = (command, options) =>
	new Promise((resolve) => {
		const child = spawn(command, {
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => resolve({ code: 1, stderr: String(error) }));
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
