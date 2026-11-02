/**
 * The `SqlConsensus` lease table.
 *
 * This is the private schema of the default consensus strategy: the owner
 * tuple, the two-phase claim columns, and the grant timestamp relocated from
 * `flows_runs`. Lease rows are strategy evidence, never history: heartbeats
 * and lease state never enter the journal.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
/**
 * Creates the `flows_consensus_leases` table and backfills a lease for every
 * running or claimed run when `flows_runs` is already present, so an owner
 * that was driving a run before this migration keeps its fence afterwards.
 *
 * @category migrations
 * @since 1.0.0
 */
export declare const consensus: Effect.Effect<void, unknown, SqlClient.SqlClient>;
