import { runPromise } from "@smithers/runtime/runtime";
import type { RunCommandResult } from "./RunCommandResult";
import { runCommandEffect } from "./runCommandEffect";

type RunCommandOptions = {
  cwd: string;
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  return runPromise(runCommandEffect(command, args, options));
}
