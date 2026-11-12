import { afterAll, expect, it } from "@effect/vitest"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { type DurableDeferred, HumanTask } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import type * as Schema from "effect/Schema"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Kit from "../../../examples/use-cases/kit.ts"
import type { SqlCheck } from "../../../examples/use-cases/sql-analyst-dashboard.ts"
import { layer, SqlAnalystDashboard } from "../../../examples/use-cases/sql-analyst-dashboard.ts"

const directory = mkdtempSync(join(tmpdir(), "sql-analyst-dashboard-"))

afterAll(() => rmSync(directory, { recursive: true, force: true }))

/**
 * A person who waits until the run parks on an approval, records the question
 * it published, and answers with `decision` through the token the park
 * declared, as an approvals inbox would.
 */
const reviewer = (executionId: string, decision: typeof Schema.Json.Type, questions: Array<string>) =>
  Layer.effectDiscard(Effect.forkScoped(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting(executionId).pipe(
        Effect.repeat({
          until: (row) => Option.isSome(row) && row.value.reason === "approval",
          schedule: Schedule.spaced(10)
        })
      )
      const parked = Option.getOrThrow(row)
      const request = typeof parked.request === "string" ? JSON.parse(parked.request) : parked.request
      questions.push(`${request.name}: ${request.prompt}`)
      // The waiting row stores the token as plain text; it is the token the park declared.
      yield* HumanTask.answer({ token: parked.token as DurableDeferred.Token, value: decision })
    }).pipe(Effect.orDie)
  ))

type Verdict = Pick<typeof SqlCheck.Type, "approved" | "readOnly" | "hasLimit" | "risk" | "rejectedReasons"> & {
  readonly safeSql?: string
}

const safe: Verdict = { approved: true, readOnly: true, hasLimit: true, risk: "low", rejectedReasons: [] }

/**
 * Agents that answer from the input they are handed. The writer numbers its
 * drafts, the checker answers `verdicts` in order and appends the row limit it
 * was told to the draft, the executor runs the SQL it was handed, and the BI
 * agent reports the SQL and whether a result came back. Each request is
 * recorded in order.
 */
const script = (verdicts: ReadonlyArray<Verdict>) => {
  const turns: Array<string> = []
  const dashboards: Array<Record<string, unknown>> = []
  let drafts = 0
  let checks = 0
  const answer: Kit.Script = (asked) => {
    const input = /\n\nInput: (.+)/.exec(asked)
    if (input === null) return undefined
    const given = JSON.parse(input[1]!)
    if (asked.includes("Inspect the database schema.")) {
      turns.push(`inspect ${given.database} as ${given.dialect}`)
      return {
        tables: [{ name: "orders", columns: [{ name: "channel", type: "TEXT" }], notes: "one row per order" }],
        joins: []
      }
    }
    if (asked.includes("Plan the analytics query.")) {
      turns.push(`plan: ${given.question} over ${given.schemaMap.tables[0].name}`)
      return { question: given.question, requiredTables: ["orders"], metrics: ["gross margin"], filters: [], risks: [] }
    }
    if (asked.includes("Draft read-only SQL")) {
      turns.push(`write after ${given.previousCheck?.rejectedReasons.join("; ") ?? "nothing"}`)
      return { sql: `SELECT channel FROM orders -- draft ${++drafts}`, rowLimit: given.rowLimit, explanation: "" }
    }
    if (asked.includes("Check SQL safety.")) {
      turns.push(`check ${given.draft.sql}`)
      return { safeSql: `${given.draft.sql}\nLIMIT ${given.rowLimit}`, ...verdicts[checks++] }
    }
    if (asked.includes("Execute only the approved read-only SQL.")) {
      turns.push(`execute ${given.sql}`)
      return { columns: ["channel"], rowsPreview: [{ channel: "partner" }], rowCount: 1, executionMs: 4 }
    }
    if (asked.includes("Create a concise dashboard answer")) {
      turns.push("dashboard")
      dashboards.push(given)
      return {
        answer: given.queryResult === null
          ? "Execution was skipped."
          : `Top channel: ${given.queryResult.rowsPreview[0].channel}`,
        chartSpec: { type: given.queryResult === null ? "none" : "bar", x: "channel" },
        caveats: [],
        sqlUsed: given.sqlCheck.safeSql
      }
    }
    return undefined
  }
  return { answer, dashboards, turns }
}

it.effect(
  "drafts again until the check is safe, then runs the query without asking anyone",
  () =>
    Effect.gen(function*() {
      const { answer, dashboards, turns } = script([
        { approved: false, readOnly: true, hasLimit: false, risk: "medium", rejectedReasons: ["missing LIMIT"] },
        safe
      ])
      const dashboard = yield* Kit.run(SqlAnalystDashboard, {}, {
        filename: join(directory, "safe.sqlite"),
        executionId: "sql-safe",
        script: answer,
        actions: layer
      })

      // The second draft was told the first check's reasons, and only the safe
      // SQL ran. No approval was asked: a reviewer-less run that parked would hang.
      expect(turns).toEqual([
        "inspect fixtures/sql-analyst/orders.sqlite as sqlite",
        "plan: Which acquisition channel has the highest 90-day gross margin, and is it trending up or down? over orders",
        "write after nothing",
        "check SELECT channel FROM orders -- draft 1",
        "write after missing LIMIT",
        "check SELECT channel FROM orders -- draft 2",
        "execute SELECT channel FROM orders -- draft 2\nLIMIT 500",
        "dashboard"
      ])
      // The dashboard is handed the raw question, which the caller left out.
      expect(dashboards[0]).not.toHaveProperty("question")
      expect(dashboards[0]?.approval).toBeNull()
      expect(dashboard).toEqual({
        answer: "Top channel: partner",
        chartSpec: { type: "bar", x: "channel" },
        caveats: [],
        sqlUsed: "SELECT channel FROM orders -- draft 2\nLIMIT 500"
      })
    }),
  { timeout: 60_000 }
)

// `it.live`: the reviewer polls the engine's waiting row on a schedule, and a
// test clock nobody advances would leave that poll asleep forever.
it.live("asks a person about a medium-risk query and runs it once approved", () =>
  Effect.gen(function*() {
    const { answer, dashboards, turns } = script([{ ...safe, risk: "medium" }])
    const questions: Array<string> = []
    const executionId = "sql-approved"
    const dashboard = yield* Kit.run(SqlAnalystDashboard, { question: "Which channel converts best?", rowLimit: 50 }, {
      filename: join(directory, "approved.sqlite"),
      executionId,
      script: answer,
      actions: Layer.mergeAll(
        layer,
        reviewer(executionId, { approved: true, reviewer: "dana", note: "fine" }, questions)
      )
    })

    expect(questions).toEqual([
      "approve-query: Approve SQL analyst query\n\nSQL check risk medium; reasons: none\n\nSQL:\nSELECT channel FROM orders -- draft 1\nLIMIT 50"
    ])
    expect(turns).toContain("execute SELECT channel FROM orders -- draft 1\nLIMIT 50")
    expect(dashboards[0]?.question).toBe("Which channel converts best?")
    expect(dashboards[0]?.approval).toEqual({ approved: true, reviewer: "dana", note: "fine" })
    expect(dashboard.answer).toBe("Top channel: partner")
  }), { timeout: 60_000 })

it.live(
  "keeps the last check when the attempts run out and skips execution when it is denied",
  () =>
    Effect.gen(function*() {
      const unsafe = (n: number): Verdict => ({
        approved: false,
        readOnly: false,
        hasLimit: true,
        risk: "high",
        rejectedReasons: [`draft ${n} deletes rows`]
      })
      const { answer, dashboards, turns } = script([unsafe(1), unsafe(2), unsafe(3)])
      const questions: Array<string> = []
      const executionId = "sql-denied"
      const dashboard = yield* Kit.run(SqlAnalystDashboard, { maxSqlAttempts: 2 }, {
        filename: join(directory, "denied.sqlite"),
        executionId,
        script: answer,
        actions: Layer.mergeAll(
          layer,
          reviewer(executionId, { approved: false, reviewer: "dana", note: "no" }, questions)
        )
      })

      // Two rounds, then the second check stands; the denial skips execution.
      expect(turns.slice(2)).toEqual([
        "write after nothing",
        "check SELECT channel FROM orders -- draft 1",
        "write after draft 1 deletes rows",
        "check SELECT channel FROM orders -- draft 2",
        "dashboard"
      ])
      expect(questions).toEqual([
        "approve-query: Approve SQL analyst query\n\nSQL check risk high; reasons: draft 2 deletes rows\n\nSQL:\nSELECT channel FROM orders -- draft 2\nLIMIT 500"
      ])
      expect(dashboards[0]?.queryResult).toBeNull()
      expect(dashboards[0]?.approval).toEqual({ approved: false, reviewer: "dana", note: "no" })
      expect(dashboard.answer).toBe("Execution was skipped.")
      expect(dashboard.sqlUsed).toBe("SELECT channel FROM orders -- draft 2\nLIMIT 500")
    }),
  { timeout: 60_000 }
)

for (const approved of [false, true]) {
  for (
    const { name, verdict, sql } of [
      { name: "mutating", verdict: { ...safe, readOnly: false }, sql: "DELETE FROM orders" },
      { name: "unlimited", verdict: { ...safe, hasLimit: false }, sql: "SELECT channel FROM orders" },
      { name: "rejected", verdict: { ...safe, approved: false }, sql: "SELECT channel FROM orders LIMIT 20" }
    ]
  ) {
    it.live(
      `asks about a standing ${name} check and ${approved ? "applies approval" : "honors denial"}`,
      () =>
        Effect.gen(function*() {
          const { answer, dashboards, turns } = script([{ ...verdict, safeSql: sql }])
          const questions: Array<string> = []
          const executionId = `sql-${name}-${approved}`
          const decision = { approved, reviewer: "dana", note: approved ? "reviewed" : "no" }
          const dashboard = yield* Kit.run(SqlAnalystDashboard, { maxSqlAttempts: 1, rowLimit: 20 }, {
            filename: join(directory, `${executionId}.sqlite`),
            executionId,
            script: answer,
            actions: Layer.mergeAll(layer, reviewer(executionId, decision, questions))
          })

          expect(questions).toEqual([
            `approve-query: Approve SQL analyst query\n\nSQL check risk low; reasons: none\n\nSQL:\n${sql}`
          ])
          const mayRun = approved && verdict.readOnly
          expect(turns.filter((turn) => turn.startsWith("execute"))).toEqual(mayRun ? [`execute ${sql}`] : [])
          expect(turns.filter((turn) => turn.startsWith("check"))).toHaveLength(1)
          expect(dashboards[0]?.approval).toEqual(decision)
          if (mayRun) {
            expect(dashboards[0]?.queryResult).toMatchObject({ rowCount: 1 })
          } else {
            expect(dashboards[0]?.queryResult).toBeNull()
          }
          expect(dashboard.answer).toBe(mayRun ? "Top channel: partner" : "Execution was skipped.")
          expect(dashboard.sqlUsed).toBe(sql)
        }),
      { timeout: 60_000 }
    )
  }
}
