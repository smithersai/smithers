/**
 * Issue #106: the sealed cache key folds the caller-*declared* read-set
 * digests, but recording was gated only on `cacheable && no deviation` — a
 * run with a stale declaration executed against the real content and
 * recorded that result under the stale declaration's key. A later run whose
 * declaration was genuinely accurate then passed the dirty check and
 * replayed the wrong value as a verified hit, silently. Recording is now
 * admitted only under a verified read set: the host-measured snapshot must
 * match the declaration the key was derived from, on both the fresh
 * completion path and the succeeded-attempt convergence replay (#24).
 */
import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "record-gating-host", pid: 41, nonce: "record-gating-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({ commitId: "record-gating-snapshot" as never, changeId: "record-gating-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const dispatch = (runId: string, key: string, execute: () => Effect.Effect<unknown, unknown>) =>
  ActionPersistence.make({ runId, owner, sourceId: `record-gating-${runId}`, execute })({
    action: {},
    attempt: 1,
    key,
    tier: "sealed",
    metadata: declared
  })

describe("cache recording requires a verified read set (issue #106)", () => {
  it.effect("a stale declaration's execution is never recorded under the declaration's key", () =>
    Effect.gen(function*() {
      const key = "record-gating/poison"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          let executions = 0
          // Run 1: the declaration says D1 but the workspace really is D2 —
          // the body computes result(D2). Recording it under key(D1) poisons
          // every future workspace where the file genuinely is D1.
          yield* activate("record-poison-first")
          const first = yield* dispatch("record-poison-first", key, () =>
            Effect.sync(() => {
              executions++
              return "result-computed-from-D2"
            })).pipe(
              Effect.provide(Layer.merge(
                StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] }),
                StepSandbox.layerTest({ "config.json": "D2" })
              ))
            )
          const poisoned = yield* cache.get(keyDigest)
          // Run 2: a workspace where config.json genuinely is D1. The dirty
          // check passes, so a poisoned row would replay result(D2) as a
          // verified hit. With recording gated it must execute for real.
          yield* activate("record-poison-second")
          const second = yield* dispatch("record-poison-second", key, () =>
            Effect.sync(() => {
              executions++
              return "result-computed-from-D1"
            })).pipe(
              Effect.provide(Layer.merge(
                StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }),
                StepSandbox.layerTest({ "config.json": "D1" })
              ))
            )
          // Run 3: the accurate run's result was recorded (its declaration
          // matched its measurement), so this run replays the RIGHT value.
          yield* activate("record-poison-third")
          const third = yield* dispatch("record-poison-third", key, () =>
            Effect.sync(() => {
              executions++
              return "never-runs"
            })).pipe(
              Effect.provide(Layer.merge(
                StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }),
                StepSandbox.layerTest({ "config.json": "D1" })
              ))
            )
          return { first, second, third, poisoned, executions }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.first).toBe("result-computed-from-D2")
      expect(Option.isNone(outcome.poisoned)).toBe(true)
      expect(outcome.second).toBe("result-computed-from-D1")
      expect(outcome.third).toBe("result-computed-from-D1")
      expect(outcome.executions).toBe(2)
    }))

  it.effect("the succeeded-attempt convergence replay does not re-record an unverified row", () =>
    Effect.gen(function*() {
      const key = "record-gating/replay-convergence"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          // The attempt succeeds under a stale declaration, so nothing is
          // recorded. The issue-#24 convergence replay of the same durable
          // attempt row must not smuggle the unverified result in either.
          yield* activate("record-replay-run")
          yield* dispatch("record-replay-run", key, () => Effect.succeed("stale-result")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] }))
          )
          const replayed = yield* dispatch("record-replay-run", key, () => Effect.succeed("never-runs")).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: [{ path: "config.json", digest: "D2" }] }))
          )
          const entry = yield* cache.get(keyDigest)
          return { replayed, entry }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.replayed).toBe("stale-result")
      expect(Option.isNone(outcome.entry)).toBe(true)
    }))
})
