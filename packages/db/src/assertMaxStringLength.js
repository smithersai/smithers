import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
export function assertMaxStringLength(field, value, maxLength) {
    if (typeof value !== "string") {
        throw new SmithersError("INVALID_INPUT", `${field} must be a string.`, { field, valueType: typeof value });
    }
    if (value.length > maxLength) {
        throw new SmithersError("INVALID_INPUT", `${field} exceeds the maximum length of ${maxLength} characters.`, { field, maxLength, actualLength: value.length });
    }
    return value;
}
