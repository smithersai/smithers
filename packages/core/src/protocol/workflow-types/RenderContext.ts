import type { WorkflowGraph } from "@smithers/graph/types";
import type { TaskOutput } from "./TaskOutput";

export type RenderContext = {
  readonly runId: string;
  readonly iteration?: number;
  readonly iterations?: Record<string, number> | ReadonlyMap<string, number>;
  readonly input?: unknown;
  readonly outputs?: Record<string, unknown[]> | ReadonlyMap<string, TaskOutput>;
  readonly auth?: unknown;
  readonly graph?: WorkflowGraph | null;
  readonly taskStates?: unknown;
  readonly ralphIterations?: ReadonlyMap<string, number>;
};
