import { spawn } from "node:child_process";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/**
 * Runs one child process to completion and reports its output and exit code
 * instead of throwing: 124 on timeout, 127 when the process cannot start.
 */
export function runCommand(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { cwd, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolveCommand({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + `\nCommand timed out after ${timeoutMs}ms.`,
        exitCode: 124,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({ stdout: "", stderr: err.message, exitCode: 127 });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCommand({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });
  });
}
