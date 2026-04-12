import { BaseCliAgent, type CliOutputInterpreter } from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";
import { type AgentCapabilityRegistry } from "./capability-registry";
type KimiAgentOptions = BaseCliAgentOptions & {
    workDir?: string;
    session?: string;
    continue?: boolean;
    thinking?: boolean;
    outputFormat?: "text" | "stream-json";
    finalMessageOnly?: boolean;
    quiet?: boolean;
    agent?: "default" | "okabe";
    agentFile?: string;
    mcpConfigFile?: string[];
    mcpConfig?: string[];
    skillsDir?: string;
    maxStepsPerTurn?: number;
    maxRetriesPerStep?: number;
    maxRalphIterations?: number;
    verbose?: boolean;
    debug?: boolean;
};
export declare function createKimiCapabilityRegistry(opts?: KimiAgentOptions): AgentCapabilityRegistry;
export declare class KimiAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry;
    readonly cliEngine = "kimi";
    private issuedSessionId?;
    constructor(opts?: KimiAgentOptions);
    protected createOutputInterpreter(): CliOutputInterpreter;
    protected buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "text" | "stream-json";
        env: Record<string, string> | undefined;
        cleanup: (() => Promise<void>) | undefined;
        stdoutBannerPatterns: RegExp[];
        stdoutErrorPatterns: RegExp[];
        errorOnBannerOnly: boolean;
    }>;
}
export {};
