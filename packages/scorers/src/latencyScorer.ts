import type { Scorer } from "./types";
/**
 * Creates a latency scorer that scores based on execution time.
 * Returns 1.0 at or below `targetMs`, linearly decreasing to 0.0 at `maxMs`.
 */
export declare function latencyScorer(opts: {
    targetMs: number;
    maxMs: number;
}): Scorer;
