import type { DevToolsNode } from "./DevToolsNode.ts";
import type { DevToolsSnapshot } from "./DevToolsSnapshot.ts";
import { countNodes } from "./countNodes.ts";

export function buildSnapshot(root: DevToolsNode | null): DevToolsSnapshot {
  if (!root) {
    return { tree: null, nodeCount: 0, taskCount: 0, timestamp: Date.now() };
  }
  const { nodes, tasks } = countNodes(root);
  return { tree: root, nodeCount: nodes, taskCount: tasks, timestamp: Date.now() };
}
