import type { SmithersToolSurface } from "./SmithersToolSurface";
import type { SmithersMcpLaunchSpec } from "./SmithersMcpLaunchSpec";
import { resolveSmithersCliEntryPath } from "./resolveSmithersCliEntryPath";

export function buildSmithersMcpLaunchSpec(
  toolSurface: SmithersToolSurface = "semantic",
): SmithersMcpLaunchSpec {
  return {
    command: process.execPath,
    args: [
      "run",
      resolveSmithersCliEntryPath(),
      "--mcp",
      "--surface",
      toolSurface,
    ],
  };
}
