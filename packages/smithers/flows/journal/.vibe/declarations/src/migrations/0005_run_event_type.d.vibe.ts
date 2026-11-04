/**
 * Indexed exact event-type reads within a run.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Keeps filtered cursor reads proportional to the matching entries.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const runEventType: Effect.Effect<void, unknown, SqlClient.SqlClient>;
