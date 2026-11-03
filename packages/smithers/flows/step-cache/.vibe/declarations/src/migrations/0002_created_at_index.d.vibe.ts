/**
 * Indexes the expiry column of both step-cache tables.
 *
 * See the {@link https://smithers.sh/docs/reference/api/step-cache | step-cache reference}.
 *
 * @since 1.0.0-rc.1
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates `created_at_ms` indexes on `flows_step_cache` and
 * `flows_step_cache_recorded`, so `sweepExpired` reads only expired rows
 * instead of scanning both tables inside its write transaction.
 *
 * @category migrations
 * @since 1.0.0-rc.1
 */
export declare const createdAtIndex: Effect.Effect<void, unknown, SqlClient.SqlClient>;
