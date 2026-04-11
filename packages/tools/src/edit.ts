import { tool, zodSchema } from "ai";
import * as FileSystem from "@effect/platform/FileSystem";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { z } from "zod";
import { applyPatch } from "diff";
import { nowMs } from "@smithers/scheduler/nowMs";
import { sha256Hex } from "@smithers/driver/sha256Hex";
import { fromSync } from "@smithers/driver/interop";
import { resolveSandboxPath, assertPathWithinRootEffect } from "./utils";
import { getToolContext } from "./context";
import { SmithersError } from "@smithers/errors/SmithersError";
import { logToolCallEffect, logToolCallStartEffect } from "./logToolCall";

export function editToolEffect(path: string, patch: string) {
  const ctx = getToolContext();
  const root = ctx?.rootDir ?? process.cwd();
  const started = nowMs();
  const max = ctx?.maxOutputBytes ?? 200_000;
  const patchBytes = Buffer.byteLength(patch, "utf8");
  const logInput = { path, patchBytes, patchHash: sha256Hex(patch) };
  let seq: number | undefined;
  return Effect.gen(function* () {
    seq = yield* logToolCallStartEffect("edit", started);
    const fs = yield* FileSystem.FileSystem;
    const resolved = yield* fromSync("resolve sandbox path", () =>
      resolveSandboxPath(root, path),
    );
    yield* assertPathWithinRootEffect(root, resolved);
    if (patchBytes > max) {
      throw new SmithersError("TOOL_PATCH_TOO_LARGE", `Patch too large (${patchBytes} bytes)`);
    }
    const stats = yield* fs.stat(resolved);
    if (Number(stats.size) > max) {
      throw new SmithersError("TOOL_FILE_TOO_LARGE", `File too large (${stats.size} bytes)`);
    }
    const current = yield* fs.readFileString(resolved, "utf8");
    const updated = yield* fromSync("apply unified diff patch", () =>
      applyPatch(current, patch),
    );
    if (updated === false) {
      throw new SmithersError("TOOL_PATCH_FAILED", "Failed to apply patch");
    }
    yield* fs.writeFileString(resolved, updated, { flag: "w" });
    yield* logToolCallEffect(
      "edit",
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
      toolName: "edit",
      toolPath: path,
      rootDir: root,
      patchBytes,
    }),
    Effect.withLogSpan("tool:edit"),
    Effect.tapError((error) =>
      logToolCallEffect("edit", logInput, null, "error", error, started, seq),
    ),
  );
}

export const edit = tool({
  description: "Apply a unified diff patch to a file",
  inputSchema: zodSchema(z.object({ path: z.string(), patch: z.string() })),
  execute: async ({ path, patch }: { path: string; patch: string }) => {
    return Effect.runPromise(
      editToolEffect(path, patch).pipe(Effect.provide(BunFileSystem.layer)),
    );
  },
});
