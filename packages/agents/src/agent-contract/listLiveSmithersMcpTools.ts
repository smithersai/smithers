import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SmithersError } from "@smithers/core/errors";
import type { SmithersToolSurface } from "./SmithersToolSurface";
import type { SmithersListedTool } from "./SmithersListedTool";
import { buildSmithersMcpLaunchSpec } from "./buildSmithersMcpLaunchSpec";

type ProbeSmithersAgentContractOptions = {
  toolSurface?: SmithersToolSurface;
  serverName?: string;
  cwd?: string;
};

export async function listLiveSmithersMcpTools(
  options: ProbeSmithersAgentContractOptions = {},
): Promise<SmithersListedTool[]> {
  const toolSurface = options.toolSurface ?? "semantic";
  const launchSpec = buildSmithersMcpLaunchSpec(toolSurface);
  const transport = new StdioClientTransport({
    command: launchSpec.command,
    args: launchSpec.args,
    cwd: options.cwd ?? process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({
    name: "smithers-agent-contract-probe",
    version: "1.0.0",
  });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  } catch (error: any) {
    throw new SmithersError(
      "ASK_BOOTSTRAP_FAILED",
      `Failed to probe the live Smithers MCP tools: ${error?.message ?? String(error)}`,
      {
        cwd: options.cwd ?? process.cwd(),
        toolSurface,
        command: launchSpec.command,
        args: launchSpec.args,
      },
    );
  } finally {
    try {
      await client.close();
    } catch {}
    try {
      await transport.close();
    } catch {}
  }
}
