/**
 * @param {readonly string[] | null | undefined} values
 * @returns {string[]}
 */
export function normalizeCapabilityStringList(values) {
    return [...new Set((values ?? [])
            .map((value) => value.trim())
            .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
