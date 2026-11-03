/**
 * Durable lifecycle metadata for the existing append-only notes.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds status-transition time and accepted TODO without changing creation data.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const noteLifecycle: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
