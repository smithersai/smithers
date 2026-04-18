import { readFile, writeFile } from "node:fs/promises";
import { applyPatch } from "diff";
import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { defineTool } from "./defineTool.js";
import {
  assertReadableFileWithinLimit,
  getToolRuntimeOptions,
  resolveToolPath,
  sha256Hex,
} from "./utils.js";

export async function editFileTool(path, patch) {
  const { rootDir, maxOutputBytes } = getToolRuntimeOptions();
  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > maxOutputBytes) {
    throw new SmithersError(
      "TOOL_PATCH_TOO_LARGE",
      `Patch too large (${patchBytes} bytes)`,
      { patchBytes, patchHash: sha256Hex(patch) },
    );
  }
  const resolved = await resolveToolPath(rootDir, path);
  await assertReadableFileWithinLimit(resolved, maxOutputBytes);
  const current = await readFile(resolved, "utf8");
  const updated = applyPatch(current, patch);
  if (updated === false) {
    throw new SmithersError("TOOL_PATCH_FAILED", "Failed to apply patch");
  }
  await writeFile(resolved, updated, { encoding: "utf8", flag: "w" });
  return "ok";
}

export const edit = defineTool({
  name: "edit",
  description: "Apply a unified diff patch to a file",
  schema: z.object({ path: z.string(), patch: z.string() }),
  sideEffect: true,
  idempotent: false,
  execute: async ({ path, patch }, _ctx) => editFileTool(path, patch),
});
