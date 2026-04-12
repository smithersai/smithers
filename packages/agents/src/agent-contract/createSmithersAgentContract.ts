import type { SmithersToolSurface } from "./SmithersToolSurface";
import type { SmithersAgentContract } from "./SmithersAgentContract";
import type { SmithersListedTool } from "./SmithersListedTool";
type CreateSmithersAgentContractOptions = {
    toolSurface?: SmithersToolSurface;
    serverName?: string;
    tools: SmithersListedTool[];
};
export declare function createSmithersAgentContract(options: CreateSmithersAgentContractOptions): SmithersAgentContract;
export {};
