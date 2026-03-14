import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, type Output, type ToolSet } from "ai";
import { resolveSdkModel, type SdkAgentOptions } from "./sdk-shared";

export type OpenAIAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, OUTPUT, ReturnType<typeof openai>>;

export class OpenAIAgent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
> extends ToolLoopAgent<CALL_OPTIONS, TOOLS, OUTPUT> {
  constructor(opts: OpenAIAgentOptions<CALL_OPTIONS, TOOLS, OUTPUT>) {
    const { model, ...rest } = opts;
    super({
      ...rest,
      model: resolveSdkModel(model, openai),
    } as any);
  }
}
