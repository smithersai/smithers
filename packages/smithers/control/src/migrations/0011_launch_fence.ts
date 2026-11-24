/**
 * Durable executor handoff for newly admitted runs.
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/** The executor handoff belongs to one run-store ownership nonce.
 * @category migrations
 * @since 1.0.0
 */
export const launchFence = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_runs")
    if (!columns.some((column) => column.name === "handing_nonce")) {
      yield* sql`ALTER TABLE control_runs ADD COLUMN handing_nonce TEXT`
    }
  }))
})
