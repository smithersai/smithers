/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./DevToolsDelta.ts").DevToolsDelta} DevToolsDelta */
/** @typedef {import("./DevToolsSnapshotV1.ts").DevToolsSnapshotV1} DevToolsSnapshotV1 */

import { InvalidDeltaError } from "./InvalidDeltaError.js";

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function cloneValue(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * @param {DevToolsNode} root
 * @param {number} id
 * @returns {{ node: DevToolsNode; parent: DevToolsNode | null; index: number } | null}
 */
function findNode(root, id) {
    /** @type {Array<{ node: DevToolsNode; parent: DevToolsNode | null; index: number }>} */
    const stack = [{ node: root, parent: null, index: -1 }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        if (current.node.id === id) {
            return current;
        }
        for (let index = current.node.children.length - 1; index >= 0; index -= 1) {
            const child = current.node.children[index];
            stack.push({ node: child, parent: current.node, index });
        }
    }
    return null;
}

/**
 * Apply a delta to a snapshot. Throws `InvalidDeltaError` for malformed ops.
 *
 * @param {DevToolsSnapshotV1} snapshot
 * @param {DevToolsDelta} delta
 * @returns {DevToolsSnapshotV1}
 */
export function applyDelta(snapshot, delta) {
    if (delta.version !== 1) {
        throw new InvalidDeltaError(`Unsupported delta version: ${String(delta.version)}`);
    }
    if (delta.baseSeq !== snapshot.seq) {
        throw new InvalidDeltaError(`Delta base seq ${delta.baseSeq} does not match snapshot seq ${snapshot.seq}.`);
    }
    /** @type {DevToolsSnapshotV1} */
    const next = {
        ...snapshot,
        frameNo: delta.seq,
        seq: delta.seq,
        root: /** @type {DevToolsNode} */ (cloneValue(snapshot.root)),
    };
    for (const op of delta.ops) {
        if (op.op === "replaceRoot") {
            if (!op.node || typeof op.node !== "object") {
                throw new InvalidDeltaError("replaceRoot requires a node.");
            }
            next.root = /** @type {DevToolsNode} */ (cloneValue(op.node));
            continue;
        }
        if (op.op === "removeNode") {
            if (op.id === next.root.id) {
                throw new InvalidDeltaError("Cannot remove the root node.");
            }
            const target = findNode(next.root, op.id);
            if (!target || !target.parent) {
                throw new InvalidDeltaError(`Unknown node id: ${op.id}`);
            }
            target.parent.children.splice(target.index, 1);
            continue;
        }
        if (op.op === "addNode") {
            const parent = findNode(next.root, op.parentId);
            if (!parent) {
                throw new InvalidDeltaError(`Unknown parent id: ${op.parentId}`);
            }
            const index = Math.max(0, Math.min(op.index, parent.node.children.length));
            parent.node.children.splice(index, 0, /** @type {DevToolsNode} */ (cloneValue(op.node)));
            continue;
        }
        if (op.op === "updateProps") {
            const target = findNode(next.root, op.id);
            if (!target) {
                throw new InvalidDeltaError(`Unknown node id: ${op.id}`);
            }
            target.node.props = /** @type {Record<string, unknown>} */ (cloneValue(op.props));
            continue;
        }
        if (op.op === "updateTask") {
            const target = findNode(next.root, op.id);
            if (!target) {
                throw new InvalidDeltaError(`Unknown node id: ${op.id}`);
            }
            if (op.task === undefined) {
                delete target.node.task;
            }
            else {
                target.node.task = /** @type {DevToolsNode["task"]} */ (cloneValue(op.task));
            }
            continue;
        }
        throw new InvalidDeltaError(`Unknown op: ${String(op?.op)}`);
    }
    return next;
}
