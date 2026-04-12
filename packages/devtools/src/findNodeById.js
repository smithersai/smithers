
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/**
 * @param {DevToolsNode} node
 * @param {string} nodeId
 * @returns {DevToolsNode | null}
 */
export function findNodeById(node, nodeId) {
    if (node.task?.nodeId === nodeId)
        return node;
    for (const child of node.children) {
        const found = findNodeById(child, nodeId);
        if (found)
            return found;
    }
    return null;
}
