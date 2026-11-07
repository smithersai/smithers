/**
 * Durable generations distinguish histories that reuse journal sequences.
 *
 * @since 1.0.0-rc.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Installs the generation table idempotently. Both the SQL journal and time
 * travel initialize it, including databases whose migration ladder already
 * passed the journal's reserved block. A read-only client installs nothing.
 *
 * @category migrations
 * @since 1.0.0-rc.0
 */
export declare const initialize: Effect.Effect<void, import("effect/sql/SqlError").SqlError, SqlClient.SqlClient>;
/**
 * Registers a live journal's cache invalidation until its scope closes.
 * Multiple journals over the same SQL client must observe the same rewind.
 *
 * @category lifecycle
 * @since 1.0.0-rc.0
 */
export declare const onTruncate: (forget: (runIds: ReadonlyArray<string>) => void) => Effect.Effect<void, never, import("effect/Scope").Scope | SqlClient.SqlClient>;
/**
 * Forgets cached identities and allocation floors after a committed truncation.
 * The rewinder must quiesce producers and flush pending admissions first.
 * Database rows remain authoritative; this operation changes no durable data.
 *
 * @category lifecycle
 * @since 1.0.0-rc.0
 */
export declare const forget: (runIds: ReadonlyArray<string>) => Effect.Effect<void, never, SqlClient.SqlClient>;
