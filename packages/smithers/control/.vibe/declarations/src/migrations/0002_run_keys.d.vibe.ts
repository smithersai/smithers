/**
 * Durable run idempotency claims, including upgrades of existing databases.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds the run-key claim table without changing existing control data.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const runKeys: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
