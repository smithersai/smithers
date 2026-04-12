
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @param {DevToolsNode[]} [out]
 * @returns {DevToolsNode[]}
 */
export function collectTasks(node, out = []) {
    if (node.type === "task")
        out.push(node);
    for (const child of node.children) {
        collectTasks(child, out);
    }
    return out;
}
