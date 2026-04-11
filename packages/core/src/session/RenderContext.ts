import type { WorkflowGraph } from "../graph.ts";
import type { TaskStateMap } from "../task-state/index.ts";
import type { TaskOutput } from "./TaskOutput.ts";

export type RenderContext = {
  readonly runId: string;
  readonly graph: WorkflowGraph | null;
  readonly iteration?: number;
  readonly taskStates: TaskStateMap;
  readonly outputs: ReadonlyMap<string, TaskOutput>;
  readonly ralphIterations: ReadonlyMap<string, number>;
};
