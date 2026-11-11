import * as Dialect from "@smthrs/database/Dialect"
import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { Fragment } from "effect/sql/Statement"
import { expect } from "vitest"

/** Enough settled history that an unbounded PostgreSQL scan is not the cheapest plan. */
export const seedHistory = (sql: SqlClient) =>
  Effect.gen(function*() {
    for (let offset = 0; offset < 5_000; offset += 500) {
      yield* sql`INSERT INTO flows_runs ${
        sql.insert(Arr.makeBy(500, (index) => ({
          run_id: `history-${offset + index}`,
          status: "cancelled",
          created_at_ms: 0,
          state_json: JSON.stringify({ version: 1, flowName: "history", payload: {} }),
          cancel_requested_at_ms: 0
        })))
      }`
    }
    yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json, cancel_requested_at_ms)
      VALUES ('requested', 'pending', 2, ${JSON.stringify({ version: 1, flowName: "child", payload: {} })}, 0)`
    yield* sql`ANALYZE flows_runs`
  })

/** Inspect the production statement, on whichever backend the storage matrix selected. */
export const assertIndexed = (sql: SqlClient, statement: Fragment, index: string) =>
  Effect.gen(function*() {
    if (Dialect.isPostgres(sql)) {
      const plan = yield* sql`EXPLAIN (FORMAT JSON) ${statement}`
      const evidence = JSON.stringify(plan)
      expect(evidence).toContain(index)
      expect(evidence).not.toContain("Seq Scan")
      expect(evidence).not.toMatch(/\"Node Type\":\"(?:Incremental )?Sort\"/)
    } else {
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN ${statement}`
      const evidence = plan.map((row) => row.detail).join(" ")
      expect(evidence).toContain(`SEARCH flows_runs USING INDEX ${index}`)
      expect(evidence).not.toContain("TEMP B-TREE")
    }
  })
