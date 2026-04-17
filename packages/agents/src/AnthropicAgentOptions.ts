import type { anthropic } from "@ai-sdk/anthropic";
import type { ToolSet } from "ai";
import type { SdkAgentOptions } from "./SdkAgentOptions";

export type AnthropicAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof anthropic>>;
