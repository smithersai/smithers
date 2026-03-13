import { tool, zodSchema } from "ai";
import * as FileSystem from "@effect/platform/FileSystem";
import { Effect } from "effect";
import { z } from "zod";
import { nowMs } from "../utils/time";
import { fromSync } from "../effect/interop";
import { runPromise } from "../effect/runtime";
import { resolveSandboxPath, assertPathWithinRootEffect } from "./utils";
import { getToolContext } from "./context";
import { logToolCallEffect, truncateToBytes } from "./logToolCall";

export function readToolEffect(path: string) {
  const ctx = getToolContext();
  const root = ctx?.rootDir ?? process.cwd();
  const started = nowMs();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* fromSync("resolve sandbox path", () =>
      resolveSandboxPath(root, path),
    );
    yield* assertPathWithinRootEffect(root, resolved);
    const max = ctx?.maxOutputBytes ?? 200_000;
    const stats = yield* fs.stat(resolved);
    if (Number(stats.size) > max) {
      throw new Error(`File too large (${stats.size} bytes)`);
    }
    const content = yield* fs.readFileString(resolved, "utf8");
    const output = truncateToBytes(content, max);
    yield* logToolCallEffect(
      "read",
      { path },
      { content: output },
      "success",
      undefined,
      started,
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
      logToolCallEffect("read", { path }, null, "error", error, started),
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
