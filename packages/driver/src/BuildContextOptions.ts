import type { RunAuthContext } from "./RunAuthContext.ts";
import type { OutputSnapshot } from "./OutputSnapshot.ts";
import type { SmithersRuntimeConfig } from "./SmithersRuntimeConfig.ts";

export type BuildContextOptions = {
  runId: string;
  iteration: number;
  iterations?: Record<string, number>;
  input: unknown;
  auth?: RunAuthContext | null;
  outputs: OutputSnapshot;
  zodToKeyName?: Map<any, string>;
  runtimeConfig?: SmithersRuntimeConfig;
};
