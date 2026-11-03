/**
 * Index for the bounded journal source-event startup window.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Preserves deterministic timestamp/run/sequence ordering without sorting the retained history.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const startupIndex: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
