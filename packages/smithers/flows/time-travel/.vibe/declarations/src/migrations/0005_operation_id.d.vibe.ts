/**
 * jj operation identity on snapshot anchors.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Adds the jj operation that recorded each snapshot anchor, which a
 * whole-repository rewind restores.
 *
 * @since 1.0.0
 * @private
 */
export declare const operationId: Effect.Effect<void, import("effect/sql/SqlError").SqlError | import("../TimeTravelError.vibe").TimeTravelError, SqlClient.SqlClient>;
