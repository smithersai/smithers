/**
 * @param {string} text
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function truncateToBytes(text, maxBytes) {
    if (!maxBytes || maxBytes <= 0)
        return text;
    const buf = Buffer.from(text, "utf8");
    if (buf.length <= maxBytes)
        return text;
    return buf.subarray(0, maxBytes).toString("utf8");
}
