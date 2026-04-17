// ---------------------------------------------------------------------------
// $ref resolution within an OpenAPI spec
// ---------------------------------------------------------------------------
/** @typedef {import("./OpenApiSpec.ts").OpenApiSpec} OpenApiSpec */
/** @typedef {import("./RefObject.ts").RefObject} RefObject */

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
 *
 * @template [T=unknown]
 * @param {OpenApiSpec} spec
 * @param {string} ref
 * @returns {T}
 */
export function resolveRef(spec, ref) {
    if (!ref.startsWith("#/")) {
        throw new Error(`Unsupported $ref format: ${ref}`);
    }
    const parts = ref.slice(2).split("/");
    let current = /** @type {any} */ (spec);
    for (const part of parts) {
        const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
        current = current?.[decoded];
        if (current === undefined) {
            throw new Error(`Could not resolve $ref: ${ref}`);
        }
    }
    return /** @type {T} */ (current);
}
/**
 * If the value is a $ref, resolve it. Otherwise return as-is.
 * Handles one level of indirection (resolved value is not recursively resolved).
 *
 * @template [T=unknown]
 * @param {OpenApiSpec} spec
 * @param {T | RefObject} value
 * @returns {T}
 */
export function deref(spec, value) {
    if (isRef(value)) {
        return resolveRef(spec, value.$ref);
    }
    return value;
}
