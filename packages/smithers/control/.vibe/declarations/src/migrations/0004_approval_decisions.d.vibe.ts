/**
 * Preserve the actual decision without guessing erased legacy answers.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Idempotent for both recorded migrations and standalone runtime bootstrap.
 * @category migrations
 * @since 1.0.0
 */
export declare const approvalDecisions: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
