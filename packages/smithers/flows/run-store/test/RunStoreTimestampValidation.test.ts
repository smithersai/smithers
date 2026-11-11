import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Clock, Duration, Effect, Exit } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as Migrations from "../src/Migrations.vibe"
import { heartbeatStaleAfter, type LivenessEvidence, type OwnerId } from "../src/Ownership.ts"
import { type RunSnapshot, RunStore } from "../src/RunStore.vibe"
import * as RunStoreLive from "../src/RunStore.vibe"

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const ownerB: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }
const pending: RunSnapshot = { status: "pending", owner: null, heartbeatAtMs: null }

const migrated = <A, E>(
  effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>
) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

const expectInvalidRun = (exit: Exit.Exit<unknown, RunStoreLive.RunStoreError>, method: string): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  const failure = Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail")
    : undefined
  expect(failure?.error).toEqual(expect.objectContaining({ code: "invalid_run", method }))
}

describe("RunStore caller timestamp validation", () => {
  it.effect("rejects negative, fractional, and NaN timestamps across every timestamped operation", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("timestamp-validation", "{}")
        const validEvidence: LivenessEvidence = {
          expectedOwner: ownerA,
          checkedAtMs: 0,
          kind: "same-host-pid-dead"
        }
        const operations: ReadonlyArray<{
          readonly method: string
          readonly invoke: (timestamp: number) => Effect.Effect<unknown, RunStoreLive.RunStoreError>
        }> = [
          {
            method: "requestCancel",
            invoke: (timestamp) => store.requestCancel("timestamp-validation", timestamp)
          },
          {
            method: "claim",
            invoke: (timestamp) => store.claim("timestamp-validation", pending, ownerA, timestamp)
          },
          {
            method: "claimAndOwn",
            invoke: (timestamp) => store.claimAndOwn("timestamp-validation", pending, ownerA, timestamp)
          },
          {
            method: "activate",
            invoke: (timestamp) => store.activate("timestamp-validation", ownerA, timestamp, pending)
          },
          {
            method: "recoverClaim",
            invoke: (timestamp) =>
              store.recoverClaim("timestamp-validation", ownerA, 0, ownerB, timestamp, validEvidence)
          },
          {
            method: "heartbeat",
            invoke: (timestamp) => store.heartbeat("timestamp-validation", ownerA, timestamp)
          },
          {
            method: "steal",
            invoke: (timestamp) => store.steal("timestamp-validation", pending, ownerB, timestamp, validEvidence)
          }
        ]

        for (const operation of operations) {
          for (const timestamp of [-1, 1.5, Number.NaN]) {
            expectInvalidRun(yield* Effect.exit(operation.invoke(timestamp)), operation.method)
          }
        }
      }))
    }))

  it.effect("rejects an invalid recoverClaim claimedAtMs", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        yield* store.create("recover-claimed-at-validation", "{}")
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
        const nowMs = yield* Clock.currentTimeMillis
        const evidence: LivenessEvidence = {
          expectedOwner: ownerA,
          checkedAtMs: nowMs,
          kind: "same-host-pid-dead"
        }
        for (const claimedAtMs of [-1, 1.5, Number.NaN]) {
          expectInvalidRun(
            yield* Effect.exit(
              store.recoverClaim(
                "recover-claimed-at-validation",
                ownerA,
                claimedAtMs,
                ownerB,
                nowMs,
                evidence
              )
            ),
            "recoverClaim"
          )
        }
      }))
    }))

  it.effect("rejects NaN liveness evidence before returning domain refusals", () =>
    Effect.gen(function*() {
      yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore

        yield* store.create("evidence-running", "{}")
        yield* store.claimAndOwn("evidence-running", pending, ownerA, 0)
        const running = yield* store.get("evidence-running")
        const runningSnapshot: RunSnapshot = {
          status: running.status,
          owner: running.owner,
          heartbeatAtMs: running.heartbeatAtMs
        }
        const invalidEvidence: LivenessEvidence = {
          expectedOwner: ownerA,
          checkedAtMs: Number.NaN,
          kind: "same-host-pid-dead"
        }

        yield* store.create("evidence-claim", "{}")
        yield* store.claim("evidence-claim", pending, ownerA, 0)

        // The rows are genuinely stale and the reading is the store's own, so
        // the evidence is the only thing left for validation to refuse.
        yield* TestClock.adjust(Duration.millis(Duration.toMillis(heartbeatStaleAfter) + 1))
        const nowMs = yield* Clock.currentTimeMillis

        const exits = [
          [
            "claimAndOwn",
            yield* Effect.exit(
              store.claimAndOwn("evidence-running", runningSnapshot, ownerB, nowMs, invalidEvidence)
            )
          ],
          [
            "steal",
            yield* Effect.exit(store.steal("evidence-running", runningSnapshot, ownerB, nowMs, invalidEvidence))
          ],
          [
            "recoverClaim",
            yield* Effect.exit(
              store.recoverClaim("evidence-claim", ownerA, 0, ownerB, nowMs, invalidEvidence)
            )
          ]
        ] as const

        for (const [method, exit] of exits) expectInvalidRun(exit, method)
      }))
    }))
})
