import { parseXmlJson } from "@smithers-orchestrator/graph/utils/xml";
/** @typedef {import("./FrameDeltaOp.ts").FrameDeltaOp} FrameDeltaOp */
/** @typedef {import("./JsonPath.ts").JsonPath} JsonPath */

/** @typedef {import("./FrameDelta.ts").FrameDelta} FrameDelta */

const FRAME_DELTA_VERSION = 1;
/**
 * @param {string} previousXmlJson
 * @param {string} nextXmlJson
 * @returns {FrameDelta}
 */
export function encodeFrameDelta(previousXmlJson, nextXmlJson) {
    const prev = parseXmlJson(previousXmlJson);
    const next = parseXmlJson(nextXmlJson);
    const ops = [];
    diffValues(prev, next, [], ops, null);
    return {
        version: FRAME_DELTA_VERSION,
        ops,
    };
}
/**
 * @param {unknown} prev
 * @param {unknown} next
 * @param {JsonPath} path
 * @param {FrameDeltaOp[]} ops
 * @param {string | null} currentNodeId
 */
function diffValues(prev, next, path, ops, currentNodeId) {
    if (deepEqual(prev, next))
        return;
    if (prev === undefined && next !== undefined) {
        pushSet(ops, path, next, currentNodeId);
        return;
    }
    if (next === undefined) {
        pushRemove(ops, path, currentNodeId);
        return;
    }
    const prevIsObj = isRecord(prev);
    const nextIsObj = isRecord(next);
    if (Array.isArray(prev) && Array.isArray(next)) {
        diffArrays(prev, next, path, ops, currentNodeId);
        return;
    }
    if (prevIsObj && nextIsObj) {
        const nodeId = inferNodeId(next, inferNodeId(prev, currentNodeId));
        diffObjects(prev, next, path, ops, nodeId);
        return;
    }
    pushSet(ops, path, next, currentNodeId);
}
/**
 * @param {Record<string, unknown>} prev
 * @param {Record<string, unknown>} next
 * @param {JsonPath} path
 * @param {FrameDeltaOp[]} ops
 * @param {string | null} currentNodeId
 */
function diffObjects(prev, next, path, ops, currentNodeId) {
    const keys = Array.from(new Set([...Object.keys(prev), ...Object.keys(next)])).sort();
    for (const key of keys) {
        const hasPrev = Object.prototype.hasOwnProperty.call(prev, key);
        const hasNext = Object.prototype.hasOwnProperty.call(next, key);
        const nextPath = [...path, key];
        if (!hasNext && hasPrev) {
            pushRemove(ops, nextPath, currentNodeId);
            continue;
        }
        if (hasNext && !hasPrev) {
            pushSet(ops, nextPath, next[key], currentNodeId);
            continue;
        }
        diffValues(prev[key], next[key], nextPath, ops, currentNodeId);
    }
}
/**
 * @param {unknown[]} prev
 * @param {unknown[]} next
 * @param {JsonPath} path
 * @param {FrameDeltaOp[]} ops
 * @param {string | null} currentNodeId
 */
function diffArrays(prev, next, path, ops, currentNodeId) {
    let start = 0;
    while (start < prev.length && start < next.length && deepEqual(prev[start], next[start])) {
        start += 1;
    }
    let prevEnd = prev.length - 1;
    let nextEnd = next.length - 1;
    while (prevEnd >= start && nextEnd >= start && deepEqual(prev[prevEnd], next[nextEnd])) {
        prevEnd -= 1;
        nextEnd -= 1;
    }
    const prevCount = prevEnd - start + 1;
    const nextCount = nextEnd - start + 1;
    if (prevCount <= 0 && nextCount <= 0) {
        return;
    }
    if (prevCount <= 0) {
        for (let i = 0; i < nextCount; i += 1) {
            pushInsert(ops, [...path, start + i], next[start + i], currentNodeId);
        }
        return;
    }
    if (nextCount <= 0) {
        for (let i = prevEnd; i >= start; i -= 1) {
            pushRemove(ops, [...path, i], currentNodeId);
        }
        return;
    }
    if (prevCount === nextCount) {
        for (let i = 0; i < prevCount; i += 1) {
            const prevValue = prev[start + i];
            const nextValue = next[start + i];
            const childNodeId = inferNodeId(nextValue, inferNodeId(prevValue, currentNodeId));
            diffValues(prevValue, nextValue, [...path, start + i], ops, childNodeId);
        }
        return;
    }
    for (let i = prevEnd; i >= start; i -= 1) {
        pushRemove(ops, [...path, i], currentNodeId);
    }
    for (let i = 0; i < nextCount; i += 1) {
        pushInsert(ops, [...path, start + i], next[start + i], currentNodeId);
    }
}
/**
 * @param {FrameDeltaOp[]} ops
 * @param {JsonPath} path
 * @param {unknown} value
 * @param {string | null} nodeId
 */
function pushSet(ops, path, value, nodeId) {
    const op = {
        op: "set",
        path,
        value: cloneValue(value),
        ...(nodeId ? { nodeId } : {}),
    };
    ops.push(op);
}
/**
 * @param {FrameDeltaOp[]} ops
 * @param {JsonPath} path
 * @param {unknown} value
 * @param {string | null} nodeId
 */
function pushInsert(ops, path, value, nodeId) {
    const op = {
        op: "insert",
        path,
        value: cloneValue(value),
        ...(nodeId ? { nodeId } : {}),
    };
    ops.push(op);
}
/**
 * @param {FrameDeltaOp[]} ops
 * @param {JsonPath} path
 * @param {string | null} nodeId
 */
function pushRemove(ops, path, nodeId) {
    const op = {
        op: "remove",
        path,
        ...(nodeId ? { nodeId } : {}),
    };
    ops.push(op);
}
/**
 * @param {unknown} value
 * @param {string | null} fallback
 * @returns {string | null}
 */
function inferNodeId(value, fallback) {
    if (!isRecord(value))
        return fallback;
    if (value.kind !== "element")
        return fallback;
    const props = value.props;
    if (!isRecord(props))
        return fallback;
    const id = props.id;
    return typeof id === "string" && id.length > 0 ? id : fallback;
}
/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null)
        return a === b;
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b))
            return false;
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i += 1) {
            if (!deepEqual(a[i], b[i]))
                return false;
        }
        return true;
    }
    if (isRecord(a) || isRecord(b)) {
        if (!isRecord(a) || !isRecord(b))
            return false;
        const keysA = Object.keys(a).sort();
        const keysB = Object.keys(b).sort();
        if (keysA.length !== keysB.length)
            return false;
        for (let i = 0; i < keysA.length; i += 1) {
            if (keysA[i] !== keysB[i])
                return false;
            const key = keysA[i];
            if (!deepEqual(a[key], b[key]))
                return false;
        }
        return true;
    }
    return false;
}
/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function cloneValue(value) {
    if (value === null)
        return value;
    if (typeof value !== "object")
        return value;
    return JSON.parse(JSON.stringify(value));
}
