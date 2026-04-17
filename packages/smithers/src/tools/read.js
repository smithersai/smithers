import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "./defineTool.js";
import {
  assertReadableFileWithinLimit,
  getToolRuntimeOptions,
  resolveToolPath,
  truncateToBytes,
} from "./utils.js";

export async function readFileTool(path) {
  const { rootDir, maxOutputBytes } = getToolRuntimeOptions();
  const resolved = await resolveToolPath(rootDir, path);
  await assertReadableFileWithinLimit(resolved, maxOutputBytes);
  const content = await readFile(resolved, "utf8");
  return truncateToBytes(content, maxOutputBytes);
}

export const read = defineTool({
  name: "read",
  description: "Read a file",
  schema: z.object({ path: z.string() }),
  execute: async ({ path }) => readFileTool(path),
});
