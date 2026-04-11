import type {
  ToolLoopAgentSettings,
  ToolSet,
} from "ai";

export type SdkAgentOptions<
  CALL_OPTIONS = never,
  TOOLS extends ToolSet = {},
  MODEL = any,
> = Omit<ToolLoopAgentSettings<CALL_OPTIONS, TOOLS>, "model"> & {
  /**
   * Either a provider model id string or a preconstructed AI SDK language model.
   * Passing a model instance is mainly useful for tests and advanced provider setup.
   */
  model: string | MODEL;
};
