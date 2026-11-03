/**
 * Record who admitted each signal command.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds the admitting principal to the signal inbox.
 *
 * NULL is intentional for existing rows: a command admitted before this column
 * has no recorded identity, so it cannot answer a human wait, which requires
 * `ApprovalAuthority` to authorize the admitting principal.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const signalPrincipals: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
