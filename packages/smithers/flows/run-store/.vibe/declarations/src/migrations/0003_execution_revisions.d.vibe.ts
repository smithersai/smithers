/**
 * Durable database identity and coalesced execution change tracking.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Retains one current revision per run ID, including deleted IDs forever.
 * Triggers participate in the mutating transaction, including raw SQL writes.
 * @category migrations
 * @since 1.0.0
 */
export declare const executionRevisions: Effect.Effect<void, unknown, SqlClient.SqlClient>;
