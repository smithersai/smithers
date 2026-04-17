import type { ReasonBlocked } from "./ReasonBlocked.ts";
import type { ReasonUnhealthy } from "./ReasonUnhealthy.ts";
import type { RunState } from "./RunState.ts";

export type RunStateView = {
  runId: string;
  state: RunState;
  blocked?: ReasonBlocked;
  unhealthy?: ReasonUnhealthy;
  computedAt: string;
};
