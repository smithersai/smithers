import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SmithersToolSurface } from "./SmithersToolSurface";
import { buildSmithersMcpLaunchSpec } from "./buildSmithersMcpLaunchSpec";

const DEFAULT_SERVER_NAME = "smithers";

export function buildSmithersMcpConfigFile(
  toolSurface: SmithersToolSurface = "semantic",
  serverName = DEFAULT_SERVER_NAME,
) {
  const dir = mkdtempSync(join(tmpdir(), "smithers-ask-"));
  const configPath = join(dir, "mcp.json");
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  const contents = {
    mcpServers: {
      [serverName]: {
        command: launchSpec.command,
        args: launchSpec.args,
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(contents, null, 2));

  return {
    dir,
    path: configPath,
    contents,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
