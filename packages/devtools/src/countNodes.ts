import type { DevToolsNode } from "./DevToolsNode.ts";

export function countNodes(node: DevToolsNode): { nodes: number; tasks: number } {
  let nodes = 1;
  let tasks = node.type === "task" ? 1 : 0;
  for (const child of node.children) {
    const c = countNodes(child);
    nodes += c.nodes;
    tasks += c.tasks;
  }
  return { nodes, tasks };
}
