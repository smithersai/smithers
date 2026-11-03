/**
 * Retryable fork intent reclamation.
 *
 * @since 1.0.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Records completed lane removal separately from claiming an abandoned intent.
 * Older reclaimed rows remain pending until their lane is forgotten again.
 *
 * @since 1.0.0
 * @private
 */
export const forkIntentForgotten = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const columns = yield* Dialect.columns(sql, "flows_time_travel_fork_intents")
  if (columns.some((column) => column.name === "forgotten_at_ms")) return
  yield* step(
    "the flows_time_travel_fork_intents forgotten_at_ms column",
    sql`ALTER TABLE flows_time_travel_fork_intents ADD COLUMN forgotten_at_ms ${Dialect.integer(sql)} CHECK (
      forgotten_at_ms IS NULL OR (${
      Dialect.isInteger(sql, sql`forgotten_at_ms`)
    } AND forgotten_at_ms >= 0 AND forgotten_at_ms <= 9007199254740991)
    )`
  )
})
