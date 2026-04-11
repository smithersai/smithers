import type { SmithersToolSurface } from "./SmithersToolSurface";
import type { SmithersAgentContractTool } from "./SmithersAgentContractTool";

export type SmithersAgentContract = {
  toolSurface: SmithersToolSurface;
  serverName: string;
  tools: SmithersAgentContractTool[];
  promptGuidance: string;
  docsGuidance: string;
};
