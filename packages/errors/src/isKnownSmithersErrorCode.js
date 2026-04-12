import { smithersErrorDefinitions } from "./smithersErrorDefinitions.js";
/** @typedef {import("./KnownSmithersErrorCode.ts").KnownSmithersErrorCode} KnownSmithersErrorCode */

/**
 * @param {string} code
 * @returns {code is KnownSmithersErrorCode}
 */
export function isKnownSmithersErrorCode(code) {
    return code in smithersErrorDefinitions;
}
