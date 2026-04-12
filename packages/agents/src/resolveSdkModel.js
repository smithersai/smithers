/**
 * @template MODEL
 * @param {string | MODEL} value
 * @param {(modelId: string) => MODEL} create
 * @returns {MODEL}
 */
export function resolveSdkModel(value, create) {
    return typeof value === "string" ? create(value) : value;
}
