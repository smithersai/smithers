/**
 * Lineage indexes restricted to the execution that produced each edge.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Replaces lineage probes so copied fork history cannot own another run's children.
 *
 * @since 0.1.0
 * @private
 */
export const lineageProvenance = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* step("the old child-spawn index", sql`DROP INDEX IF EXISTS flows_journal_events_child_spawn_idx`)
  yield* step("the old handoff index", sql`DROP INDEX IF EXISTS flows_journal_events_handoff_idx`)
  // Match the provenance predicates in edgesUnder. Fork copies prefix event
  // ids with a reserved prefix; handoffs have no source run in their payload.
  yield* step(
    "flows_journal_events_child_spawn_idx on flows_journal_events",
    sql`CREATE INDEX flows_journal_events_child_spawn_idx
    ON flows_journal_events (run_id, seq)
    WHERE event_type = 'flows.time-travel.effect-boundary'
      AND ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.kind")} = 'flows/engine-store/child-spawn'
      AND run_id = ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.runId")}`
  )
  yield* step(
    "flows_journal_events_handoff_idx on flows_journal_events",
    sql`CREATE INDEX flows_journal_events_handoff_idx
    ON flows_journal_events (run_id, seq)
    WHERE event_type = 'flows.engine.run-decision'
      AND ${
      Dialect.jsonText(sql, sql`payload_json`, "$.decision")
    } = 'handed-off' AND substr(event_id, 1, 5) <> 'fork:'`
  )
})
