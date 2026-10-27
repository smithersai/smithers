/**
 * How long a sandbox command takes beyond its own run time when a run calls
 * it on Cloudflare: a run's step executes the command's `SandboxCommand` job
 * as a child execution (as the TODO agent's `run` tool does) and waits for
 * its result. Every object builds a fresh runtime for every alarm, over a real
 * Postgres, optionally behind a slow network that charges each round trip
 * what a Worker pays through Hyperdrive. Method and numbers:
 * docs/guides/command-latency.md.
 */
import { describe, expect, it } from "@effect/vitest"
import * as SlowNetwork from "@smthrs/database/test/SlowNetwork"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import { randomUUID } from "node:crypto"
import { ExecutionObject } from "../src/index.ts"
import * as CommandFlows from "./fixtures/CommandFlows.ts"
import * as Objects from "./fixtures/Objects.ts"
import * as Postgres from "./fixtures/Postgres.ts"
import * as StatementTrace from "./fixtures/StatementTrace.ts"

/**
 * The round trip each statement pays in the benchmark: `COMMAND_LATENCY_RTT_MS`, 25 ms unless set, what a statement
 * cost production's Durable Objects through Hyperdrive on 2026-10-22 (5 s for the 198 statements of a job's first two
 * steps).
 */
const benchRttMs = Number(process.env.COMMAND_LATENCY_RTT_MS ?? "25")

/**
 * One command call of a run with `warm` steps before it, its command exiting `exitAfterMs` after it starts, over
 * Postgres at `rttMs` a round trip, the run calling the job through `call` (`execute` is how calls ran before `run`):
 * call to answer, and every object's alarms.
 */
const measure = (options: {
  readonly warm: number
  readonly exitAfterMs: number
  readonly rttMs: number
  readonly call: "run" | "execute"
  /** Each alarm's drive budget: `ExecutionObject.defaultDriveBudgetMs` unless set. */
  readonly driveBudgetMs?: number
}) =>
  Effect.gen(function*() {
    const { call, rttMs } = options
    const schema = Postgres.freshSchema()
    const scope = yield* Scope.make()
    const url = rttMs === 0
      ? Postgres.url
      : yield* Scope.provide(SlowNetwork.proxy(Postgres.url, { delayMs: rttMs / 2 }), scope)
    const trace = process.env.COMMAND_LATENCY_TRACE === undefined
      ? undefined
      : yield* Scope.provide(StatementTrace.proxy(url), scope)
    const timeline = CommandFlows.timeline()
    const objects = Objects.make({
      ...(options.driveBudgetMs === undefined ? {} : { driveBudgetMs: options.driveBudgetMs }),
      flows: CommandFlows.flows,
      runtime: CommandFlows.runtime({
        timeline,
        exitAfterMs: options.exitAfterMs,
        database: Postgres.database(schema, trace?.url ?? url),
        call
      })
    })
    const callId = randomUUID()
    const runId = `caller-${callId}`
    return yield* Effect.gen(function*() {
      const intent = yield* ExecutionObject.intent(CommandFlows.Caller, {
        executionId: runId,
        payload: { callId, command: "git status", warm: options.warm }
      })
      yield* ExecutionObject.start(objects.object(runId).storage, intent, Effect.void)
      const began = Date.now()
      const alarmMarks: Array<[string, number]> = []
      // Cloudflare's scheduler: the earliest armed alarm fires when it is due, one handler at a time, until the
      // caller's object records its execution settled.
      while (!objects.object(runId).values.has(ExecutionObject.settledKey)) {
        const next = [...objects.objects]
          .flatMap(([id, object]) => (object.alarm() === null ? [] : [{ id, at: object.alarm()! }]))
          .sort((left, right) => left.at - right.at)[0]
        if (next === undefined) return yield* Effect.die("nothing is armed and the caller has not settled")
        yield* Effect.sleep(Math.max(0, next.at - Date.now()))
        const kind = next.id === runId ? "caller" : next.id.startsWith("command:") ? "job" : "round"
        alarmMarks.push([`alarm.${kind}.start`, Date.now()])
        yield* objects.alarm(next.id)
        alarmMarks.push([`alarm.${kind}.end`, Date.now()])
      }
      const settled = Date.now() - began
      const called = timeline.called.get(callId)!
      const answered = timeline.answered.get(callId)!
      // Each object's alarms in order, a retried one with what failed: `caller`, `job`, then `round1`, `round2`...
      let rounds = 0
      const alarms = Object.fromEntries([...objects.outcomes].map(([id, outcomes]) => [
        id === runId ? "caller" : id.startsWith("command:") ? "job" : `round${++rounds}`,
        outcomes.map((outcome) =>
          outcome._tag === "Retrying" ? `Retrying(${outcome.failure.split("/").at(-1)})` : outcome._tag
        ).join(",")
      ]))
      // Each execution's rows, in ms from the call: created, claimed and settled, as production's run store shows them.
      const rows = yield* Effect.promise(() =>
        Postgres.admin(Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<
            { run_id: string; created_at_ms: string; started_at_ms: string | null; finished_at_ms: string | null }
          >`
            SELECT run_id, created_at_ms, started_at_ms, finished_at_ms FROM ${sql(schema)}.flows_runs
            ORDER BY created_at_ms, round_ordinal`
        }))
      )
      const events = yield* Effect.promise(() =>
        Postgres.admin(Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          return yield* sql<{ run_id: string; event_type: string; emitted_at_ms: string; seq: string }>`
            SELECT run_id, event_type, emitted_at_ms, seq FROM ${sql(schema)}.flows_journal_events ORDER BY run_id, seq`
        }))
      )
      if (process.env.COMMAND_LATENCY_DUMP !== undefined) {
        for (const event of events) {
          console.log(
            `command-latency-event ${event.run_id === runId ? "caller" : event.run_id.slice(0, 12)} ${event.seq} ${
              Number(event.emitted_at_ms) - called
            } ${event.event_type}`
          )
        }
      }
      const at = (value: string | null) => (value === null ? null : Number(value) - called)
      const runs = rows.map((row) => [
        row.run_id === runId ? "caller" : row.run_id.startsWith("command:") ? "job" : "round",
        at(row.created_at_ms),
        at(row.started_at_ms),
        at(row.finished_at_ms)
      ])
      const line = {
        call,
        rttMs,
        warm: options.warm,
        exitAfterMs: options.exitAfterMs,
        driveBudgetMs: options.driveBudgetMs,
        overheadMs: answered - called - options.exitAfterMs,
        settledMs: settled,
        callRuns: timeline.runs.get(callId),
        objects: objects.objects.size,
        alarms,
        runs
      }
      if (trace !== undefined) {
        const counts = new Map<string, number>()
        const during = trace.statements.filter((statement) => statement.at >= called && statement.at <= answered)
        for (const statement of during) {
          const key = statement.sql.replace(schema, "S").slice(0, 110)
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        console.log(
          `command-latency-trace total=${trace.statements.length} roundTrips=${trace.roundTrips()} during=${during.length}`
        )
        // Statements in each stretch between consecutive run-row times, from the call to the answer.
        const marks = [
          ["call", called],
          ...rows.flatMap((row) => {
            const kind = row.run_id === runId ? "caller" : row.run_id.startsWith("command:") ? "job" : "round"
            return [
              [`${kind}.created`, Number(row.created_at_ms)],
              [`${kind}.claimed`, row.started_at_ms === null ? NaN : Number(row.started_at_ms)],
              [`${kind}.settled`, row.finished_at_ms === null ? NaN : Number(row.finished_at_ms)]
            ] as Array<[string, number]>
          }),
          ["answer", answered],
          ...alarmMarks
        ].filter(([, time]) => Number.isFinite(time) && (time as number) >= called && (time as number) <= answered)
          .sort((left, right) => (left[1] as number) - (right[1] as number)) as Array<[string, number]>
        const stretches = marks.slice(1).map(([name, time], index) => {
          const [from, since] = marks[index]!
          const count = trace.statements.filter((statement) => statement.at >= since && statement.at < time).length
          return `${from}->${name} ${time - since}ms ${count}st`
        })
        console.log(`command-latency-stretches ${stretches.join(" | ")}`)
        if (process.env.COMMAND_LATENCY_DUMP !== undefined) {
          const lines = [
            ...marks.map(([name, time]) => `${time} MARK ${name}`),
            ...trace.statements.filter((statement) => statement.at >= called && statement.at <= answered)
              .map((statement) => `${statement.at} ${statement.sql.replace(schema, "S")}`)
          ].sort()
          console.log(lines.map((line) => `command-latency-dump ${line}`).join("\n"))
        }
        for (const [sql, count] of [...counts].sort((left, right) => right[1] - left[1]).slice(0, 60)) {
          console.log(`command-latency-sql ${String(count).padStart(5)} ${sql}`)
        }
      }
      // The benchmark's record: what the guide's table quotes.
      console.log(`command-latency ${JSON.stringify(line)}`)
      return line
    }).pipe(
      Effect.ensuring(Effect.promise(() => Postgres.dropSchema(schema))),
      Effect.ensuring(Scope.close(scope, undefined as never))
    )
  })

describe.skipIf(!Postgres.direct.available)("a sandbox command's overhead on Cloudflare", () => {
  it.live(
    "a command that exits at once answers the step that called it within five seconds",
    () =>
      Effect.gen(function*() {
        const line = yield* measure({ warm: 3, exitAfterMs: 0, rttMs: 25, call: "run" })
        expect(line.overheadMs).toBeLessThan(5_000)
        // Done in the step: the caller's one object, which never parked, and no execution of the job.
        expect(line.objects).toBe(1)
        expect(line.callRuns).toBe(1)
      }),
    { timeout: 120_000 }
  )
})

// The benchmark (docs/guides/command-latency.md): `COMMAND_LATENCY_BENCH=1`, every way a call ran, over Postgres at
// `COMMAND_LATENCY_RTT_MS`; each case prints its `command-latency` line. `COMMAND_LATENCY_TRACE=1` adds the statements
// each stretch sent.
describe.runIf(Postgres.direct.available && process.env.COMMAND_LATENCY_BENCH !== undefined)(
  "the command latency benchmark",
  () => {
    for (const call of ["execute", "run"] as const) {
      for (const exitAfterMs of [0, 30_000]) {
        it.live(
          `${call}, a command that exits ${exitAfterMs / 1000} s after it starts`,
          () => Effect.asVoid(measure({ warm: 20, exitAfterMs, rttMs: benchRttMs, call })),
          { timeout: 600_000 }
        )
      }
    }
    // Past the step's wait: the drive's budget ends while the command runs, so it goes on as its job and the run parks.
    it.live(
      "run, a command that outlives its drive's budget",
      () =>
        Effect.asVoid(
          measure({ warm: 20, exitAfterMs: 30_000, rttMs: benchRttMs, call: "run", driveBudgetMs: 10_000 })
        ),
      { timeout: 600_000 }
    )
  }
)
