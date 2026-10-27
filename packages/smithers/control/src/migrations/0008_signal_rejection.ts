/**
 * Persist the outcome of a rejected signal.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"

/** Adds the rejection outcome, preserving legacy no-match rejections.
 * @category migrations
 * @since 1.0.0
 */
export const signalRejection = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const columns = yield* Dialect.columns(sql, "control_signal_commands")
    if (columns.some((column) => column.name === "rejection")) return
    yield* sql`ALTER TABLE control_signal_commands ADD COLUMN rejection TEXT CHECK (rejection IS NULL OR rejection = 'unauthorized')`
  }))
})
