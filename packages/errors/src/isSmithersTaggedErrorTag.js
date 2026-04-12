import { smithersTaggedErrorCodes } from "./smithersTaggedErrorCodes.js";
/** @typedef {import("./SmithersTaggedErrorTag.ts").SmithersTaggedErrorTag} SmithersTaggedErrorTag */

/**
 * @param {unknown} value
 * @returns {value is SmithersTaggedErrorTag}
 */
export function isSmithersTaggedErrorTag(value) {
    return (typeof value === "string" &&
        Object.prototype.hasOwnProperty.call(smithersTaggedErrorCodes, value));
}
