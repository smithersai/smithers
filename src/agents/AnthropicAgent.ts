import { anthropic } from "@ai-sdk/anthropic";
import { ToolLoopAgent, type Output, type ToolSet } from "ai";
import { resolveSdkModel, type SdkAgentOptions } from "./sdk-shared";

export type AnthropicAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, OUTPUT, ReturnType<typeof anthropic>>;

export class AnthropicAgent<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
> extends ToolLoopAgent<CALL_OPTIONS, TOOLS, OUTPUT> {
  constructor(opts: AnthropicAgentOptions<CALL_OPTIONS, TOOLS, OUTPUT>) {
    const { model, ...rest } = opts;
    super({
      ...rest,
      model: resolveSdkModel(model, anthropic),
    } as any);
  }
}
