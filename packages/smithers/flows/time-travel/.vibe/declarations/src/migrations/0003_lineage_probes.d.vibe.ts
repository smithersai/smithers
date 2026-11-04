/**
 * Run-scoped journal lineage indexes.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Indexes journal records that produce lineage edges.
 *
 * @since 0.1.0
 * @private
 */
export declare const lineageProbes: Effect.Effect<void, import("../TimeTravelError.vibe").TimeTravelError, SqlClient.SqlClient>;
