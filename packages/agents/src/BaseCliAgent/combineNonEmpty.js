/**
 * @param {Array<string | undefined>} parts
 * @returns {string | undefined}
 */
export function combineNonEmpty(parts) {
    const filtered = parts.map((part) => (part ?? "").trim()).filter(Boolean);
    return filtered.length ? filtered.join("\n\n") : undefined;
}
