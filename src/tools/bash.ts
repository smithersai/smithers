import { tool, zodSchema } from "ai";
import { Effect } from "effect";
import { z } from "zod";
import { nowMs } from "../utils/time";
import { spawnCaptureEffect } from "../effect/child-process";
import { fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { resolveSandboxPath, assertPathWithinRootEffect } from "./utils";
import { getToolContext } from "./context";
import { SmithersError } from "../utils/errors";
import {
  logToolCallEffect,
  logToolCallStartEffect,
  truncateToBytes,
} from "./logToolCall";

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
    const result = yield* spawnCaptureEffect(cmd, args ?? [], {
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
