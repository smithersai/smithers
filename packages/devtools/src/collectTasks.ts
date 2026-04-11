import type { DevToolsNode } from "./DevToolsNode.ts";

export function collectTasks(
  node: DevToolsNode,
  out: DevToolsNode[] = [],
): DevToolsNode[] {
  if (node.type === "task") out.push(node);
  for (const child of node.children) {
    collectTasks(child, out);
  }
  return out;
}
