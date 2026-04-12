
/**
 * @typedef {number | { totalMs?: number; idleMs?: number; } | undefined} TimeoutInput
 */
/**
 * @param {TimeoutInput} timeout
 * @param {{ totalMs?: number; idleMs?: number }} [fallback]
 * @returns {{ totalMs?: number; idleMs?: number }}
 */
export function resolveTimeouts(timeout, fallback) {
    if (typeof timeout === "number") {
        return { totalMs: timeout };
    }
    if (timeout && typeof timeout === "object") {
        return {
            totalMs: typeof timeout.totalMs === "number" ? timeout.totalMs : fallback?.totalMs,
            idleMs: typeof timeout.idleMs === "number" ? timeout.idleMs : fallback?.idleMs,
        };
    }
    return {
        totalMs: fallback?.totalMs,
        idleMs: fallback?.idleMs,
    };
}
