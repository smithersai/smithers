import { canonicalizeXml, parseXmlJson } from "@smithers-orchestrator/graph/utils/xml";
/** @typedef {import("./FrameDeltaOp.ts").FrameDeltaOp} FrameDeltaOp */
/** @typedef {import("./JsonPath.ts").JsonPath} JsonPath */
/** @typedef {import("./JsonPathSegment.ts").JsonPathSegment} JsonPathSegment */

/** @typedef {import("./FrameDelta.ts").FrameDelta} FrameDelta */

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
