import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { RunStore } from "@smthrs/run-store"
import { heartbeatStaleAfter } from "@smthrs/run-store/Ownership"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/sql/SqlClient"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { TimeTravel } from "../src/TimeTravel.vibe"
import {
  awaitCheckpoint,
  jjInstalled,
  Journal,
  killHard,
  runReal,
  runRealEngine,
  withRealFixture
} from "./RealTimeTravelHarness.ts"

const childFixture = fileURLToPath(new URL("./fixtures/rewind-in-flight-child.ts", import.meta.url))
const hostId = "time-travel-in-flight-host"

interface LiveRow {
  readonly heartbeat_at_ms: number | null
  readonly owner_pid: number | null
  readonly status: string
}

const readLiveRow = (filename: string, runId: string) =>
  runReal(
    filename,
    Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const rows = yield* sql<LiveRow>`
        SELECT status, owner_pid, heartbeat_at_ms
        FROM flows_runs WHERE run_id = ${runId}
      `
      if (rows[0] === undefined) return yield* Effect.die(new Error(`run ${runId} was not persisted`))
      return rows[0]
    })
  )

const waitForHeartbeatAfter = (
  filename: string,
  runId: string,
  initial: number
) =>
  Effect.gen(function*() {
    const deadline = Date.now() + 15_000
    let observed = yield* readLiveRow(filename, runId)
    while ((observed.heartbeat_at_ms ?? -1) <= initial && Date.now() < deadline) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      observed = yield* readLiveRow(filename, runId)
    }
    if ((observed.heartbeat_at_ms ?? -1) <= initial) {
      throw new Error(`heartbeat did not advance from ${initial}: ${JSON.stringify(observed)}`)
    }
    return observed
  })

const waitUntilStale = (filename: string, runId: string) =>
  Effect.gen(function*() {
    const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)
    const deadline = Date.now() + staleAfterMs + 15_000
    let observed = yield* readLiveRow(filename, runId)
    while (
      observed.heartbeat_at_ms !== null &&
      Date.now() - observed.heartbeat_at_ms <= staleAfterMs &&
      Date.now() < deadline
    ) {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
      observed = yield* readLiveRow(filename, runId)
    }
    if (observed.heartbeat_at_ms === null || Date.now() - observed.heartbeat_at_ms <= staleAfterMs) {
      throw new Error(`dead owner did not become stale: ${JSON.stringify(observed)}`)
    }
    return observed
  })

describe.skipIf(!jjInstalled)("rewind versus a genuinely in-flight engine", () => {
  // The finite budget covers a live heartbeat, one SIGKILL, stale-owner adoption, and fresh file-backed layers.
  it.live(
    "is inert while the real owner is live and succeeds after that owner is proven dead",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-rewind-in-flight-", (fixture) =>
          Effect.gen(function*() {
            const runId = "in-flight-run"
            const child = spawn(process.execPath, [childFixture, fixture.databaseFile, runId, hostId], {
              cwd: fixture.repository,
              env: { ...process.env, JJ_EDITOR: "true" }
            })
            const childPid = child.pid
            if (childPid === undefined) throw new Error("spawn did not assign a child pid")
            try {
              expect(
                yield* Effect.promise(() => awaitCheckpoint<{ readonly status: string }>(child, "in-flight child"))
              )
                .toEqual({ status: "in-flight" })
              const firstLive = yield* readLiveRow(fixture.databaseFile, runId)
              expect(firstLive).toMatchObject({ status: "running", owner_pid: childPid })
              const advanced = yield* waitForHeartbeatAfter(
                fixture.databaseFile,
                runId,
                firstLive.heartbeat_at_ms ?? -1
              )
              expect(advanced.owner_pid).toBe(childPid)

              const busy = yield* runRealEngine(
                fixture.databaseFile,
                hostId,
                Effect.gen(function*() {
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const before = yield* sql<{
                    readonly archive_count: number
                    readonly audit_count: number
                    readonly journal_count: number
                    readonly maximum: number
                    readonly receipt_count: number
                  }>`
                SELECT
                  (SELECT COUNT(*) FROM flows_journal_events WHERE run_id = ${runId}) AS journal_count,
                  (SELECT MAX(seq) FROM flows_journal_events WHERE run_id = ${runId}) AS maximum,
                  (SELECT COUNT(*) FROM flows_time_travel_audits WHERE run_id = ${runId}) AS audit_count,
                  (SELECT COUNT(*) FROM flows_time_travel_archive WHERE run_id = ${runId}) AS archive_count,
                  (SELECT COUNT(*) FROM flows_time_travel_receipts) AS receipt_count
              `
                  const timeTravel = yield* TimeTravel
                  // The frame's lineage comes from the constructor that mints it. Re-derived on
                  // 2026-09-01: `FlowEngine.Lineage` moved the root address from `<runId>/root`
                  // to a versioned encoded tuple, so the old literal named a lineage the engine
                  // no longer writes.
                  const refusal = yield* Effect.flip(timeTravel.rewind({
                    runId,
                    frame: { lineageId: FlowEngine.Lineage.root(runId), seq: 0 }
                  }))
                  const after = yield* sql<{
                    readonly archive_count: number
                    readonly audit_count: number
                    readonly journal_count: number
                    readonly maximum: number
                    readonly receipt_count: number
                  }>`
                SELECT
                  (SELECT COUNT(*) FROM flows_journal_events WHERE run_id = ${runId}) AS journal_count,
                  (SELECT MAX(seq) FROM flows_journal_events WHERE run_id = ${runId}) AS maximum,
                  (SELECT COUNT(*) FROM flows_time_travel_audits WHERE run_id = ${runId}) AS audit_count,
                  (SELECT COUNT(*) FROM flows_time_travel_archive WHERE run_id = ${runId}) AS archive_count,
                  (SELECT COUNT(*) FROM flows_time_travel_receipts) AS receipt_count
              `
                  return { after: after[0]!, before: before[0]!, refusal }
                })
              )

              expect(busy.refusal.code).toBe("busy")
              expect(busy.after).toEqual(busy.before)
              expect(busy.after.audit_count).toBe(0)
              expect(busy.after.archive_count).toBe(0)
              expect(busy.after.receipt_count).toBe(0)

              yield* Effect.promise(() => killHard(child))
              let deathCode: string | undefined
              try {
                process.kill(childPid, 0)
              } catch (cause) {
                deathCode = (cause as NodeJS.ErrnoException).code
              }
              expect(deathCode).toBe("ESRCH")
              const stale = yield* waitUntilStale(fixture.databaseFile, runId)
              expect(stale).toMatchObject({ status: "running", owner_pid: childPid })

              // Rebuild through the same native loader as the killed host.
              // Vitest transforms function source and is a different declaration.
              const recovery = spawn(process.execPath, [childFixture, fixture.databaseFile, runId, hostId, "recover"], {
                cwd: fixture.repository,
                env: { ...process.env, JJ_EDITOR: "true" }
              })
              const exited = once(recovery, "exit")
              try {
                expect(yield* Effect.promise(() => awaitCheckpoint(recovery, "recovery child")))
                  .toEqual({ status: "recovered" })
                expect(yield* Effect.promise(() => exited)).toEqual([0, null])
              } finally {
                yield* Effect.promise(() => killHard(recovery))
              }

              const recovered = yield* runRealEngine(
                fixture.databaseFile,
                hostId,
                Effect.gen(function*() {
                  const journal = yield* Journal.Journal
                  yield* journal.flush
                  const runs = yield* RunStore.RunStore
                  const parked = yield* runs.get(runId)
                  const timeTravel = yield* TimeTravel
                  const rewind = yield* timeTravel.rewind({
                    runId,
                    frame: { lineageId: FlowEngine.Lineage.root(runId), seq: 0 }
                  })
                  const sql = yield* Effect.service(SqlClient.SqlClient)
                  const live = yield* sql<{ readonly seq: number }>`
                SELECT seq FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq
              `
                  const audits = yield* sql<{ readonly status: string }>`
                SELECT status FROM flows_time_travel_audits WHERE run_id = ${runId}
              `
                  return { audits, live, parked, rewind }
                })
              )

              expect(recovered.parked).toMatchObject({ status: "suspended", owner: null })
              expect(recovered.rewind.archive.archived).toBeGreaterThan(0)
              expect(recovered.live).toEqual([{ seq: 0 }])
              expect(recovered.audits).toEqual([{ status: "completed" }])
            } finally {
              yield* Effect.promise(() => killHard(child))
            }
          }))
      }),
    { timeout: 90_000 }
  )
})
