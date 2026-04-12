import { SMITHERS_NODE_ICONS } from "./SMITHERS_NODE_ICONS.js";
/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */

/**
 * @param {DevToolsNode} node
 * @param {string} [indent]
 * @returns {string}
 */
export function printTree(node, indent = "") {
    const icon = SMITHERS_NODE_ICONS[node.type] ?? "❓";
    let line = `${indent}${icon} ${node.type}`;
    if (node.task) {
        line += ` [${node.task.nodeId}]`;
        if (node.task.kind === "agent" && node.task.agent) {
            line += ` (${node.task.agent})`;
        }
        else {
            line += ` (${node.task.kind})`;
        }
        if (node.task.label) {
            line += ` "${node.task.label}"`;
        }
    }
    else if (node.props.name) {
        line += ` "${node.props.name}"`;
    }
    else if (node.props.id) {
        line += ` [${node.props.id}]`;
    }
    let output = line + "\n";
    for (const child of node.children) {
        output += printTree(child, indent + "  ");
    }
    return output;
}
