import { createScorer } from "./createScorer.js";
/** @typedef {import("./types.js").Scorer} Scorer */

/**
 * Creates a latency scorer that scores based on execution time.
 * Returns 1.0 at or below `targetMs`, linearly decreasing to 0.0 at `maxMs`.
 *
 * @param {{ targetMs: number; maxMs: number }} opts
 * @returns {Scorer}
 */
export function latencyScorer(opts) {
    const { targetMs, maxMs } = opts;
    return createScorer({
        id: "latency",
        name: "Latency",
        description: `Scores execution time (target: ${targetMs}ms, max: ${maxMs}ms)`,
        score: async ({ latencyMs }) => {
            if (latencyMs == null) {
                return {
                    score: 1,
                    reason: "No latency data available",
                    meta: { skipped: true },
                };
            }
            if (latencyMs <= targetMs) {
                return {
                    score: 1,
                    reason: `${Math.round(latencyMs)}ms is within target (${targetMs}ms)`,
                };
            }
            if (latencyMs >= maxMs) {
                return {
                    score: 0,
                    reason: `${Math.round(latencyMs)}ms exceeds max (${maxMs}ms)`,
                };
            }
            // Linear interpolation between target and max
            const score = 1 - (latencyMs - targetMs) / (maxMs - targetMs);
            return {
                score: Math.max(0, Math.min(1, score)),
                reason: `${Math.round(latencyMs)}ms (target: ${targetMs}ms, max: ${maxMs}ms)`,
            };
        },
    });
}
