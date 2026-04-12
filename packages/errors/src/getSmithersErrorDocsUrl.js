import { ERROR_REFERENCE_URL } from "./ERROR_REFERENCE_URL.js";
/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */

/**
 * @param {SmithersErrorCode} _code
 * @returns {string}
 */
export function getSmithersErrorDocsUrl(_code) {
    return ERROR_REFERENCE_URL;
}
