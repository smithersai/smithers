/**
 * Generation-aware archive upgrade.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Rekeys archived records by journal generation.
 *
 * @since 0.1.0
 * @private
 */
export declare const archiveGeneration: Effect.Effect<void, import("effect/sql/SqlError").SqlError | import("../TimeTravelError.vibe").TimeTravelError, SqlClient.SqlClient>;
