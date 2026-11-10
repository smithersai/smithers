import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Duration, Effect, Exit } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { heartbeatSkewAllowance, heartbeatStaleAfter } from "../src/Heartbeat.ts"
import * as Migrations from "../src/Migrations.vibe"
import type { LivenessEvidence, OwnerId } from "../src/Ownership.vibe"
import { type RunRow, type RunSnapshot, RunStore } from "../src/RunStore.vibe"
import * as RunStoreLive from "../src/RunStore.vibe"

const owner: OwnerId = { hostId: "lease-host", pid: 17, nonce: "lease-owner" }
const peer: OwnerId = { hostId: "lease-host", pid: 18, nonce: "lease-peer" }
const pending: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }
const skewMs = Duration.toMillis(heartbeatSkewAllowance)
const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)
const farFutureMs = 8_000_000_000_000

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const leaseExpired = (expectedOwner: OwnerId, checkedAtMs: number): LivenessEvidence => ({
  expectedOwner,
  checkedAtMs,
  kind: "lease-expired"
})

const failure = (exit: Exit.Exit<unknown, RunStoreLive.RunStoreError>): RunStoreLive.RunStoreError | undefined =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>
) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

const activate = (store: RunStoreLive.Service, runId: string) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    expect(
      yield* store.claimAndOwn(
        runId,
        { status: "pending", owner: null, heartbeatAtMs: null },
        owner,
        100
      )
    ).toEqual({ _tag: "Activated" })
  })

describe("RunStore heartbeat timestamp ordering", () => {
  // A late-arriving heartbeat with an older caller timestamp still reports
  // `Updated` — the fence held and the write proves liveness — but it never
  // moves `heartbeat_at_ms` backwards, so a live run cannot be made to look
  // stale to `claimAndOwn`/`steal`'s cutoff by a delayed packet.
  it.effect("keeps the lease timestamp monotonic when an older heartbeat arrives late", () =>
    Effect.gen(function*() {
      const rows = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-monotonic")
          yield* TestClock.adjust("200 millis")
          expect(yield* store.heartbeat("lease-monotonic", owner, 200)).toEqual({ _tag: "Updated" })
          expect(yield* store.heartbeat("lease-monotonic", owner, 150)).toEqual({ _tag: "Updated" })
          const afterLate = yield* store.get("lease-monotonic")
          yield* TestClock.adjust("50 millis")
          expect(yield* store.heartbeat("lease-monotonic", owner, 250)).toEqual({ _tag: "Updated" })
          return { afterLate, afterNewer: yield* store.get("lease-monotonic") }
        })
      )

      expect(rows.afterLate.heartbeatAtMs).toBe(200)
      // A genuinely newer heartbeat still advances the lease.
      expect(rows.afterNewer.heartbeatAtMs).toBe(250)
    }))

  it.effect("refuses a heartbeat that runs ahead of the store clock past the skew allowance, so a lease cannot be pinned", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-future")
          const atAllowance = yield* store.heartbeat("lease-future", owner, skewMs)
          const pastAllowance = yield* Effect.exit(store.heartbeat("lease-future", owner, skewMs + 1))
          const farFuture = yield* Effect.exit(store.heartbeat("lease-future", owner, farFutureMs))
          const row = yield* store.get("lease-future")
          // The admitted lease goes stale on schedule and a peer takes it at
          // its own clock reading: nothing the refused pulses carried survived.
          yield* TestClock.adjust(Duration.millis(skewMs + staleAfterMs + 1))
          const nowMs = yield* Clock.currentTimeMillis
          const stolen = yield* store.steal("lease-future", snapshot(row), peer, nowMs, leaseExpired(owner, nowMs))
          return { atAllowance, pastAllowance, farFuture, row, stolen, nowMs }
        })
      )

      // CONTRACT: the caller's reading is judged literally inside the skew
      // allowance and refused beyond it. The refusal is typed and leaves the
      // row untouched, so a runaway caller clock cannot pin the lease.
      expect(result.atAllowance).toEqual({ _tag: "Updated" })
      expect(result.row.heartbeatAtMs).toBe(skewMs)
      for (const exit of [result.pastAllowance, result.farFuture]) {
        expect(failure(exit)).toEqual(expect.objectContaining({ code: "invalid_run", method: "heartbeat" }))
        expect(failure(exit)?.cause).toEqual({
          runId: "lease-future",
          nowMs: expect.any(Number),
          field: "nowMs",
          clockMs: 0,
          detail: "runs ahead of the store clock by more than the heartbeat skew allowance"
        })
      }
      expect(result.stolen).toEqual({ _tag: "Claimed", claimedAtMs: result.nowMs })
    }))

  it.effect("refuses a far-future steal instead of taking a run from its fresh owner", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-steal-future")
          const fresh = yield* store.get("lease-steal-future")
          const farFuture = yield* Effect.exit(
            store.steal("lease-steal-future", snapshot(fresh), peer, farFutureMs, leaseExpired(owner, farFutureMs))
          )
          // Inside the allowance the reading is judged literally, and a
          // ten-second lead does not make a fresh heartbeat stale.
          const withinAllowance = yield* store.steal(
            "lease-steal-future",
            snapshot(fresh),
            peer,
            skewMs,
            leaseExpired(owner, skewMs)
          )
          return { farFuture, withinAllowance, row: yield* store.get("lease-steal-future") }
        })
      )

      expect(failure(result.farFuture)).toEqual(expect.objectContaining({ code: "invalid_run", method: "steal" }))
      expect(result.withinAllowance).toEqual({ _tag: "HeartbeatFresh" })
      expect(result.row).toMatchObject({ status: "running", owner, heartbeatAtMs: 100, claim: null, claimedAtMs: null })
    }))

  it.effect("rejects negative, fractional, and NaN heartbeat timestamps before persistence", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* activate(store, "lease-invalid")
          yield* TestClock.adjust("100 millis")
          expect(yield* store.heartbeat("lease-invalid", owner, 100)).toEqual({ _tag: "Updated" })
          const exits = yield* Effect.forEach(
            [-1, 1.5, Number.NaN],
            (timestamp) => Effect.exit(store.heartbeat("lease-invalid", owner, timestamp))
          )
          return { exits, row: yield* store.get("lease-invalid") }
        })
      )

      // CONTRACT: heartbeat validates its timestamp explicitly. It has to —
      // the monotonic MAX() write would otherwise silently absorb an invalid
      // older value instead of letting the column CHECK reject it.
      expect(result.exits.every((exit) => Exit.isFailure(exit))).toBe(true)
      expect(
        result.exits.map((exit) =>
          Exit.isFailure(exit)
            ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
            : undefined
        )
      ).toEqual([
        expect.objectContaining({ code: "invalid_run", method: "heartbeat" }),
        expect.objectContaining({ code: "invalid_run", method: "heartbeat" }),
        expect.objectContaining({ code: "invalid_run", method: "heartbeat" })
      ])
      expect(result.row.heartbeatAtMs).toBe(100)
    }))
})

describe("RunStore lease reading bound", () => {
  const operations = ["claim", "claimAndOwn", "recoverClaim", "heartbeat", "steal"] as const
  type Operation = typeof operations[number]

  /** Prepares a row the operation can act on, then invokes it at the reading. */
  const invoke = (store: RunStoreLive.Service, operation: Operation, runId: string, readingMs: number) =>
    Effect.gen(function*() {
      yield* store.create(runId, "{}")
      switch (operation) {
        case "claim":
          return yield* Effect.exit(store.claim(runId, pending, owner, readingMs))
        case "claimAndOwn":
          return yield* Effect.exit(store.claimAndOwn(runId, pending, owner, readingMs))
        case "recoverClaim": {
          yield* store.claim(runId, pending, owner, 0)
          const evidence: LivenessEvidence = {
            expectedOwner: owner,
            checkedAtMs: readingMs,
            kind: "same-host-pid-dead"
          }
          return yield* Effect.exit(store.recoverClaim(runId, owner, 0, peer, readingMs, evidence))
        }
        case "heartbeat":
          yield* store.claimAndOwn(runId, pending, owner, 0)
          return yield* Effect.exit(store.heartbeat(runId, owner, readingMs))
        case "steal": {
          yield* store.claimAndOwn(runId, pending, owner, 0)
          const running = yield* store.get(runId)
          return yield* Effect.exit(
            store.steal(runId, snapshot(running), peer, readingMs, leaseExpired(owner, readingMs))
          )
        }
      }
    })

  it.effect("bounds every lease reading at exactly the skew allowance, and only from above", () =>
    Effect.gen(function*() {
      const clockMs = 5_000
      const readings = {
        behind: 0,
        atAllowance: clockMs + skewMs,
        pastAllowance: clockMs + skewMs + 1
      } as const
      const exits = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* TestClock.setTime(clockMs)
          const result: Array<
            {
              operation: Operation
              reading: keyof typeof readings
              exit: Exit.Exit<unknown, RunStoreLive.RunStoreError>
            }
          > = []
          for (const operation of operations) {
            for (const reading of ["behind", "atAllowance", "pastAllowance"] as const) {
              const exit = yield* invoke(store, operation, `bound-${operation}-${reading}`, readings[reading])
              result.push({ operation, reading, exit })
            }
          }
          return result
        })
      )

      for (const { exit, operation, reading } of exits) {
        if (reading === "pastAllowance") {
          expect(failure(exit)).toEqual(expect.objectContaining({ code: "invalid_run", method: operation }))
          expect(failure(exit)?.cause).toEqual(expect.objectContaining({
            field: "nowMs",
            clockMs,
            nowMs: readings.pastAllowance
          }))
        } else {
          // A reading at the allowance or behind the clock reaches the
          // compare-and-swap and reports a domain outcome, never a refusal.
          expect(Exit.isSuccess(exit)).toBe(true)
        }
      }
    }))

  it.effect("leaves request timestamps and fence tokens unbounded", () =>
    Effect.gen(function*() {
      const result = yield* migrated(
        Effect.gen(function*() {
          const store = yield* RunStore
          yield* store.create("unbounded-request", "{}")
          const requested = yield* store.requestCancel("unbounded-request", farFutureMs)
          const requestedRow = yield* store.get("unbounded-request")

          yield* store.create("unbounded-token", "{}")
          yield* store.claim("unbounded-token", pending, owner, 0)
          const activated = yield* store.activate("unbounded-token", owner, farFutureMs, pending)
          const abandoned = yield* store.abandonClaim("unbounded-token", owner, farFutureMs)
          const nowMs = yield* Clock.currentTimeMillis
          const recovered = yield* store.recoverClaim(
            "unbounded-token",
            owner,
            farFutureMs,
            peer,
            nowMs,
            { expectedOwner: owner, checkedAtMs: nowMs, kind: "same-host-pid-dead" }
          )
          return { requested, requestedRow, activated, abandoned, recovered }
        })
      )

      // `requestCancel` records request data, not a lease predicate, so the
      // literal reading persists. A fence token is compared against the row,
      // so a token nothing holds reports a lost fence rather than a refusal.
      expect(result.requested).toMatchObject({ _tag: "CancelRequested" })
      expect(result.requestedRow.cancelRequestedAtMs).toBe(farFutureMs)
      expect(result.activated).toEqual({ _tag: "ClaimLost" })
      expect(result.abandoned).toEqual({ _tag: "ClaimLost" })
      expect(result.recovered).toEqual({ _tag: "ClaimChanged" })
    }))
})
