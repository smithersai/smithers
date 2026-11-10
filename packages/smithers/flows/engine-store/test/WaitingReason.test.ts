import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { type Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as Migrations from "../src/Migrations.vibe"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = {
  hostId: "waiting-reason",
  pid: 1,
  nonce: "owner"
}

const otherOwner: Ownership.OwnerId = {
  hostId: "waiting-reason",
  pid: 2,
  nonce: "other"
}

const migratedDatabase = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

const insertRunningRun = (runId: string, forOwner: Ownership.OwnerId = owner) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id,
        status,
        created_at_ms,
        owner_host_id,
        owner_pid,
        owner_nonce,
        heartbeat_at_ms,
        state_json
      ) VALUES (
        ${runId},
        'running',
        0,
        ${forOwner.hostId},
        ${forOwner.pid},
        ${forOwner.nonce},
        0,
        '{}'
      )
    `
  })

describe("waiting-reason taxonomy", () => {
  for (const reason of ["approval", "event", "timer", "quota"] as const) {
    it.effect(`round-trips a ${reason} park across a fresh engine-state instance`, () =>
      Effect.gen(function*() {
        const result = yield* withCrypto(
          Effect.gen(function*() {
            const runId = `park-${reason}`
            yield* insertRunningRun(runId)
            const first = yield* DurableEngineState.make

            const parked = yield* first.park(runId, { reason, wakeAt: 1_000, token: `token-${reason}` }, owner)

            // Simulate a process restart: a fresh service instance over the
            // same underlying database must observe the durable payload.
            const restarted = yield* DurableEngineState.make
            const afterRestart = Option.getOrThrow(yield* restarted.waiting(runId))

            const woken = yield* restarted.wake(runId)
            const afterWake = yield* restarted.waiting(runId)

            return { parked, afterRestart, woken, afterWake }
          }).pipe(Effect.provide(migratedDatabase))
        )

        expect(result.parked).toEqual({
          _tag: "Parked",
          row: { runId: `park-${reason}`, reason, wakeAt: 1_000, token: `token-${reason}` }
        })
        expect(result.afterRestart).toEqual({
          runId: `park-${reason}`,
          reason,
          wakeAt: 1_000,
          token: `token-${reason}`
        })
        expect(result.woken).toEqual({
          _tag: "Woken",
          row: { runId: `park-${reason}`, reason, wakeAt: 1_000, token: `token-${reason}` }
        })
        expect(Option.isNone(result.afterWake)).toBe(true)
      }))
  }

  it.effect("decodes a NULL-reason row (a running, unparked run) as not waiting", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const runId = "null-reason"
          yield* insertRunningRun(runId)
          const state = yield* DurableEngineState.make
          return {
            waiting: yield* state.waiting(runId),
            waitingRuns: yield* state.waitingRuns(),
            woken: yield* state.wake(runId)
          }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(Option.isNone(result.waiting)).toBe(true)
      expect(result.waitingRuns).toEqual([])
      expect(result.woken).toEqual({ _tag: "NotWaiting" })
    }))

  it.effect("rejects a park attempt from a non-owning process", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const runId = "owner-fenced"
          yield* insertRunningRun(runId, owner)
          const state = yield* DurableEngineState.make
          const attempt = yield* state.park(runId, { reason: "approval" }, otherOwner)
          const afterAttempt = yield* state.waiting(runId)
          return { attempt, afterAttempt }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(result.attempt).toEqual({ _tag: "NotFound" })
      expect(Option.isNone(result.afterAttempt)).toBe(true)
    }))

  it.effect("reports NotFound when waking a run that does not exist", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        DurableEngineState.make.pipe(
          Effect.flatMap((state) => state.wake("does-not-exist")),
          Effect.provide(migratedDatabase)
        )
      )

      expect(result).toEqual({ _tag: "NotFound" })
    }))

  it.effect("omits wakeAt/token when a park does not provide them", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const runId = "event-no-wake-at"
          yield* insertRunningRun(runId)
          const state = yield* DurableEngineState.make
          yield* state.park(runId, { reason: "event" }, owner)
          return Option.getOrThrow(yield* state.waiting(runId))
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(result).toEqual({ runId: "event-no-wake-at", reason: "event", wakeAt: null, token: null })
    }))

  it.effect("returns exactly the due quota-parked run and not others via waitingRuns", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const dueQuota = "due-quota"
          const futureQuota = "future-quota"
          const dueApproval = "due-approval"
          for (const runId of [dueQuota, futureQuota, dueApproval]) {
            yield* insertRunningRun(runId)
          }
          const state = yield* DurableEngineState.make
          yield* state.park(dueQuota, { reason: "quota", wakeAt: 500 }, owner)
          yield* state.park(futureQuota, { reason: "quota", wakeAt: 5_000 }, owner)
          yield* state.park(dueApproval, { reason: "approval", wakeAt: 100 }, owner)

          return {
            dueQuotaRuns: yield* state.waitingRuns({ reason: "quota", dueBeforeMs: 1_000 }),
            allQuotaRuns: yield* state.waitingRuns({ reason: "quota" }),
            allWaiting: yield* state.waitingRuns()
          }
        }).pipe(Effect.provide(migratedDatabase))
      )

      expect(result.dueQuotaRuns).toEqual([
        { runId: "due-quota", reason: "quota", wakeAt: 500, token: null }
      ])
      expect(result.allQuotaRuns.map((row) => row.runId).sort()).toEqual(["due-quota", "future-quota"])
      expect(result.allWaiting).toHaveLength(3)
    }))
})
