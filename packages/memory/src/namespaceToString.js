
/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/**
 * @param {MemoryNamespace} ns
 * @returns {string}
 */
export function namespaceToString(ns) {
    return `${ns.kind}:${ns.id}`;
}
