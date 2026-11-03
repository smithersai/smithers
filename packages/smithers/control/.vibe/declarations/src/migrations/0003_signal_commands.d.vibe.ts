/**
 * Durable signal admission and immutable wait bindings.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds the signal inbox without replaying legacy messages that lack delivery identity.
 * @category migrations
 * @since 1.0.0
 */
export declare const signalCommands: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
