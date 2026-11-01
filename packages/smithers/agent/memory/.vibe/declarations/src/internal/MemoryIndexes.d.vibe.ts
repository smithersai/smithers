/**
 * The second memory migration: the indexes its hot reads actually use.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Replaces the unusable `(updated_at_ms, ttl_ms)` expiry index with one over
 * the `updated_at_ms + ttl_ms` expression the sweep filters on, and adds the
 * reverse edge index the supersession filter of every default note read
 * looks up. Databases created by the current `initial` already hold both, so
 * every statement is idempotent.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const indexes: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
