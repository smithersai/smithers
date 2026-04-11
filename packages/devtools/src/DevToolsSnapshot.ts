import type { DevToolsNode } from "./DevToolsNode.ts";

export type DevToolsSnapshot = {
  tree: DevToolsNode | null;
  nodeCount: number;
  taskCount: number;
  timestamp: number;
};
