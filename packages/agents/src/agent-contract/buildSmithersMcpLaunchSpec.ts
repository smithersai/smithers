import { existsSync } from "node:fs";
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
  let dir = dirname(fileURLToPath(import.meta.url));
  let cliEntryPath = "";
  while (true) {
    const candidate = resolve(dir, "apps/cli/src/index.ts");
    if (existsSync(candidate)) {
      cliEntryPath = candidate;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      cliEntryPath = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../../apps/cli/src/index.ts",
      );
      break;
    }
    dir = parent;
  }

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
