import type { Output, ToolLoopAgentSettings, ToolSet } from "ai";

export type SdkAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  OUTPUT extends Output = never,
  MODEL = any,
> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS, OUTPUT>, "model"> & {
  /**
   * Either a provider model id string or a preconstructed AI SDK language model.
   * Passing a model instance is mainly useful for tests and advanced provider setup.
   */
  model: string | MODEL;
};

export function resolveSdkModel<MODEL>(
  value: string | MODEL,
  create: (modelId: string) => MODEL,
): MODEL {
  return typeof value === "string" ? create(value) : value;
}
