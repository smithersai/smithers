
/** @typedef {import("./types.ts").types} types */

/** @typedef {import("./types.ts").RefObject} RefObject */
// ---------------------------------------------------------------------------
// $ref resolution within an OpenAPI spec
// ---------------------------------------------------------------------------
/**
 * @param {unknown} obj
 * @returns {obj is RefObject}
 */
export function isRef(obj) {
    return (typeof obj === "object" &&
        obj !== null &&
        "$ref" in obj &&
        typeof obj.$ref === "string");
}
/**
 * Resolve a local JSON pointer ($ref) anywhere within the OpenAPI spec.
 */
export function resolveRef(spec, ref) {
    if (!ref.startsWith("#/")) {
        throw new Error(`Unsupported $ref format: ${ref}`);
    }
    const parts = ref.slice(2).split("/");
    let current = spec;
    for (const part of parts) {
        const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
        current = current?.[decoded];
        if (current === undefined) {
            throw new Error(`Could not resolve $ref: ${ref}`);
        }
    }
    return current;
}
/**
 * If the value is a $ref, resolve it. Otherwise return as-is.
 * Handles one level of indirection (resolved value is not recursively resolved).
 */
export function deref(spec, value) {
    if (isRef(value)) {
        return resolveRef(spec, value.$ref);
    }
    return value;
}
