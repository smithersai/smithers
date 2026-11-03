/**
 * The authoritative memory schema, including idempotent pre-release upgrades.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the memory schema. The shared migrator runs this Effect and records
 * its identity in the same transaction.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const initial: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
