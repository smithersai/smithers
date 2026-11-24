/**
 * Indexed keyset pages over parked runs.
 *
 * @since 1.0.0
 */

import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/**
 * Bounds each parked-run sweep page to parked rows.
 *
 * The heartbeat sweeps read `flows_runs` in `run_id` order, one page per lane
 * per tick. Without this index the order is satisfied by walking the primary
 * key across every row, settled history included, so each tick cost a scan of
 * the whole table (R2-Fable-D1-003). The index holds parked rows only, in the
 * order the page reads them.
 *
 * It lives in this block because the sweeps are engine-store's, and because
 * the run store holds its next migration id back for a later release.
 *
 * @category migrations
 * @since 1.0.0
 */
export const parkedRunPage: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE INDEX flows_runs_parked_page_idx ON flows_runs (run_id) WHERE waiting_reason IS NOT NULL`
})
