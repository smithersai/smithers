/**
 * The statements executed by pending-run discovery and inspected by its query-plan tests.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { PendingRunCursor } from "../DurableEngineState.ts"

/**
 * Creation-ordered pending admissions, including the reverse tail read.
 *
 * @category queries
 * @since 1.0.0
 */
export const pending = (
  sql: SqlClient,
  flowName: string,
  limit?: number,
  after?: PendingRunCursor,
  through?: PendingRunCursor,
  descending = false,
  eligibleBeforeMs?: number
) =>
  sql<{ readonly runId: string; readonly createdAtMs: number | bigint | string }>`
      SELECT run_id AS "runId", created_at_ms AS "createdAtMs" FROM flows_runs
        ${Dialect.isPostgres(sql) ? sql`` : sql`INDEXED BY flows_runs_listing_3`}
      WHERE status = 'pending'
        AND ${eligibleBeforeMs === undefined ? sql`TRUE` : sql`created_at_ms < ${eligibleBeforeMs}`}
        AND execution_flow = ${flowName}
        AND ${
    after === undefined ? sql`TRUE` : sql`(
          created_at_ms > ${after.createdAtMs}
          OR (created_at_ms = ${after.createdAtMs} AND run_id > ${after.runId})
        )`
  }
        AND ${
    through === undefined ? sql`TRUE` : sql`(
          created_at_ms < ${through.createdAtMs}
          OR (created_at_ms = ${through.createdAtMs} AND run_id <= ${through.runId})
        )`
  }
      ORDER BY ${descending ? sql`created_at_ms DESC, run_id DESC` : sql`created_at_ms, run_id`}
      LIMIT ${limit ?? (Dialect.isPostgres(sql) ? null : -1)}
    `

/**
 * Pending cancellation requests, including the reverse tail read.
 *
 * @category queries
 * @since 1.0.0
 */
export const cancellations = (
  sql: SqlClient,
  limit: number,
  after?: PendingRunCursor,
  through?: PendingRunCursor,
  descending = false
) =>
  sql<{ readonly runId: string; readonly createdAtMs: number | bigint | string }>`
      SELECT run_id AS "runId", created_at_ms AS "createdAtMs" FROM flows_runs
        ${Dialect.isPostgres(sql) ? sql`` : sql`INDEXED BY flows_runs_pending_cancel_idx`}
      WHERE status = 'pending' AND cancel_requested_at_ms IS NOT NULL
        AND ${after === undefined ? sql`TRUE` : sql`(created_at_ms, run_id) > (${after.createdAtMs}, ${after.runId})`}
        AND ${
    through === undefined
      ? sql`TRUE`
      : sql`(created_at_ms, run_id) <= (${through.createdAtMs}, ${through.runId})`
  }
      ORDER BY ${descending ? sql`created_at_ms DESC, run_id DESC` : sql`created_at_ms, run_id`}
      LIMIT ${limit}
    `
