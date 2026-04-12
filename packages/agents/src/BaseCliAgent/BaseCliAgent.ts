import { Effect } from "effect";
import type { Agent, GenerateTextResult, StreamTextResult } from "ai";
import type { AgentCapabilityRegistry } from "../capability-registry";
import { SmithersError } from "@smithers/errors/SmithersError";
import type { BaseCliAgentOptions } from "./BaseCliAgentOptions";
import type { CliOutputInterpreter } from "./CliOutputInterpreter";
type CliCommandSpec = {
    command: string;
    args: string[];
    stdin?: string;
    outputFormat?: string;
    outputFile?: string;
    cleanup?: () => Promise<void>;
    env?: Record<string, string>;
    stdoutBannerPatterns?: RegExp[];
    stdoutErrorPatterns?: RegExp[];
    errorOnBannerOnly?: boolean;
};
export type CliUsageInfo = {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
};
export declare function runAgentPromise<A>(effect: Effect.Effect<A, SmithersError, never>): Promise<A>;
export declare function extractUsageFromOutput(raw: string): CliUsageInfo | undefined;
export declare abstract class BaseCliAgent implements Agent<any, any, any> {
    readonly version: "agent-v1";
    readonly tools: Record<string, never>;
    readonly capabilities?: AgentCapabilityRegistry;
    readonly id: string;
    protected readonly model?: string;
    protected readonly systemPrompt?: string;
    protected readonly cwd?: string;
    protected readonly env?: Record<string, string>;
    protected readonly yolo: boolean;
    protected readonly timeoutMs?: number;
    protected readonly idleTimeoutMs?: number;
    protected readonly maxOutputBytes?: number;
    protected readonly extraArgs?: string[];
    constructor(opts: BaseCliAgentOptions);
    private runGenerateEffect;
    generate(options: any): Promise<GenerateTextResult<any, any>>;
    stream(options: any): Promise<StreamTextResult<any, any>>;
    protected createOutputInterpreter(): CliOutputInterpreter | undefined;
    protected abstract buildCommand(params: {
        prompt: string;
        systemPrompt?: string;
        cwd: string;
        options: any;
    }): Promise<CliCommandSpec>;
}
export {};
