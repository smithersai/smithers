/**
 * The paged parked-run sweeps read through an index over parked rows.
 *
 * R2-Fable-D1-003: each sweep lane reads one `ORDER BY run_id LIMIT` page per
 * heartbeat. With no index over parked rows in that order, the database
 * walked the primary key across every run, settled history included, on every
 * tick of every driver.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import type * as DurableEngineState from "../src/DurableEngineState.ts"
import * as WaitingRunStatements from "../src/internal/WaitingRunStatements.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { seedHistory } from "./PendingQueryPlan.ts"

const lanes: ReadonlyArray<readonly [string, DurableEngineState.WaitingRunsFilter]> = [
  ["cancel-requested", { cancelRequested: true }],
  ["settled-child", { hasChildren: true }]
]

/** How the plan reads `flows_runs`, as text that names every index it uses. */
const planOf = (sql: SqlClient, filter: DurableEngineState.WaitingRunsFilter, afterRunId: string | undefined) =>
  Effect.gen(function*() {
    const statement = WaitingRunStatements.page(sql, filter, { limit: 64, afterRunId })
    if (Dialect.isPostgres(sql)) return JSON.stringify(yield* sql`EXPLAIN (FORMAT JSON) ${statement}`)
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN ${statement}`
    return plan.map((row) => row.detail).join(" | ")
  })

describe("paged parked-run sweeps", () => {
  for (const [lane, filter] of lanes) {
    for (const afterRunId of [undefined, "history-2500"]) {
      it.effect(`reads the ${lane} lane ${afterRunId === undefined ? "from the start" : "after a cursor"} without walking settled history`, () =>
        Effect.gen(function*() {
          const sql = yield* SqlClient
          yield* seedHistory(sql)
          for (const [seq, runId] of ["parked-a", "parked-b", "parked-c"].entries()) {
            yield* sql`INSERT INTO flows_runs
              (run_id, status, created_at_ms, state_json, waiting_reason, cancel_requested_at_ms)
              VALUES (${runId}, 'suspended', 1, '{}', 'event', 5)`
            yield* sql`INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES ('requested', ${runId}, ${seq})`
          }
          yield* sql`ANALYZE flows_runs`
          const evidence = yield* planOf(sql, filter, afterRunId)
          if (Dialect.isPostgres(sql)) {
            expect(evidence).not.toContain("flows_runs_pkey")
            expect(evidence).not.toMatch(/"Node Type":"Seq Scan","[^{}]*"Relation Name":"flows_runs"/)
          } else {
            expect(evidence).toContain("flows_runs USING INDEX flows_runs_parked_page_idx")
            expect(evidence).not.toContain("sqlite_autoindex_flows_runs_1")
            expect(evidence).not.toContain("TEMP B-TREE")
          }
          const rows = yield* WaitingRunStatements.page(sql, filter, { limit: 64, afterRunId })
          expect(rows.map((row) => row.runId)).toEqual(["parked-a", "parked-b", "parked-c"])
        }).pipe(Effect.provide(TestStores.database), Effect.scoped))
    }
  }
})
