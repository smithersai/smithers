import type { SmithersDevToolsOptions } from "./SmithersDevToolsOptions.ts";

export type DevToolsRunStoreOptions = Pick<
  SmithersDevToolsOptions,
  "onEngineEvent" | "verbose"
>;
