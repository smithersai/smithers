import type { DevToolsNode } from "./DevToolsNode.ts";

export function findNodeById(
  node: DevToolsNode,
  nodeId: string,
): DevToolsNode | null {
  if (node.task?.nodeId === nodeId) return node;
  for (const child of node.children) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}
