/**
 * The statement executed by the paged parked-run sweeps and inspected by its query-plan tests.
 *
 * @since 1.0.0
 */

import type { SqlClient } from "effect/sql/SqlClient"
import type { WaitingRunsFilter, WaitingRunsPage } from "../DurableEngineState.ts"

/**
 * One raw waiting row, before the durable-state decoder has admitted it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Row {
  readonly runId: string
  readonly [column: string]: unknown
}

/**
 * The keyset page of parked runs matching `filter`: run-id order, strictly
 * after the cursor, bounded.
 *
 * Migration `0011_parked_run_page` indexes exactly this order over parked
 * rows, so a page never walks settled history.
 *
 * @category queries
 * @since 1.0.0
 */
export const page = (sql: SqlClient, filter: WaitingRunsFilter, page: WaitingRunsPage) =>
  sql<Row>`
    SELECT
      run_id AS "runId",
      waiting_reason AS "waitingReason",
      waiting_wake_at_ms AS "waitingWakeAtMs",
      waiting_token AS "waitingToken",
      waiting_request AS "waitingRequest"
    FROM flows_runs
    WHERE ${filter.reason === undefined ? sql`waiting_reason IS NOT NULL` : sql`waiting_reason = ${filter.reason}`}
      AND ${
    filter.dueBeforeMs === undefined
      ? sql`1 = 1`
      : sql`waiting_wake_at_ms IS NOT NULL AND waiting_wake_at_ms <= ${filter.dueBeforeMs}`
  }
      AND ${filter.cancelRequested === true ? sql`cancel_requested_at_ms IS NOT NULL` : sql`1 = 1`}
      AND ${
    filter.hasChildren === true
      ? sql`EXISTS (SELECT 1 FROM flows_run_parents WHERE flows_run_parents.parent_id = flows_runs.run_id)`
      : sql`1 = 1`
  }
      AND ${page.afterRunId === undefined ? sql`1 = 1` : sql`run_id > ${page.afterRunId}`}
      AND status NOT IN ('completed', 'failed', 'cancelled')
    ORDER BY run_id
    LIMIT ${page.limit}
  `
