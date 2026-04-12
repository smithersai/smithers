import { BaseCliAgent, type CliOutputInterpreter } from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";
import { type AgentCapabilityRegistry } from "./capability-registry";
type ClaudeCodeAgentOptions = BaseCliAgentOptions & {
    addDir?: string[];
    agent?: string;
    agents?: Record<string, {
        description?: string;
        prompt?: string;
    }> | string;
    allowDangerouslySkipPermissions?: boolean;
    allowedTools?: string[];
    appendSystemPrompt?: string;
    betas?: string[];
    chrome?: boolean;
    continue?: boolean;
    dangerouslySkipPermissions?: boolean;
    debug?: boolean | string;
    debugFile?: string;
    disableSlashCommands?: boolean;
    disallowedTools?: string[];
    fallbackModel?: string;
    file?: string[];
    forkSession?: boolean;
    fromPr?: string;
    ide?: boolean;
    includePartialMessages?: boolean;
    inputFormat?: "text" | "stream-json";
    jsonSchema?: string;
    maxBudgetUsd?: number;
    mcpConfig?: string[];
    mcpDebug?: boolean;
    model?: string;
    noChrome?: boolean;
    noSessionPersistence?: boolean;
    outputFormat?: "text" | "json" | "stream-json";
    permissionMode?: "acceptEdits" | "bypassPermissions" | "default" | "delegate" | "dontAsk" | "plan";
    pluginDir?: string[];
    replayUserMessages?: boolean;
    resume?: string;
    sessionId?: string;
    settingSources?: string;
    settings?: string;
    strictMcpConfig?: boolean;
    systemPrompt?: string;
    tools?: string[] | "default" | "";
    verbose?: boolean;
};
export declare function createClaudeCodeCapabilityRegistry(opts?: ClaudeCodeAgentOptions): AgentCapabilityRegistry;
export declare class ClaudeCodeAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry;
    readonly cliEngine = "claude-code";
    constructor(opts?: ClaudeCodeAgentOptions);
    protected createOutputInterpreter(): CliOutputInterpreter;
    protected buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        outputFormat: "text" | "json" | "stream-json";
    }>;
}
export {};
