/**
 * Persist the outcome of a rejected signal.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/** Adds the rejection outcome, preserving legacy no-match rejections.
 * @category migrations
 * @since 1.0.0
 */
export declare const signalRejection: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
