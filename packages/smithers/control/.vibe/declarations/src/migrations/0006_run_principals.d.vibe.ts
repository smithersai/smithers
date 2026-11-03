/**
 * Record who launched each run.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds the launching principal to the launch index.
 *
 * NULL is intentional for existing rows: a run launched before these columns
 * has no recorded launcher, so only a reader that sees every run lists or
 * watches it.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const runPrincipals: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
