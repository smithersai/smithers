import { smithersErrorDefinitions } from "./smithersErrorDefinitions.js";
import { isKnownSmithersErrorCode } from "./isKnownSmithersErrorCode.js";
/** @typedef {import("./SmithersErrorCode.ts").SmithersErrorCode} SmithersErrorCode */
/** @typedef {import("./SmithersErrorDefinition.ts").SmithersErrorDefinition} SmithersErrorDefinition */

/**
 * @param {SmithersErrorCode} code
 * @returns {SmithersErrorDefinition | undefined}
 */
export function getSmithersErrorDefinition(code) {
    if (!isKnownSmithersErrorCode(code))
        return undefined;
    return smithersErrorDefinitions[code];
}
