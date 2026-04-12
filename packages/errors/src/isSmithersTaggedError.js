import { isSmithersTaggedErrorTag } from "./isSmithersTaggedErrorTag.js";
/** @typedef {import("./SmithersTaggedError.ts").SmithersTaggedError} SmithersTaggedError */

/**
 * @param {unknown} value
 * @returns {value is SmithersTaggedError}
 */
export function isSmithersTaggedError(value) {
    return Boolean(value &&
        typeof value === "object" &&
        isSmithersTaggedErrorTag(value._tag));
}
