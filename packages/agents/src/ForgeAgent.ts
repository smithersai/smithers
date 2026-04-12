import { BaseCliAgent, type CliOutputInterpreter } from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";
import type { AgentCapabilityRegistry } from "./capability-registry";
type ForgeAgentOptions = BaseCliAgentOptions & {
    directory?: string;
    provider?: string;
    agent?: string;
    conversationId?: string;
    sandbox?: string;
    restricted?: boolean;
    verbose?: boolean;
    workflow?: string;
    event?: string;
    conversation?: string;
};
export declare class ForgeAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry;
    readonly cliEngine = "forge";
    private issuedConversationId?;
    constructor(opts?: ForgeAgentOptions);
    protected createOutputInterpreter(): CliOutputInterpreter;
    protected buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "text";
    }>;
}
export {};
