
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @returns {{ nodes: number; tasks: number }}
 */
export function countNodes(node) {
    let nodes = 1;
    let tasks = node.type === "task" ? 1 : 0;
    for (const child of node.children) {
        const c = countNodes(child);
        nodes += c.nodes;
        tasks += c.tasks;
    }
    return { nodes, tasks };
}
