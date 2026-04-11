import type { ExtractOptions, WorkflowGraph } from "@smithers/graph";

export type WorkflowGraphRenderer<Element> = {
  render(
    element: Element,
    opts?: ExtractOptions,
  ): Promise<WorkflowGraph> | WorkflowGraph;
};
