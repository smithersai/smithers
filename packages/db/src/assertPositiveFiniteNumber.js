import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @param {string} field
 * @param {unknown} value
 * @returns {number}
 */
export function assertPositiveFiniteNumber(field, value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new SmithersError("INVALID_INPUT", `${field} must be a finite number greater than 0.`, { field, value });
    }
    return value;
}
