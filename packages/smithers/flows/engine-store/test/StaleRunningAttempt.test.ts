/**
 * Pins issue #71: a SIGKILL mid-action leaves the attempt row in state
 * `running`. On re-drive by the reclaiming owner (issue #53's
 * `sweepStaleRunning`), the persisted-row chain used to handle only
 * succeeded/failed/suspended, so the stale running row fell through to
 * `attempts.put`, came back `Conflict` (the replay stamps a fresh
 * `startedAtMs`), and surfaced as `AttemptAdmissionRejected` — permanently
 * failing a no-policy run with an infrastructure tag, or burning a phantom
 * attempt under a policy. The row is crash evidence, not a live admission:
 * with the run fence held by this owner, the incarnation that admitted the
 * attempt is gone and the work must re-execute under its original attempt
 * number, then finish through the ordinary fenced transition.
 */
import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "stale-host", pid: 21, nonce: "reclaimer" }

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "stale-snapshot" as never, changeId: "stale-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const layer = Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") {
      return yield* Effect.die(new Error(`run ${runId} claim was lost`))
    }
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} activation was lost`))
    }
  })

describe("stale running attempt rows (issue #71)", () => {
  it.effect("re-executes an in-flight attempt row left by a hard-killed incarnation instead of rejecting admission", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const key = "stale-running/redrive"
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("stale-running")
          const attempts = yield* AttemptStore.AttemptStore
          // The dead incarnation admitted attempt 1 and was SIGKILLed before
          // finishing: the row stays `running` with its original start time.
          const seeded = yield* attempts.put(
            {
              runId: "stale-running",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              meta: { tier: "sealed" }
            },
            owner
          )
          expect(seeded._tag).toBe("Inserted")

          const outcome = yield* ActionPersistence.make({
            runId: "stale-running",
            owner,
            sourceId: "stale-running-test",
            execute: () =>
              Effect.sync(() => {
                dispatches++
                return "recovered"
              })
          })({
            action: {},
            attempt: 1,
            key,
            tier: "sealed"
          })

          const row = yield* attempts.get({
            runId: "stale-running",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          return { outcome, row }
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(dispatches).toBe(1)
      expect(result.outcome).toBe("recovered")
      expect(Option.isSome(result.row)).toBe(true)
      if (Option.isSome(result.row)) {
        expect(result.row.value.state).toBe("succeeded")
        expect(result.row.value.outcome).toBe("recovered")
      }
    }))

  it.effect("records the re-executed attempt's failure durably through the ordinary finish path", () =>
    Effect.gen(function*() {
      const key = "stale-running/fails"
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("stale-running-fails")
          const attempts = yield* AttemptStore.AttemptStore
          yield* attempts.put(
            {
              runId: "stale-running-fails",
              stepKeyDigest: sha256(key),
              attempt: 1,
              state: "running",
              startedAtMs: 0,
              meta: { tier: "sealed" }
            },
            owner
          )
          const exit = yield* Effect.exit(
            ActionPersistence.make({
              runId: "stale-running-fails",
              owner,
              sourceId: "stale-running-test",
              execute: () => Effect.fail("boom")
            })({
              action: {},
              attempt: 1,
              key,
              tier: "sealed"
            })
          )
          const row = yield* attempts.get({
            runId: "stale-running-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          return { exit, row }
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(result.exit._tag).toBe("Failure")
      expect(Option.isSome(result.row)).toBe(true)
      if (Option.isSome(result.row)) {
        expect(result.row.value.state).toBe("failed")
      }
    }))
})
