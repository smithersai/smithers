import { anthropic } from "@ai-sdk/anthropic";
import {
  ToolLoopAgent,
  type AgentCallParameters,
  type GenerateTextResult,
  type ToolSet,
} from "ai";
import {
  resolveSdkModel,
  streamResultToGenerateResult,
  type SdkAgentOptions,
} from "./sdk-shared";

export type AnthropicAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>;

type ExtendedGenerateArgs<
  CALL_OPTIONS,
  TOOLS extends ToolSet,
> = AgentCallParameters<CALL_OPTIONS, TOOLS> & {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  onEvent?: (event: unknown) => Promise<void> | void;
  outputSchema?: import("zod").ZodTypeAny;
  resumeSession?: string;
};

export class AnthropicAgent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> extends ToolLoopAgent<CALL_OPTIONS, TOOLS> {
  readonly hijackEngine = "anthropic-sdk";

  constructor(opts: AnthropicAgentOptions<CALL_OPTIONS, TOOLS>) {
    const { model, ...rest } = opts;
    super({
      ...rest,
      model: resolveSdkModel(model, anthropic),
    } as any);
  }

  generate(
    args: ExtendedGenerateArgs<CALL_OPTIONS, TOOLS>,
  ): Promise<GenerateTextResult<TOOLS, never>> {
    const promptArgs =
      "messages" in args
        ? { messages: args.messages }
        : { prompt: args.prompt };

    if (!args.onStdout) {
      return super.generate({
        options: args.options as CALL_OPTIONS,
        abortSignal: args.abortSignal,
        ...promptArgs,
        timeout: args.timeout,
        onStepFinish: args.onStepFinish,
      } as any);
    }

    return super.stream({
      options: args.options as CALL_OPTIONS,
      abortSignal: args.abortSignal,
      ...promptArgs,
      timeout: args.timeout,
      onStepFinish: args.onStepFinish,
    } as any).then((stream) => streamResultToGenerateResult(stream, args.onStdout));
  }
}
