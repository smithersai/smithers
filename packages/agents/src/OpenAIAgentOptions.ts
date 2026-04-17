import type { openai } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import type { SdkAgentOptions } from "./SdkAgentOptions";

export type OpenAIAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
> = SdkAgentOptions<CALL_OPTIONS, TOOLS, ReturnType<typeof openai>>;
