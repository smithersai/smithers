/**
 * Durable executor handoff for newly admitted runs.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/** Legacy rows cannot prove their executor never started. Only new admissions open a handoff.
 * @category migrations
 * @since 1.0.0
 */
export const launchHandoff = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_runs")
    if (!columns.some((column) => column.name === "launch_pending")) {
      yield* sql`ALTER TABLE control_runs ADD COLUMN launch_pending INTEGER NOT NULL DEFAULT 0`
    }
  }))
})
