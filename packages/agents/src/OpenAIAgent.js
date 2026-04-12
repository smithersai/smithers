import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, } from "ai";
import { resolveSdkModel } from "./resolveSdkModel.js";
import { streamResultToGenerateResult } from "./streamResultToGenerateResult.js";
/** @typedef {import("ai").AgentCallParameters} AgentCallParameters */

/**
 * @template CALL_OPTIONS, TOOLS
 * @typedef {AgentCallParameters<CALL_OPTIONS, TOOLS> & { onStdout?: (text: string) => void; onStderr?: (text: string) => void; onEvent?: (event: unknown) => Promise<void> | void; outputSchema?: import("zod").ZodTypeAny; resumeSession?: string; }} ExtendedGenerateArgs
 */
/** @typedef {import("ai").GenerateTextResult} GenerateTextResult */
/** @typedef {import("./OpenAIAgent.ts").OpenAIAgentOptions} OpenAIAgentOptions */

export class OpenAIAgent extends ToolLoopAgent {
    hijackEngine = "openai-sdk";
    /**
   * @param {OpenAIAgentOptions<CALL_OPTIONS, TOOLS>} opts
   */
    constructor(opts) {
        const { model, ...rest } = opts;
        super({
            ...rest,
            model: resolveSdkModel(model, openai),
        });
    }
    /**
   * @param {ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>} args
   * @returns {Promise<GenerateTextResult<TOOLS, never>>}
   */
    generate(args) {
        const promptArgs = "messages" in args
            ? { messages: args.messages }
            : { prompt: args.prompt };
        if (!args.onStdout) {
            return super.generate({
                options: args.options,
                abortSignal: args.abortSignal,
                ...promptArgs,
                timeout: args.timeout,
                onStepFinish: args.onStepFinish,
            });
        }
        return super.stream({
            options: args.options,
            abortSignal: args.abortSignal,
            ...promptArgs,
            timeout: args.timeout,
            onStepFinish: args.onStepFinish,
        }).then((stream) => streamResultToGenerateResult(stream, args.onStdout));
    }
}
