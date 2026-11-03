/**
 * Durable cursor persistence for polling sources.
 *
 * A polling source is only as safe as its cursor. The contract is that a
 * proposed cursor reaches the store *after* the batch it acknowledges has been
 * handled, so a process that dies mid-batch re-polls that batch on restart
 * instead of skipping it. The store itself is deliberately dumb: get, set, and
 * nothing else.
 *
 * @since 1.0.0
 */
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
/**
 * The cursor persistence seam.
 *
 * @category services
 * @since 1.0.0
 */
export interface CursorStore {
    /** The stored cursor for `sourceId`, or `null` when the source is new. */
    readonly get: (sourceId: string) => Effect.Effect<string | null, IntegrationError>;
    readonly set: (sourceId: string, cursor: string | null) => Effect.Effect<void, IntegrationError>;
}
/**
 * Service tag for cursor persistence.
 *
 * @category services
 * @since 1.0.0
 */
export declare const CursorStore: Context.Service<CursorStore, CursorStore>;
/**
 * An in-memory store. Cursors live as long as the process, which is what an
 * ephemeral source and a test both want.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeMemory: Effect.Effect<CursorStore>;
/**
 * Layer for the in-memory store.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerMemory: Layer.Layer<CursorStore>;
/**
 * A store over the control database's `smithers_integration_cursors` table, so
 * a polling source resumes where it stopped after a restart.
 *
 * Requires the migration in `core/Migrations` to have run.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const makeSql: Effect.Effect<CursorStore, never, SqlClient.SqlClient>;
/**
 * Layer for the SQL-backed store.
 *
 * @category layers
 * @since 1.0.0
 */
export declare const layerSql: Layer.Layer<CursorStore, never, SqlClient.SqlClient>;
