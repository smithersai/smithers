import { type CliOutputInterpreter, BaseCliAgent } from "./BaseCliAgent";
import type { BaseCliAgentOptions, CodexConfigOverrides } from "./BaseCliAgent";
import { type AgentCapabilityRegistry } from "./capability-registry";
type CodexAgentOptions = BaseCliAgentOptions & {
    config?: CodexConfigOverrides;
    enable?: string[];
    disable?: string[];
    image?: string[];
    model?: string;
    oss?: boolean;
    localProvider?: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    profile?: string;
    fullAuto?: boolean;
    dangerouslyBypassApprovalsAndSandbox?: boolean;
    cd?: string;
    skipGitRepoCheck?: boolean;
    addDir?: string[];
    outputSchema?: string;
    color?: "always" | "never" | "auto";
    json?: boolean;
    outputLastMessage?: string;
};
export declare function createCodexCapabilityRegistry(opts?: CodexAgentOptions): AgentCapabilityRegistry;
export declare class CodexAgent extends BaseCliAgent {
    private readonly opts;
    readonly capabilities: AgentCapabilityRegistry;
    readonly cliEngine = "codex";
    constructor(opts?: CodexAgentOptions);
    protected createOutputInterpreter(): CliOutputInterpreter;
    protected buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<{
        command: string;
        args: string[];
        stdin: string;
        outputFile: string;
        outputFormat: "stream-json";
        stdoutBannerPatterns: RegExp[];
        cleanup: () => Promise<void>;
    }>;
}
export {};
