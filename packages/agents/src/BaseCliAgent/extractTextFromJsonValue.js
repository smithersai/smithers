/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function extractTextFromJsonValue(value) {
    if (typeof value === "string")
        return value;
    if (!value || typeof value !== "object")
        return undefined;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (typeof record.text === "string")
        return record.text;
    if (typeof record.content === "string")
        return record.content;
    if (Array.isArray(record.content)) {
        const parts = record.content
            .map((part) => {
            if (!part)
                return "";
            if (typeof part === "string")
                return part;
            if (typeof part !== "object")
                return "";
            const partRecord = /** @type {Record<string, unknown>} */ (part);
            if (typeof partRecord.text === "string")
                return partRecord.text;
            if (typeof partRecord.content === "string")
                return partRecord.content;
            return "";
        })
            .join("");
        if (parts.trim())
            return parts;
    }
    if (record.type === "text" && record.part)
        return extractTextFromJsonValue(record.part);
    if (record.response)
        return extractTextFromJsonValue(record.response);
    if (record.message)
        return extractTextFromJsonValue(record.message);
    if (record.result)
        return extractTextFromJsonValue(record.result);
    if (record.output)
        return extractTextFromJsonValue(record.output);
    if (record.data)
        return extractTextFromJsonValue(record.data);
    return undefined;
}
