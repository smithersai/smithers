
/** @typedef {import("./MemoryNamespace.ts").MemoryNamespace} MemoryNamespace */
/**
 * @param {string} str
 * @returns {MemoryNamespace}
 */
export function parseNamespace(str) {
    const idx = str.indexOf(":");
    if (idx < 0) {
        return { kind: "global", id: str };
    }
    const kind = str.slice(0, idx);
    const id = str.slice(idx + 1);
    if (!["workflow", "agent", "user", "global"].includes(kind)) {
        return { kind: "global", id: str };
    }
    return { kind, id };
}
