import { Effect } from "effect";
import { spawnCaptureEffect } from "@smithers/driver/child-process";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { RunCommandResult } from "./RunCommandResult";

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

export function runCommandEffect(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Effect.Effect<RunCommandResult, SmithersError> {
  const {
    cwd,
    env,
    input,
    timeoutMs,
    idleTimeoutMs,
    signal,
    maxOutputBytes,
    onStdout,
    onStderr,
  } = options;
  return spawnCaptureEffect(command, args, {
    cwd,
    env,
    input,
    signal,
    timeoutMs,
    idleTimeoutMs,
    maxOutputBytes,
    onStdout,
    onStderr,
  }).pipe(
    Effect.annotateLogs({
      agentCommand: command,
      agentArgs: args.join(" "),
      cwd,
    }),
    Effect.withLogSpan(`agent:${command}`),
  );
}
