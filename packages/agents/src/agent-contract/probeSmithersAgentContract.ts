import type { SmithersToolSurface } from "./SmithersToolSurface";
import { listLiveSmithersMcpTools } from "./listLiveSmithersMcpTools";
import { createSmithersAgentContract } from "./createSmithersAgentContract";

type ProbeSmithersAgentContractOptions = {
  toolSurface?: SmithersToolSurface;
  serverName?: string;
  cwd?: string;
};

export async function probeSmithersAgentContract(
  options: ProbeSmithersAgentContractOptions = {},
) {
  const tools = await listLiveSmithersMcpTools(options);
  return createSmithersAgentContract({
    toolSurface: options.toolSurface,
    serverName: options.serverName,
    tools,
  });
}
