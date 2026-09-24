import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Effect, Layer, Option } from "effect"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "tiers", pid: 1, nonce: "owner" }

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const pending = yield* runs.get(runId)
    const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    if (claim._tag !== "Claimed") {
      return yield* Effect.die(new Error(`run ${runId} claim was lost`))
    }
    yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
  })

const jjLayer = (snapshots: Array<string>, restores: Array<string>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () =>
        Effect.sync(() => {
          const changeId = `snapshot-${snapshots.length}`
          snapshots.push(changeId)
          // A distinct change id: the engine must journal the commit id.
          return { commitId: changeId as never, changeId: `moving-${changeId}` as never }
        }),
      restore: (changeId) =>
        Effect.sync(() => {
          restores.push(changeId as string)
        }),
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  )

describe("engine-store action tiers", () => {
  it.effect("replays a sealed action from the shared cache across runs without dispatching again", () =>
    Effect.gen(function*() {
      let executions = 0
      const program = Effect.gen(function*() {
        yield* activate("sealed-first")
        const first = ActionPersistence.make({
          runId: "sealed-first",
          owner,
          sourceId: "tier-test",
          execute: () => Effect.sync(() => ++executions)
        })({
          action: {},
          attempt: 1,
          key: "caller-key/sealed",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" }
        })
        yield* first
        yield* activate("sealed-second")
        const second = yield* ActionPersistence.make({
          runId: "sealed-second",
          owner,
          sourceId: "tier-test",
          execute: () => Effect.sync(() => ++executions)
        })({
          action: {},
          attempt: 1,
          key: "caller-key/sealed",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" }
        })
        return second
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer([], []))),
        Effect.scoped
      )

      expect(yield* withCrypto(program)).toBe(1)
      expect(executions).toBe(1)
    }))

  it.effect("persists compensable snapshot evidence and restores it before a retry without populating the cache", () =>
    Effect.gen(function*() {
      const snapshots: Array<string> = []
      const restores: Array<string> = []
      let executions = 0
      const program = Effect.gen(function*() {
        yield* activate("compensable")
        const execute = () => Effect.sync(() => ++executions)
        const runner = ActionPersistence.make({ runId: "compensable", owner, sourceId: "tier-test", execute })
        yield* runner({ action: {}, attempt: 1, key: "caller-key/compensable", tier: "compensable" })
        yield* runner({ action: {}, attempt: 2, key: "caller-key/compensable", tier: "compensable" })
        const attempts = yield* AttemptStore.AttemptStore
        const cache = yield* CacheStore.CacheStore
        return {
          retry: yield* attempts.get({
            runId: "compensable",
            stepKeyDigest: sha256("caller-key/compensable"),
            attempt: 2
          }),
          cached: yield* cache.get(sha256("caller-key/compensable"))
        }
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer(snapshots, restores))),
        Effect.scoped
      )

      const result = yield* withCrypto(program)
      expect(executions).toBe(2)
      expect(snapshots).toEqual(["snapshot-0", "snapshot-1"])
      expect(restores).toEqual(["snapshot-0"])
      expect(Option.getOrThrow(result.retry).meta).toMatchObject({ snapshotId: "snapshot-1", tier: "compensable" })
      expect(Option.isNone(result.cached)).toBe(true)
    }))

  it.effect("takes the compensable pre-image through the injected engine authority, never the ambient service", () =>
    Effect.gen(function*() {
      // `EngineStore` hands the dispatcher its own `EngineJj`, which is how
      // engine bookkeeping stays off the public `Jj` service a flow body may
      // hold. The ambient layer below is deliberately the WRONG one: reaching
      // it would name its change id in the recorded pre-image.
      const engineSnapshots: Array<string> = []
      const ambientSnapshots: Array<string> = []
      const program = Effect.gen(function*() {
        yield* activate("compensable-engine-jj")
        yield* ActionPersistence.make({
          runId: "compensable-engine-jj",
          owner,
          sourceId: "tier-test",
          engineJj: Jj.make({
            snapshot: () =>
              Effect.sync(() => {
                engineSnapshots.push("engine")
                return { commitId: "engine-snapshot" as never, changeId: "engine-snapshot" as never }
              }),
            restore: () => Effect.void,
            diff: () => Effect.succeed(""),
            workspaceAdd: () => Effect.void,
            workspaceForget: () => Effect.void,
            status: () => Effect.succeed("")
          }),
          execute: () => Effect.succeed("compensated")
        })({ action: {}, attempt: 1, key: "caller-key/engine-jj", tier: "compensable" })
        const attempts = yield* AttemptStore.AttemptStore
        return yield* attempts.get({
          runId: "compensable-engine-jj",
          stepKeyDigest: sha256("caller-key/engine-jj"),
          attempt: 1
        })
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer(ambientSnapshots, []))),
        Effect.scoped
      )

      const row = yield* withCrypto(program)
      expect(engineSnapshots).toEqual(["engine"])
      expect(ambientSnapshots).toEqual([])
      expect(Option.getOrThrow(row).meta).toMatchObject({ snapshotId: "engine-snapshot", tier: "compensable" })
    }))

  it.effect("requires an idempotency key before retrying an irreversible action", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        yield* activate("irreversible")
        const withoutKey = ActionPersistence.make({
          runId: "irreversible",
          owner,
          sourceId: "tier-test",
          execute: () => Effect.succeed("never")
        })({ action: {}, attempt: 2, key: "caller-key/irreversible", tier: "irreversible" }).pipe(Effect.result)
        const withKey = yield* ActionPersistence.make({
          runId: "irreversible",
          owner,
          sourceId: "tier-test",
          idempotencyKey: "request-1",
          execute: () => Effect.succeed("once")
        })({ action: {}, attempt: 2, key: "caller-key/irreversible-keyed", tier: "irreversible" })
        return { withoutKey: yield* withoutKey, withKey }
      }).pipe(
        Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer([], []))),
        Effect.scoped
      )

      const result = yield* withCrypto(program)
      expect(result.withoutKey).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "@smthrs/flow/IrreversibleRetryRequiresIdempotencyKey",
          actionName: "flows/engine-store/action",
          attempt: 2
        }
      })
      expect(result.withKey).toBe("once")
    }))

  it.effect("fails closed for hard undeclared writes, journals expected deviations, and never derives keys", () =>
    Effect.gen(function*() {
      const hard = Effect.gen(function*() {
        yield* activate("hard")
        return yield* ActionPersistence.make({
          runId: "hard",
          owner,
          sourceId: "tier-test",
          execute: () => Effect.succeed("value")
        })({
          action: {},
          attempt: 1,
          key: "supplier-key/hard",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["declared"], boundaryMode: "hard" }
        }).pipe(Effect.result)
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestStores.layer(),
            StepBoundary.layerTest({
              failure: new StepBoundary.UndeclaredWrite({
                code: "undeclared_write",
                paths: ["other"],
                diffIdentity: "test-diff"
              })
            }),
            jjLayer([], [])
          )
        ),
        Effect.scoped
      )
      expect(yield* withCrypto(hard)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "@smthrs/engine-store/UndeclaredWrite" }
      })

      const expected = Effect.gen(function*() {
        yield* activate("expected")
        yield* ActionPersistence.make({
          runId: "expected",
          owner,
          sourceId: "tier-test",
          execute: () => Effect.succeed("value")
        })({
          action: {},
          attempt: 1,
          key: "supplier-key/expected",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["declared"], boundaryMode: "expected" }
        })
        const journal = yield* Journal.Journal
        const cache = yield* CacheStore.CacheStore
        yield* journal.flush
        return {
          events: yield* journal.entries({ runId: "expected" as never, limit: 20 }),
          cached: yield* cache.get(sha256("supplier-key/expected"))
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestStores.layer(),
            StepBoundary.layerTest({
              deviation: { _tag: "ExpectedSetDeviation", paths: ["other"], diffIdentity: "test-diff" }
            }),
            jjLayer([], [])
          )
        ),
        Effect.scoped
      )
      const result = yield* withCrypto(expected)
      expect(result.events.entries.map((entry) => entry.eventType)).toContain("flows.engine.expected-set-deviation")
      expect(Option.isNone(result.cached)).toBe(true)
    }))
})
