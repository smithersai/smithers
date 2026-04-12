/**
 * @param {string} text
 * @returns {unknown | undefined}
 */
export function tryParseJson(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return undefined;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
