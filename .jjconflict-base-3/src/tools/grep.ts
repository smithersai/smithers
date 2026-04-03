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
import { logToolCallEffect, logToolCallStartEffect } from "./logToolCall";

export function grepToolEffect(pattern: string, path?: string) {
  const ctx = getToolContext();
  const root = ctx?.rootDir ?? process.cwd();
  const started = nowMs();
  let seq: number | undefined;
  return Effect.gen(function* () {
    seq = yield* logToolCallStartEffect("grep", started);
    const resolvedRoot = yield* fromSync("resolve sandbox path", () =>
      resolveSandboxPath(root, path ?? "."),
    );
    yield* assertPathWithinRootEffect(root, resolvedRoot);
    const max = ctx?.maxOutputBytes ?? 200_000;
    const timeoutMs = ctx?.timeoutMs ?? 60_000;
    const result = yield* spawnCaptureEffect(
      "rg",
      ["-n", pattern, resolvedRoot],
      {
        cwd: root,
        detached: true,
        maxOutputBytes: max,
        timeoutMs,
      },
    );
    const logOutput = { output: result.stdout, stderr: result.stderr };
    if (result.exitCode === 2) {
      throw new SmithersError("TOOL_GREP_FAILED", result.stderr || "rg failed");
    }
    yield* logToolCallEffect(
      "grep",
      { pattern, path },
      logOutput,
      "success",
      undefined,
      started,
      seq,
    );
    return result.stdout;
  }).pipe(
    Effect.annotateLogs({
      toolName: "grep",
      pattern,
      toolPath: path ?? ".",
      rootDir: root,
    }),
    Effect.withLogSpan("tool:grep"),
    Effect.tapError((error) =>
      logToolCallEffect(
        "grep",
        { pattern, path },
        null,
        "error",
        error,
        started,
        seq,
      ),
    ),
  );
}

export const grep = tool({
  description: "Search for a pattern in files",
  inputSchema: zodSchema(
    z.object({ pattern: z.string(), path: z.string().optional() }),
  ),
  execute: async ({ pattern, path }: { pattern: string; path?: string }) => {
    return runPromise(grepToolEffect(pattern, path));
  },
});
