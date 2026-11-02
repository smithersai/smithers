/**
 * Plan identity on snapshot anchors.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds plan identity to snapshot anchors.
 *
 * @since 0.1.0
 * @private
 */
export declare const planDigest: Effect.Effect<void, import("effect/sql/SqlError").SqlError | import("../TimeTravelError.vibe").TimeTravelError, SqlClient.SqlClient>;
