/**
 * Retryable fork intent reclamation.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Records completed lane removal separately from claiming an abandoned intent.
 * Older reclaimed rows remain pending until their lane is forgotten again.
 *
 * @since 1.0.0
 * @private
 */
export declare const forkIntentForgotten: Effect.Effect<void, import("effect/sql/SqlError").SqlError | import("../TimeTravelError.vibe").TimeTravelError, SqlClient.SqlClient>;
