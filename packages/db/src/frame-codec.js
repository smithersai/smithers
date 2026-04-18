import { canonicalizeXml, parseXmlJson } from "@smithers-orchestrator/graph/utils/xml";
/** @typedef {import("./frame-codec/FrameDelta.ts").FrameDelta} FrameDelta */
/** @typedef {import("./frame-codec/FrameDeltaOp.ts").FrameDeltaOp} FrameDeltaOp */
/** @typedef {import("./frame-codec/FrameEncoding.ts").FrameEncoding} FrameEncoding */
/** @typedef {import("./frame-codec/JsonPath.ts").JsonPath} JsonPath */
/** @typedef {import("./frame-codec/JsonPathSegment.ts").JsonPathSegment} JsonPathSegment */

export const FRAME_KEYFRAME_INTERVAL = 50;
const FRAME_DELTA_VERSION = 1;
/**
 * @param {unknown} value
 * @returns {FrameEncoding}
 */
export function normalizeFrameEncoding(value) {
    if (value === "delta")
        return "delta";
    if (value === "keyframe")
        return "keyframe";
    return "full";
}
/**
 * @param {string} deltaJson
 * @returns {FrameDelta}
 */
export function parseFrameDelta(deltaJson) {
    const parsed = JSON.parse(deltaJson);
    if (!isRecord(parsed)) {
        throw new Error("Invalid frame delta payload (not an object)");
    }
    if (parsed.version !== FRAME_DELTA_VERSION) {
        throw new Error(`Unsupported frame delta version: ${String(parsed.version)}`);
    }
    if (!Array.isArray(parsed.ops)) {
        throw new Error("Invalid frame delta payload (missing ops array)");
    }
    return parsed;
}
/**
 * @param {FrameDelta} delta
 * @returns {string}
 */
export function serializeFrameDelta(delta) {
    return JSON.stringify(delta);
}
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
 * @param {string} previousXmlJson
 * @param {FrameDelta} delta
 * @returns {string}
 */
export function applyFrameDelta(previousXmlJson, delta) {
    const root = cloneValue(parseXmlJson(previousXmlJson));
    const next = applyOps(root, delta.ops);
    return canonicalizeXml(next);
}
/**
 * @param {string} previousXmlJson
 * @param {string} deltaJson
 * @returns {string}
 */
export function applyFrameDeltaJson(previousXmlJson, deltaJson) {
    return applyFrameDelta(previousXmlJson, parseFrameDelta(deltaJson));
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
 * @param {unknown} root
 * @param {FrameDeltaOp[]} ops
 * @returns {unknown}
 */
function applyOps(root, ops) {
    let current = root;
    for (const op of ops) {
        if (op.op === "set") {
            current = setAtPath(current, op.path, op.value);
            continue;
        }
        if (op.op === "insert") {
            current = insertAtPath(current, op.path, op.value);
            continue;
        }
        current = removeAtPath(current, op.path);
    }
    return current;
}
/**
 * @param {unknown} root
 * @param {JsonPath} path
 * @param {unknown} value
 * @returns {unknown}
 */
function setAtPath(root, path, value) {
    if (path.length === 0) {
        return cloneValue(value);
    }
    const { parent, key } = getParentAndKey(root, path);
    if (Array.isArray(parent)) {
        if (typeof key !== "number") {
            throw new Error("Invalid array set path");
        }
        parent[key] = cloneValue(value);
        return root;
    }
    if (!isRecord(parent) || typeof key !== "string") {
        throw new Error("Invalid object set path");
    }
    parent[key] = cloneValue(value);
    return root;
}
/**
 * @param {unknown} root
 * @param {JsonPath} path
 * @param {unknown} value
 * @returns {unknown}
 */
function insertAtPath(root, path, value) {
    if (path.length === 0) {
        return cloneValue(value);
    }
    const { parent, key } = getParentAndKey(root, path);
    if (!Array.isArray(parent) || typeof key !== "number") {
        throw new Error("Invalid insert path");
    }
    parent.splice(key, 0, cloneValue(value));
    return root;
}
/**
 * @param {unknown} root
 * @param {JsonPath} path
 * @returns {unknown}
 */
function removeAtPath(root, path) {
    if (path.length === 0) {
        return null;
    }
    const { parent, key } = getParentAndKey(root, path);
    if (Array.isArray(parent)) {
        if (typeof key !== "number") {
            throw new Error("Invalid array remove path");
        }
        parent.splice(key, 1);
        return root;
    }
    if (!isRecord(parent) || typeof key !== "string") {
        throw new Error("Invalid object remove path");
    }
    delete parent[key];
    return root;
}
/**
 * @param {unknown} root
 * @param {JsonPath} path
 * @returns {{ parent: unknown; key: JsonPathSegment }}
 */
function getParentAndKey(root, path) {
    let cursor = root;
    for (let i = 0; i < path.length - 1; i += 1) {
        const seg = path[i];
        if (typeof seg === "number") {
            if (!Array.isArray(cursor)) {
                throw new Error("Invalid numeric path segment");
            }
            cursor = cursor[seg];
            continue;
        }
        if (!isRecord(cursor)) {
            throw new Error("Invalid object path segment");
        }
        cursor = cursor[seg];
    }
    return { parent: cursor, key: path[path.length - 1] };
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
