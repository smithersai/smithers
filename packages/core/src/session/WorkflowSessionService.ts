import { Effect } from "effect";
import type { WorkflowGraph } from "../graph.ts";
import type { TaskStateMap } from "../task-state/index.ts";
import type { ApprovalResolution } from "../durables/index.ts";
import type { ScheduleSnapshot } from "../scheduler/index.ts";
import type { EngineDecision } from "./EngineDecision.ts";
import type { TaskFailure } from "./TaskFailure.ts";
import type { TaskOutput } from "./TaskOutput.ts";

export type WorkflowSessionService = {
  readonly submitGraph: (graph: WorkflowGraph) => Effect.Effect<EngineDecision>;
  readonly taskCompleted: (output: TaskOutput) => Effect.Effect<EngineDecision>;
  readonly taskFailed: (failure: TaskFailure) => Effect.Effect<EngineDecision>;
  readonly approvalResolved: (
    nodeId: string,
    resolution: ApprovalResolution,
  ) => Effect.Effect<EngineDecision>;
  readonly approvalTimedOut: (nodeId: string) => Effect.Effect<EngineDecision>;
  readonly eventReceived: (
    eventName: string,
    payload: unknown,
    correlationId?: string | null,
  ) => Effect.Effect<EngineDecision>;
  readonly signalReceived: (
    signalName: string,
    payload: unknown,
    correlationId?: string | null,
  ) => Effect.Effect<EngineDecision>;
  readonly timerFired: (
    nodeId: string,
    firedAtMs?: number,
  ) => Effect.Effect<EngineDecision>;
  readonly hotReloaded: (graph: WorkflowGraph) => Effect.Effect<EngineDecision>;
  readonly heartbeatTimedOut: (
    nodeId: string,
    iteration?: number,
    details?: Record<string, unknown>,
  ) => Effect.Effect<EngineDecision>;
  readonly cacheResolved: (
    output: TaskOutput,
    cached: boolean,
  ) => Effect.Effect<EngineDecision>;
  readonly cacheMissed: (
    nodeId: string,
    iteration?: number,
  ) => Effect.Effect<EngineDecision>;
  readonly recoverOrphanedTasks: () => Effect.Effect<EngineDecision>;
  readonly cancelRequested: () => Effect.Effect<EngineDecision>;
  readonly getTaskStates: () => Effect.Effect<TaskStateMap>;
  readonly getSchedule: () => Effect.Effect<ScheduleSnapshot | null>;
  readonly getCurrentGraph: () => Effect.Effect<WorkflowGraph | null>;
};
