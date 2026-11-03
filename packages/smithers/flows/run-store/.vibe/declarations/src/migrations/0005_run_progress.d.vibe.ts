/**
 * Journal-driven progress for a run whose action attempt is still working.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Advances the existing revision feed at most once per two seconds per run
 * from journal inserts, in the same transaction as the inserted event.
 * @category migrations
 * @since 1.0.0
 */
export declare const runProgress: Effect.Effect<void, unknown, SqlClient.SqlClient>;
