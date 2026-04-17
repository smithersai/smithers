/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./DevToolsDelta.ts").DevToolsDelta} DevToolsDelta */
/** @typedef {import("./DevToolsDeltaOp.ts").DevToolsDeltaOp} DevToolsDeltaOp */
/** @typedef {import("./DevToolsSnapshotV1.ts").DevToolsSnapshotV1} DevToolsSnapshotV1 */

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
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function deepEqual(left, right) {
    if (Object.is(left, right)) {
        return true;
    }
    if (typeof left !== typeof right) {
        return false;
    }
    if (left === null || right === null) {
        return left === right;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!deepEqual(left[index], right[index])) {
                return false;
            }
        }
        return true;
    }
    if (isRecord(left) && isRecord(right)) {
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        if (leftKeys.length !== rightKeys.length) {
            return false;
        }
        leftKeys.sort();
        rightKeys.sort();
        for (let index = 0; index < leftKeys.length; index += 1) {
            if (leftKeys[index] !== rightKeys[index]) {
                return false;
            }
        }
        for (const key of leftKeys) {
            if (!deepEqual(left[key], right[key])) {
                return false;
            }
        }
        return true;
    }
    return false;
}

/**
 * @param {DevToolsNode} root
 * @returns {Map<number, { node: DevToolsNode; parentId: number | null; index: number }>}
 */
function indexTree(root) {
    /** @type {Map<number, { node: DevToolsNode; parentId: number | null; index: number }>} */
    const indexed = new Map();
    /** @type {Array<{ node: DevToolsNode; parentId: number | null; index: number }>} */
    const stack = [{ node: root, parentId: null, index: 0 }];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        indexed.set(current.node.id, current);
        for (let childIndex = current.node.children.length - 1; childIndex >= 0; childIndex -= 1) {
            const child = current.node.children[childIndex];
            stack.push({
                node: child,
                parentId: current.node.id,
                index: childIndex,
            });
        }
    }
    return indexed;
}

/**
 * @param {DevToolsNode} left
 * @param {DevToolsNode} right
 * @returns {boolean}
 */
function sameNodeShape(left, right) {
    return left.type === right.type &&
        left.name === right.name &&
        left.depth === right.depth;
}

/**
 * Compute a delta from snapshot `a` to snapshot `b`.
 *
 * @param {DevToolsSnapshotV1} a
 * @param {DevToolsSnapshotV1} b
 * @returns {DevToolsDelta}
 */
export function diffSnapshots(a, b) {
    if (a.runId !== b.runId) {
        throw new Error("Cannot diff snapshots from different runs.");
    }
    // Root replacement: if the root's identity (id) changed, or its shape
    // changed, emit a single replaceRoot op rather than trying to remove + add
    // the root in place (the root cannot be removed).
    if (a.root.id !== b.root.id || !sameNodeShape(a.root, b.root)) {
        return {
            version: 1,
            baseSeq: a.seq,
            seq: b.seq,
            ops: [{
                    op: "replaceRoot",
                    node: /** @type {DevToolsNode} */ (cloneValue(b.root)),
                }],
        };
    }
    const from = indexTree(a.root);
    const to = indexTree(b.root);
    /** @type {Set<number>} */
    const removeSet = new Set();
    /** @type {Set<number>} */
    const addSet = new Set();
    /** @type {DevToolsDeltaOp[]} */
    const updateOps = [];
    for (const [id, fromEntry] of from.entries()) {
        const toEntry = to.get(id);
        if (!toEntry) {
            removeSet.add(id);
            continue;
        }
        const moved = fromEntry.parentId !== toEntry.parentId || fromEntry.index !== toEntry.index;
        const replaced = !sameNodeShape(fromEntry.node, toEntry.node);
        if (moved || replaced) {
            removeSet.add(id);
            addSet.add(id);
            continue;
        }
        if (!deepEqual(fromEntry.node.props, toEntry.node.props)) {
            updateOps.push({
                op: "updateProps",
                id,
                props: /** @type {Record<string, unknown>} */ (cloneValue(toEntry.node.props)),
            });
        }
        if (!deepEqual(fromEntry.node.task, toEntry.node.task)) {
            updateOps.push({
                op: "updateTask",
                id,
                task: /** @type {DevToolsNode["task"]} */ (cloneValue(toEntry.node.task)),
            });
        }
    }
    for (const [id] of to.entries()) {
        if (!from.has(id)) {
            addSet.add(id);
        }
    }
    /** @type {DevToolsDeltaOp[]} */
    const removeOps = [...removeSet]
        .sort((leftId, rightId) => (from.get(rightId)?.node.depth ?? 0) - (from.get(leftId)?.node.depth ?? 0))
        .map((id) => ({ op: "removeNode", id }));
    const topLevelAddIds = [...addSet].filter((id) => {
        const parentId = to.get(id)?.parentId;
        return parentId === null || !addSet.has(parentId);
    });
    /** @type {DevToolsDeltaOp[]} */
    const addOps = topLevelAddIds
        .sort((leftId, rightId) => (to.get(leftId)?.node.depth ?? 0) - (to.get(rightId)?.node.depth ?? 0))
        .map((id) => {
        const entry = to.get(id);
        if (!entry || entry.parentId === null) {
            return /** @type {DevToolsDeltaOp} */ ({
                op: "updateProps",
                id,
                props: /** @type {Record<string, unknown>} */ (cloneValue(entry?.node.props ?? {})),
            });
        }
        return /** @type {DevToolsDeltaOp} */ ({
            op: "addNode",
            parentId: entry.parentId,
            index: entry.index,
            node: /** @type {DevToolsNode} */ (cloneValue(entry.node)),
        });
    });
    return {
        version: 1,
        baseSeq: a.seq,
        seq: b.seq,
        ops: [...removeOps, ...addOps, ...updateOps],
    };
}
