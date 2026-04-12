const smithersToolMetadata = Symbol.for("smithers.tool.metadata");
/**
 * @param {unknown} value
 * @returns {| { name: string; sideEffect: boolean; idempotent: boolean; } | null}
 */
export function getDefinedToolMetadata(value) {
    return value && typeof value === "object"
        ? (value[smithersToolMetadata] ?? null)
        : null;
}
