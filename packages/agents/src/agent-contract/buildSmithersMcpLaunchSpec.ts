import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SmithersToolSurface } from "./SmithersToolSurface";

export type SmithersMcpLaunchSpec = {
  command: string;
  args: string[];
};

export function buildSmithersMcpLaunchSpec(
  toolSurface: SmithersToolSurface = "semantic",
): SmithersMcpLaunchSpec {
  const cliEntryPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");
  return {
    command: process.execPath,
    args: [
      "run",
      cliEntryPath,
      "--mcp",
      "--surface",
      toolSurface,
    ],
  };
}
