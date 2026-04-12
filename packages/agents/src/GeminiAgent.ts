import { BaseCliAgent, type CliOutputInterpreter } from "./BaseCliAgent";
import type { BaseCliAgentOptions } from "./BaseCliAgent";
import { type AgentCapabilityRegistry } from "./capability-registry";
type GeminiAgentOptions = BaseCliAgentOptions & {
    debug?: boolean;
    model?: string;
    sandbox?: boolean;
    yolo?: boolean;
    approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
    experimentalAcp?: boolean;
    allowedMcpServerNames?: string[];
    allowedTools?: string[];
    extensions?: string[];
    listExtensions?: boolean;
    resume?: string;
    listSessions?: boolean;
    deleteSession?: string;
    includeDirectories?: string[];
    screenReader?: boolean;
    outputFormat?: "text" | "json" | "stream-json";
};
export declare function createGeminiCapabilityRegistry(opts?: GeminiAgentOptions): AgentCapabilityRegistry;
export declare class GeminiAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry;
    readonly cliEngine = "gemini";
    constructor(opts?: GeminiAgentOptions);
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
