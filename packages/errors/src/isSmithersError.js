
/** @typedef {import("./SmithersError.ts").SmithersError} SmithersError */
/**
 * @param {unknown} value
 * @returns {value is SmithersError}
 */
export function isSmithersError(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "code" in value &&
        "message" in value);
}
