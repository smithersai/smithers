import { BaseCliAgent, type CliOutputInterpreter } from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";
import type { AgentCapabilityRegistry } from "./capability-registry";
/**
 * Configuration options for the AmpAgent.
 */
export type AmpAgentOptions = BaseCliAgentOptions & {
    /** Visibility setting for the new thread (e.g., private, public) */
    visibility?: "private" | "public" | "workspace" | "group";
    /** Path to a specific MCP configuration file */
    mcpConfig?: string;
    /** Path to a specific settings file */
    settingsFile?: string;
    /** Logging severity level */
    logLevel?: "error" | "warn" | "info" | "debug" | "audit";
    /** File path to write logs to */
    logFile?: string;
    /**
     * If true, dangerously allows all commands without asking for permission.
     * Equivalent to yolo mode but explicit.
     */
    dangerouslyAllowAll?: boolean;
    /** Whether to enable IDE integrations (disabled by default in AmpAgent) */
    ide?: boolean;
    /** Whether to enable JetBrains IDE integration */
    jetbrains?: boolean;
};
/**
 * Agent implementation that wraps the 'amp' CLI executable.
 * It translates generation requests into CLI arguments and executes the process.
 */
export declare class AmpAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry;
    readonly cliEngine = "amp";
    /**
     * Initializes a new AmpAgent with the given options.
     *
     * @param opts - Configuration options for the agent
     */
    constructor(opts?: AmpAgentOptions);
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
    }>;
}
