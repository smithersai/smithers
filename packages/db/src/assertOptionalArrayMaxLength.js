import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxLength
 */
export function assertOptionalArrayMaxLength(field, value, maxLength) {
    if (value === undefined || value === null)
        return;
    if (!Array.isArray(value)) {
        throw new SmithersError("INVALID_INPUT", `${field} must be an array.`, { field, valueType: typeof value });
    }
    if (value.length > maxLength) {
        throw new SmithersError("INVALID_INPUT", `${field} exceeds the maximum size of ${maxLength}.`, { field, maxLength, actualLength: value.length });
    }
}
