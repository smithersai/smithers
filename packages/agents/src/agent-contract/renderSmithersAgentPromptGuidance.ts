import type { SmithersAgentContract } from "./SmithersAgentContract";
type RenderGuidanceOptions = {
    available?: boolean;
    toolNamePrefix?: string;
};
export declare function renderSmithersAgentPromptGuidance(contract: SmithersAgentContract, options?: RenderGuidanceOptions): string;
export {};
