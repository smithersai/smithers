import type { SmithersDb } from "@smithers/db/adapter";
import type { AggregateScore } from "./types";
export type AggregateOptions = {
    /** Filter to a specific run. */
    runId?: string;
    /** Filter to a specific node. */
    nodeId?: string;
    /** Filter to a specific scorer. */
    scorerId?: string;
};
/**
 * Computes aggregate statistics for scorer results.
 *
 * Returns one row per scorer with count, mean, min, max, p50, and stddev.
 * Uses a simple SQL aggregation query plus in-memory p50 calculation,
 * since SQLite does not support PERCENTILE_CONT or correlated subqueries
 * in GROUP BY reliably.
 */
export declare function aggregateScores(adapter: SmithersDb, opts?: AggregateOptions): Promise<AggregateScore[]>;
