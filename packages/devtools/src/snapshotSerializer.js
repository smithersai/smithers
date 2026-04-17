/** @typedef {import("./DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./SnapshotSerializerOptions.ts").SnapshotSerializerOptions} SnapshotSerializerOptions */
/** @typedef {import("./SnapshotSerializerWarning.ts").SnapshotSerializerWarning} SnapshotSerializerWarning */

import { SNAPSHOT_SERIALIZER_DEFAULT_MAX_DEPTH } from "./SNAPSHOT_SERIALIZER_DEFAULT_MAX_DEPTH.js";

const SNAPSHOT_SERIALIZER_DEFAULT_MAX_ENTRIES = 100_000;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * @param {SnapshotSerializerWarning["code"]} code
 * @param {string} path
 * @param {SnapshotSerializerOptions["onWarning"]} onWarning
 * @param {string} [detail]
 */
function warn(code, path, onWarning, detail) {
    if (!onWarning) {
        return;
    }
    onWarning({
        code,
        path,
        ...(detail ? { detail } : {}),
    });
}

/**
 * @param {unknown} value
 * @param {{
 *   maxDepth: number;
 *   maxEntries: number;
 *   onWarning?: (warning: SnapshotSerializerWarning) => void;
 *   seen: WeakSet<object>;
 *   traversed: number;
 * }} state
 * @param {number} depth
 * @param {string} path
 * @returns {unknown}
 */
function serializeInternal(value, state, depth, path) {
    if (depth > state.maxDepth) {
        warn("MaxDepthExceeded", path, state.onWarning);
        return "[MaxDepth]";
    }
    if (value === null || value === undefined) {
        return value;
    }
    const valueType = typeof value;
    if (valueType === "string" || valueType === "number" || valueType === "boolean") {
        return value;
    }
    if (valueType === "bigint") {
        return `[BigInt: ${value.toString()}]`;
    }
    if (valueType === "function") {
        return "[Function]";
    }
    if (valueType === "symbol") {
        return value.description
            ? `[Symbol: ${value.description}]`
            : "[Symbol]";
    }
    if (value instanceof Date) {
        return Number.isNaN(value.getTime())
            ? "[Date: Invalid]"
            : `[Date: ${value.toISOString()}]`;
    }
    if (valueType !== "object") {
        return String(value);
    }
    if (state.traversed >= state.maxEntries) {
        warn("MaxEntriesExceeded", path, state.onWarning);
        return "[MaxEntries]";
    }
    state.traversed += 1;
    const objectValue = /** @type {object} */ (value);
    if (state.seen.has(objectValue)) {
        warn("CircularReference", path, state.onWarning);
        return "[Circular]";
    }
    state.seen.add(objectValue);
    try {
        if (Array.isArray(value)) {
            return value.map((entry, index) => serializeInternal(entry, state, depth + 1, `${path}[${index}]`));
        }
        if (!isPlainObject(value)) {
            const ctorName = value.constructor?.name;
            if (ctorName && ctorName !== "Object") {
                warn("UnsupportedType", path, state.onWarning, ctorName);
                return `[${ctorName}]`;
            }
        }
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value)).sort()) {
            try {
                out[key] = serializeInternal(/** @type {Record<string, unknown>} */ (value)[key], state, depth + 1, `${path}.${key}`);
            }
            catch {
                warn("UnsupportedType", `${path}.${key}`, state.onWarning, "ThrownDuringRead");
                out[key] = "[Unserializable]";
            }
        }
        return out;
    }
    finally {
        state.seen.delete(objectValue);
    }
}

/**
 * Serialize arbitrary values into a stable JSON-safe shape for devtools snapshots.
 *
 * @param {unknown} value
 * @param {SnapshotSerializerOptions} [options]
 * @returns {unknown}
 */
export function snapshotSerialize(value, options = {}) {
    const maxDepth = Number.isFinite(options.maxDepth)
        ? Math.max(0, Math.floor(options.maxDepth))
        : SNAPSHOT_SERIALIZER_DEFAULT_MAX_DEPTH;
    const maxEntries = Number.isFinite(options.maxEntries)
        ? Math.max(1, Math.floor(options.maxEntries))
        : SNAPSHOT_SERIALIZER_DEFAULT_MAX_ENTRIES;
    return serializeInternal(value, {
        maxDepth,
        maxEntries,
        onWarning: options.onWarning,
        seen: new WeakSet(),
        traversed: 0,
    }, 0, "$");
}
