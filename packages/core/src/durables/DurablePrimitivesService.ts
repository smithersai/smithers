import { Effect } from "effect";
import type { ApprovalResolution } from "./ApprovalResolution.ts";
import type { TimerRequest } from "./TimerRequest.ts";
import type { ContinueAsNewTransition } from "./ContinueAsNewTransition.ts";

export type DurablePrimitivesService = {
  readonly resolveApproval: (
    nodeId: string,
    resolution: ApprovalResolution,
  ) => Effect.Effect<ApprovalResolution>;
  readonly receiveEvent: (
    eventName: string,
    payload: unknown,
  ) => Effect.Effect<{ readonly eventName: string; readonly payload: unknown }>;
  readonly createTimer: (request: TimerRequest) => Effect.Effect<TimerRequest>;
  readonly continueAsNew: (
    transition: ContinueAsNewTransition,
  ) => Effect.Effect<ContinueAsNewTransition>;
};
