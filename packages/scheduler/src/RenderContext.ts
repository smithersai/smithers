import type { WorkflowGraph } from "@smithers-orchestrator/graph";
import type { TaskOutput } from "./TaskOutput.ts";

export type RenderContext = {
  readonly runId: string;
  readonly graph?: WorkflowGraph | null;
  readonly iteration?: number;
  readonly iterations?: Record<string, number> | ReadonlyMap<string, number>;
  readonly input?: unknown;
  readonly outputs?: Record<string, unknown[]> | ReadonlyMap<string, TaskOutput>;
  readonly auth?: unknown;
  readonly taskStates?: unknown;
  readonly ralphIterations?: ReadonlyMap<string, number>;
};
