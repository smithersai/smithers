/**
 * Record the operator consent a resume delegation carries.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds the journal sequence of an operator's explicit resume to the pending
 * resume delegations.
 *
 * NULL is intentional for existing rows: a delegation recorded before this
 * column is an approval or a wake, which is background intent.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const resumeConsent: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
