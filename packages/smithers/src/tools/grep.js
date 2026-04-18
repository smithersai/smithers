import { z } from "zod";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { defineTool } from "./defineTool.js";
import {
  captureProcess,
  getToolRuntimeOptions,
  resolveToolPath,
} from "./utils.js";

export async function grepTool(pattern, path = ".") {
  const { rootDir, maxOutputBytes, timeoutMs } = getToolRuntimeOptions();
  const resolvedRoot = await resolveToolPath(rootDir, path);
  const result = await captureProcess("rg", ["-n", pattern, resolvedRoot], {
    cwd: rootDir,
    detached: true,
    maxOutputBytes,
    timeoutMs,
  });
  if (result.exitCode === 2) {
    throw new SmithersError(
      "TOOL_GREP_FAILED",
      result.stderr || "rg failed",
    );
  }
  return result.stdout;
}

export const grep = defineTool({
  name: "grep",
  description: "Search for a pattern in files",
  schema: z.object({ pattern: z.string(), path: z.string().optional() }),
  execute: async ({ pattern, path }) => grepTool(pattern, path),
});
