import type { ExtractOptions, WorkflowGraph } from "@smithers/graph";
import type { WorkflowElement } from "./WorkflowElement.ts";

export type WorkflowGraphRenderer = {
  render(
    element: WorkflowElement,
    opts?: ExtractOptions,
  ): Promise<WorkflowGraph> | WorkflowGraph;
};
