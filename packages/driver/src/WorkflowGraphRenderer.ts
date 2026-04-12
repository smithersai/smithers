import type { JSX } from "smithers/jsx-runtime";
import type { ExtractOptions, WorkflowGraph } from "@smithers/graph";

export type WorkflowGraphRenderer = {
  render(
    element: JSX.Element,
    opts?: ExtractOptions,
  ): Promise<WorkflowGraph> | WorkflowGraph;
};
