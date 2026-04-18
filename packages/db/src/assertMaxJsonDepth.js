import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} depth
 * @param {number} maxDepth
 * @param {string} path
 * @param {Set<unknown>} seen
 */
function validateJsonDepth(field, value, depth, maxDepth, path, seen) {
    if (depth > maxDepth) {
        throw new SmithersError("INVALID_INPUT", `${field} exceeds the maximum JSON depth of ${maxDepth}.`, { field, maxDepth, path });
    }
    if (value === null || typeof value !== "object") {
        return;
    }
    if (seen.has(value)) {
        throw new SmithersError("INVALID_INPUT", `${field} must not contain circular references.`, { field, path });
    }
    seen.add(value);
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            validateJsonDepth(field, value[index], depth + 1, maxDepth, `${path}[${index}]`, seen);
        }
        seen.delete(value);
        return;
    }
    for (const [key, entry] of Object.entries(value)) {
        validateJsonDepth(field, entry, depth + 1, maxDepth, `${path}.${key}`, seen);
    }
    seen.delete(value);
}
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} maxDepth
 */
export function assertMaxJsonDepth(field, value, maxDepth) {
    validateJsonDepth(field, value, 1, maxDepth, field, new Set());
}
