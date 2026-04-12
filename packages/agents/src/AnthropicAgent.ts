import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, type AgentCallParameters, type GenerateTextResult, type ToolSet } from "ai";
import type { SdkAgentOptions } from "./SdkAgentOptions";
export type AnthropicAgentOptions<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>;
type ExtendedGenerateArgs<CALL_OPTIONS, TOOLS extends ToolSet> = AgentCallParameters<CALL_OPTIONS, TOOLS> & {
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
    onEvent?: (event: unknown) => Promise<void> | void;
    outputSchema?: import("zod").ZodTypeAny;
    resumeSession?: string;
};
export declare class AnthropicAgent<CALL_OPTIONS = never, TOOLS extends ToolSet = {}> extends ToolLoopAgent<CALL_OPTIONS, TOOLS> {
    readonly hijackEngine = "anthropic-sdk";
    constructor(opts: AnthropicAgentOptions<CALL_OPTIONS, TOOLS>);
    generate(args: ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>): Promise<GenerateTextResult<TOOLS, never>>;
}
export {};
