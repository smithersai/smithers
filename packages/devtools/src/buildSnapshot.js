import { countNodes } from "./countNodes.js";
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./DevToolsSnapshot.ts").DevToolsSnapshot} DevToolsSnapshot */

/**
 * @param {DevToolsNode | null} root
 * @returns {DevToolsSnapshot}
 */
export function buildSnapshot(root) {
    if (!root) {
        return { tree: null, nodeCount: 0, taskCount: 0, timestamp: Date.now() };
    }
    const { nodes, tasks } = countNodes(root);
    return { tree: root, nodeCount: nodes, taskCount: tasks, timestamp: Date.now() };
}
