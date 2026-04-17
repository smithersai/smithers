/**
 * @param {string | null | undefined} metaJson
 * @returns {{ firesAtMs: number } | null}
 */
export function parseTimerMeta(metaJson) {
    if (!metaJson) return null;
    try {
        const parsed = JSON.parse(metaJson);
        const candidate = Number(parsed?.timer?.firesAtMs);
        return Number.isFinite(candidate)
            ? { firesAtMs: Math.floor(candidate) }
            : null;
    } catch {
        return null;
    }
}
