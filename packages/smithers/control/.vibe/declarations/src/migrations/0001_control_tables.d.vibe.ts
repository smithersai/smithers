/**
 * Initial durable control-plane schema.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates every table owned by `@smthrs/control`.
 *
 * `IF NOT EXISTS` lets the recorded migration and each standalone adapter's
 * bootstrap share this exact schema without competing over table creation.
 *
 * @category migrations
 * @since 0.1.0
 */
export declare const initial: Effect.Effect<void, unknown, SqlClient.SqlClient>;
