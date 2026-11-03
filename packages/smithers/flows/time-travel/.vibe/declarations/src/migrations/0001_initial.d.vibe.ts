/**
 * Initial time-travel schema. Keep this rung frozen.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the original time-travel tables and indexes.
 *
 * @since 0.1.0
 * @private
 */
export declare const initial: Effect.Effect<void, import("../TimeTravelError.vibe").TimeTravelError, SqlClient.SqlClient>;
