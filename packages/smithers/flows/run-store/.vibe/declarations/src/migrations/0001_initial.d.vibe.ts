/**
 * Initial durable run and attempt schema.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the `flows_runs` and `flows_attempts` tables and their indexes.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const initial: Effect.Effect<void, unknown, SqlClient.SqlClient>;
