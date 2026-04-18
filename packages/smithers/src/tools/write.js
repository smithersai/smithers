import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { defineTool } from "./defineTool.js";
import {
  ensureParentDir,
  getToolRuntimeOptions,
  resolveToolPath,
  sha256Hex,
} from "./utils.js";

export async function writeFileTool(path, content) {
  const { rootDir, maxOutputBytes } = getToolRuntimeOptions();
  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > maxOutputBytes) {
    throw new SmithersError(
      "TOOL_CONTENT_TOO_LARGE",
      `Content too large (${contentBytes} bytes)`,
      { contentBytes, contentHash: sha256Hex(content) },
    );
  }
  const resolved = await resolveToolPath(rootDir, path);
  await ensureParentDir(resolved);
  await writeFile(resolved, content, { encoding: "utf8", flag: "w" });
  return "ok";
}

export const write = defineTool({
  name: "write",
  description: "Write a file",
  schema: z.object({ path: z.string(), content: z.string() }),
  sideEffect: true,
  idempotent: false,
  execute: async ({ path, content }, _ctx) => writeFileTool(path, content),
});
