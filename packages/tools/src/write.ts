import { tool, zodSchema } from "ai";
import * as FileSystem from "@effect/platform/FileSystem";
import { Effect } from "effect";
import { z } from "zod";
import { dirname } from "node:path";
import { nowMs } from "@smithers/scheduler/nowMs";
import { sha256Hex } from "@smithers/driver/sha256Hex";
import { fromSync } from "@smithers/runtime/interop";
import { runPromise } from "@smithers/runtime/runtime";
import { resolveSandboxPath, assertPathWithinRootEffect } from "./utils";
import { getToolContext } from "./context";
import { SmithersError } from "@smithers/errors/SmithersError";
import { logToolCallEffect, logToolCallStartEffect } from "./logToolCall";

export function writeToolEffect(path: string, content: string) {
  const ctx = getToolContext();
  const root = ctx?.rootDir ?? process.cwd();
  const started = nowMs();
  const max = ctx?.maxOutputBytes ?? 200_000;
  const contentBytes = Buffer.byteLength(content, "utf8");
  const logInput = { path, contentBytes, contentHash: sha256Hex(content) };
  let seq: number | undefined;
  return Effect.gen(function* () {
    seq = yield* logToolCallStartEffect("write", started);
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* fromSync("resolve sandbox path", () =>
      resolveSandboxPath(root, path),
    );
    yield* assertPathWithinRootEffect(root, resolved);
    if (contentBytes > max) {
      throw new SmithersError("TOOL_CONTENT_TOO_LARGE", `Content too large (${contentBytes} bytes)`);
    }
    yield* fs.makeDirectory(dirname(resolved), { recursive: true });
    yield* fs.writeFileString(resolved, content, { flag: "w" });
    yield* logToolCallEffect(
      "write",
      logInput,
      { ok: true },
      "success",
      undefined,
      started,
      seq,
    );
    return "ok";
  }).pipe(
    Effect.annotateLogs({
      toolName: "write",
      toolPath: path,
      rootDir: root,
      contentBytes,
    }),
    Effect.withLogSpan("tool:write"),
    Effect.tapError((error) =>
      logToolCallEffect("write", logInput, null, "error", error, started, seq),
    ),
  );
}

export const write = tool({
  description: "Write a file",
  inputSchema: zodSchema(z.object({ path: z.string(), content: z.string() })),
  execute: async ({ path, content }: { path: string; content: string }) => {
    return runPromise(writeToolEffect(path, content));
  },
});
