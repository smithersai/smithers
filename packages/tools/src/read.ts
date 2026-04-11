import { tool, zodSchema } from "ai";
import * as FileSystem from "@effect/platform/FileSystem";
import { Effect, Metric } from "effect";
import { z } from "zod";
import { nowMs } from "@smithers/scheduler/nowMs";
import { fromSync } from "@smithers/runtime/interop";
import { runPromise } from "@smithers/runtime/runtime";
import { resolveSandboxPath, assertPathWithinRootEffect } from "./utils";
import { getToolContext } from "./context";
import { SmithersError } from "@smithers/errors/SmithersError";
import { toolOutputTruncatedTotal } from "@smithers/observability/metrics";
import {
  logToolCallEffect,
  logToolCallStartEffect,
  truncateToBytes,
} from "./logToolCall";

export function readToolEffect(path: string) {
  const ctx = getToolContext();
  const root = ctx?.rootDir ?? process.cwd();
  const started = nowMs();
  let seq: number | undefined;
  return Effect.gen(function* () {
    seq = yield* logToolCallStartEffect("read", started);
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* fromSync("resolve sandbox path", () =>
      resolveSandboxPath(root, path),
    );
    yield* assertPathWithinRootEffect(root, resolved);
    const max = ctx?.maxOutputBytes ?? 200_000;
    const stats = yield* fs.stat(resolved);
    if (Number(stats.size) > max) {
      throw new SmithersError("TOOL_FILE_TOO_LARGE", `File too large (${stats.size} bytes)`);
    }
    const content = yield* fs.readFileString(resolved, "utf8");
    const output = truncateToBytes(content, max);
    if (Buffer.byteLength(content, "utf8") > max) {
      yield* Metric.increment(toolOutputTruncatedTotal);
    }
    yield* logToolCallEffect(
      "read",
      { path },
      { content: output },
      "success",
      undefined,
      started,
      seq,
    );
    return output;
  }).pipe(
    Effect.annotateLogs({
      toolName: "read",
      toolPath: path,
      rootDir: root,
    }),
    Effect.withLogSpan("tool:read"),
    Effect.tapError((error) =>
      logToolCallEffect("read", { path }, null, "error", error, started, seq),
    ),
  );
}

export const read: any = tool({
  description: "Read a file",
  inputSchema: zodSchema(z.object({ path: z.string() })),
  execute: async ({ path }: { path: string }) => {
    return runPromise(readToolEffect(path));
  },
});
