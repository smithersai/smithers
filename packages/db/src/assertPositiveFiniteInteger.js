import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { assertPositiveFiniteNumber } from "./assertPositiveFiniteNumber.js";
/**
 * @param {string} field
 * @param {unknown} value
 * @returns {number}
 */
export function assertPositiveFiniteInteger(field, value) {
    const numberValue = assertPositiveFiniteNumber(field, value);
    if (!Number.isInteger(numberValue)) {
        throw new SmithersError("INVALID_INPUT", `${field} must be an integer greater than 0.`, { field, value });
    }
    return numberValue;
}
