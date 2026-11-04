/**
 * The source record store's schema installation.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the `smithers_integration_records`, `smithers_integration_streams`
 * and `smithers_integration_revocations` tables.
 *
 * Records are keyed by connection and external id. A stream row carries the
 * mark-and-sweep generation of one synchronized stream, and a revocation row
 * withdraws a whole connection (container `*`) or one container of it.
 *
 * Like the cursor migration, this stays out of `package.json` `exports` and
 * `core.ts`: consumers reach it through `Core.Migrations.set`. Exported by
 * name, never as a default, for the CommonJS build reason documented beside
 * `integrationCursors`.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const integrationRecords: Effect.Effect<void, unknown, SqlClient.SqlClient>;
/**
 * Adds `swept` to `smithers_integration_records`: whether a record's deletion
 * was inferred by a completed full listing that omitted it, rather than
 * reported by the provider. Only a provider deletion outranks a live copy with
 * the same change time and version; an inferred one yields to the next listing
 * that contains the record again.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const integrationRecordsSwept: Effect.Effect<void, unknown, SqlClient.SqlClient>;
