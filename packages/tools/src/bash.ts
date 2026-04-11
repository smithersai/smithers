import { tool, zodSchema } from "ai";
import { Effect, Metric } from "effect";
import { z } from "zod";
import { nowMs } from "@smithers/scheduler/nowMs";
import { spawnCaptureEffect } from "@smithers/runtime/child-process";
import { fromSync } from "@smithers/runtime/interop";
import { runPromise } from "@smithers/runtime/runtime";
import { resolveSandboxPath, assertPathWithinRootEffect } from "./utils";
import { getToolContext } from "./context";
import { SmithersError } from "@smithers/errors/SmithersError";
import {
  assertOptionalArrayMaxLength,
  assertOptionalStringMaxLength,
  assertPositiveFiniteInteger,
} from "@smithers/db/input-bounds";
import { toolOutputTruncatedTotal } from "@smithers/observability/metrics";
import {
  logToolCallEffect,
  logToolCallStartEffect,
  truncateToBytes,
} from "./logToolCall";

const DARWIN_NETWORK_DENY_PROFILE = "(version 1) (allow default) (deny network*)";
export const BASH_TOOL_MAX_COMMAND_LENGTH = 8_192;
export const BASH_TOOL_MAX_ARGS = 128;
export const BASH_TOOL_MAX_ARG_LENGTH = 8_192;
export const BASH_TOOL_MAX_CWD_LENGTH = 1_024;
export const BASH_TOOL_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const BASH_TOOL_MAX_TIMEOUT_MS = 60 * 60 * 1000;

type ResolvedCommand = {
  command: string;
  args: string[];
};

function resolveNetworkIsolatedCommand(
  cmd: string,
  args: string[],
): ResolvedCommand {
  if (process.platform === "darwin") {
    const sandboxExec = typeof Bun !== "undefined" ? Bun.which("sandbox-exec") : null;
    if (sandboxExec) {
      return {
        command: sandboxExec,
        args: ["-p", DARWIN_NETWORK_DENY_PROFILE, cmd, ...args],
      };
    }
  }

  return { command: cmd, args };
}

function validateBashInvocation(
  cmd: string,
  args: string[] | undefined,
  opts: { cwd?: string } | undefined,
  ctx: { maxOutputBytes?: number; timeoutMs?: number },
) {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    throw new SmithersError(
      "INVALID_INPUT",
      "cmd must be a non-empty string.",
    );
  }
  assertOptionalStringMaxLength("cmd", cmd, BASH_TOOL_MAX_COMMAND_LENGTH);
  assertOptionalArrayMaxLength("args", args, BASH_TOOL_MAX_ARGS);
  for (const [index, arg] of (args ?? []).entries()) {
    assertOptionalStringMaxLength(`args[${index}]`, arg, BASH_TOOL_MAX_ARG_LENGTH);
  }
  const commandLine = [cmd, ...(args ?? [])].join(" ");
  assertOptionalStringMaxLength(
    "command",
    commandLine,
    BASH_TOOL_MAX_COMMAND_LENGTH,
  );
  assertOptionalStringMaxLength("opts.cwd", opts?.cwd, BASH_TOOL_MAX_CWD_LENGTH);

  const maxOutputBytes = ctx.maxOutputBytes ?? 200_000;
  assertPositiveFiniteInteger("maxOutputBytes", Number(maxOutputBytes));
  if (maxOutputBytes > BASH_TOOL_MAX_OUTPUT_BYTES) {
    throw new SmithersError(
      "INVALID_INPUT",
      `maxOutputBytes exceeds ${BASH_TOOL_MAX_OUTPUT_BYTES}.`,
      { maxOutputBytes, maxAllowed: BASH_TOOL_MAX_OUTPUT_BYTES },
    );
  }

  const timeoutMs = ctx.timeoutMs ?? 60_000;
  assertPositiveFiniteInteger("timeoutMs", Number(timeoutMs));
  if (timeoutMs > BASH_TOOL_MAX_TIMEOUT_MS) {
    throw new SmithersError(
      "INVALID_INPUT",
      `timeoutMs exceeds ${BASH_TOOL_MAX_TIMEOUT_MS}.`,
      { timeoutMs, maxAllowed: BASH_TOOL_MAX_TIMEOUT_MS },
    );
  }
}

export function bashToolEffect(
  cmd: string,
  args?: string[],
  opts?: { cwd?: string },
) {
  const ctx = getToolContext();
  const root = ctx?.rootDir ?? process.cwd();
  const allowNetwork = ctx?.allowNetwork ?? false;
  const started = nowMs();
  let seq: number | undefined;
  return Effect.gen(function* () {
    validateBashInvocation(cmd, args, opts, {
      maxOutputBytes: ctx?.maxOutputBytes,
      timeoutMs: ctx?.timeoutMs,
    });
    seq = yield* logToolCallStartEffect("bash", started);
    const cwd = opts?.cwd
      ? yield* fromSync("resolve sandbox path", () =>
          resolveSandboxPath(root, opts.cwd!),
        )
      : root;
    yield* assertPathWithinRootEffect(root, cwd);
    if (!allowNetwork) {
      const hay = [cmd, ...(args ?? [])].join(" ");
      const networkCommands = [
        "curl",
        "wget",
        "http://",
        "https://",
        "npm",
        "bun",
        "pip",
      ];
      if (networkCommands.some((fragment) => hay.includes(fragment))) {
        throw new SmithersError("TOOL_NETWORK_DISABLED", "Network access is disabled for bash tool");
      }
      if (hay.includes("git")) {
        const gitRemoteOps = ["push", "pull", "fetch", "clone", "remote"];
        if (gitRemoteOps.some((op) => hay.includes(op))) {
          throw new SmithersError("TOOL_GIT_REMOTE_DISABLED", "Git remote operations are disabled for bash tool");
        }
      }
    }

    const timeoutMs = ctx?.timeoutMs ?? 60_000;
    const maxOutputBytes = ctx?.maxOutputBytes ?? 200_000;
    const resolvedCommand = !allowNetwork
      ? resolveNetworkIsolatedCommand(cmd, args ?? [])
      : { command: cmd, args: args ?? [] };
    const result = yield* spawnCaptureEffect(resolvedCommand.command, resolvedCommand.args, {
      cwd,
      env: process.env,
      detached: true,
      maxOutputBytes,
      timeoutMs,
    });
    const output = truncateToBytes(
      `${result.stdout}${result.stderr}`,
      maxOutputBytes,
    );
    if (Buffer.byteLength(`${result.stdout}${result.stderr}`, "utf8") > maxOutputBytes) {
      yield* Metric.increment(toolOutputTruncatedTotal);
    }
    if (result.exitCode !== 0) {
      throw new SmithersError("TOOL_COMMAND_FAILED", `Command failed with exit code ${result.exitCode}`);
    }
    yield* logToolCallEffect(
      "bash",
      { cmd, args },
      { output },
      "success",
      undefined,
      started,
      seq,
    );
    return output;
  }).pipe(
    Effect.annotateLogs({
      toolName: "bash",
      cmd,
      args: (args ?? []).join(" "),
      rootDir: root,
      allowNetwork,
    }),
    Effect.withLogSpan("tool:bash"),
    Effect.tapError((error) =>
      logToolCallEffect(
        "bash",
        { cmd, args },
        null,
        "error",
        error,
        started,
        seq,
      ),
    ),
  );
}

export const bash: any = tool({
  description: "Execute a shell command",
  inputSchema: zodSchema(
    z.object({
      cmd: z.string(),
      args: z.array(z.string()).optional(),
      opts: z.object({ cwd: z.string().optional() }).optional(),
    }),
  ),
  execute: async ({
    cmd,
    args,
    opts,
  }: {
    cmd: string;
    args?: string[];
    opts?: { cwd?: string };
  }) => {
    return runPromise(bashToolEffect(cmd, args, opts));
  },
});
