export type { RunState } from "./runState/RunState.ts";
export type { RunStateView } from "./runState/RunStateView.ts";

import type { DeriveRunStateInput } from "./runState/DeriveRunStateInput.ts";
import type { RunStateView } from "./runState/RunStateView.ts";

export type ComputeRunStateOptions = {
  now?: number;
  staleThresholdMs?: number;
};

export declare const RUN_STATE_HEARTBEAT_STALE_MS: number;
export declare function deriveRunState(input: DeriveRunStateInput): RunStateView;
export declare function computeRunState(
  adapter: unknown,
  runId: string,
  options?: ComputeRunStateOptions,
): Promise<RunStateView>;
export declare function computeRunStateFromRow(
  adapter: unknown,
  run: unknown,
  options?: ComputeRunStateOptions,
): Promise<RunStateView>;
