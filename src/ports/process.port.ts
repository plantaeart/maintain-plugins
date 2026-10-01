import { spawn } from "node:child_process";

export interface RunResult {
	code: number;
	stdout?: string;
	stderr?: string;
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
