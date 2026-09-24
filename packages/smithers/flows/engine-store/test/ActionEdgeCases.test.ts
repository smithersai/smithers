import { describe, expect, it } from "@effect/vitest"
import type { Action } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "edge-host", pid: 11, nonce: "edge-process" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = (restores: Array<string>, snapshots: Array<string>) =>
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

const base = (restores: Array<string> = [], snapshots: Array<string> = []) =>
  Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jjLayer(restores, snapshots))

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

const dispatch = (options: {
  readonly runId: string
  readonly key: string
  readonly tier: Action.Tier
  readonly attempt?: number
  readonly metadata?: ActionPersistence.BoundaryMetadata
  readonly idempotencyKey?: string
  readonly execute: () => Effect.Effect<unknown, unknown>
}) =>
  ActionPersistence.make({
    runId: options.runId,
    owner,
    sourceId: "action-edge-test",
    execute: options.execute,
    ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey })
  })({
    action: {},
    attempt: options.attempt ?? 1,
    key: options.key,
    tier: options.tier,
    ...(options.metadata === undefined ? {} : { metadata: options.metadata })
  })

const seedConflictingRow = (keyDigest: string, result: unknown) =>
  Effect.flatMap(CacheStore.CacheStore, (cache) =>
    cache.put({
      keyDigest,
      result,
      meta: {},
      createdAtMs: 1,
      recordedRunId: "recorded-run",
      recordedEventSeq: 0
    }))

const conflictEvents = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries.filter((entry) => entry.eventType === "flows.engine.cache-conflict")
  })

describe("cache conflict with no Inconsistency receiver provided", () => {
  it.effect("defaults to the strict receiver: journals the conflict and fails the run", () =>
    Effect.gen(function*() {
      const key = "edge/default-strict"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("default-strict")
          yield* seedConflictingRow(keyDigest, "original")
          const error = yield* Effect.flip(dispatch({
            runId: "default-strict",
            key,
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.succeed("divergent")
          }))
          return { error, conflicts: yield* conflictEvents("default-strict") }
        }).pipe(Effect.provide(base()), Effect.scoped)
      )

      expect(result.error).toBeInstanceOf(ActionPersistence.CacheConflictDetected)
      expect(result.error).toMatchObject({ keyDigest, recordedRunId: "recorded-run" })
      expect(result.conflicts).toHaveLength(1)
      expect(result.conflicts[0]!.payload).toMatchObject({ verdict: "fail" })
    }))

  it.effect("reports an unknown recorded run when the conflicting row cannot be read back", () =>
    Effect.gen(function*() {
      const key = "edge/vanished-conflict"
      const keyDigest = sha256(key)
      const vanishing = Layer.effect(
        CacheStore.CacheStore,
        Effect.map(CacheStore.CacheStore, (store) =>
          CacheStore.makeNoop({
            ...store,
            // The competing row is gone by the time the conflict is described:
            // the failure still names the key, with an explicitly unknown
            // recorded run rather than a fabricated one.
            put: () => Effect.succeed({ _tag: "Conflict" as const }),
            get: () => Effect.succeedNone
          }))
      )
      const error = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("vanished-conflict")
          return yield* Effect.flip(dispatch({
            runId: "vanished-conflict",
            key,
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.succeed("value")
          }))
        }).pipe(
          Effect.provide(Layer.provideMerge(vanishing, base())),
          Effect.scoped
        )
      )

      expect(error).toMatchObject({
        code: "cache_conflict_detected",
        keyDigest,
        recordedRunId: "unknown"
      })
    }))

  it.effect("tolerates the conflict silently under the default noop receiver", () =>
    Effect.gen(function*() {
      const key = "edge/noop-receiver"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("noop-receiver")
          yield* seedConflictingRow(keyDigest, "original")
          const value = yield* dispatch({
            runId: "noop-receiver",
            key,
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.succeed("divergent")
          })
          const cache = yield* CacheStore.CacheStore
          return {
            value,
            cached: yield* cache.get(keyDigest),
            conflicts: yield* conflictEvents("noop-receiver")
          }
        }).pipe(
          Effect.provide(Layer.provideMerge(Inconsistency.layerNoop(), base())),
          Effect.scoped
        )
      )

      expect(result.value).toBe("divergent")
      // The noop receiver neither journals nor overwrites the recorded row.
      expect(Option.getOrThrow(result.cached).result).toBe("original")
      expect(result.conflicts).toHaveLength(0)
    }))
})

describe("attempt lifecycle journal failures", () => {
  it.effect("propagates a durable-journal failure that is not a lost fence", () =>
    Effect.gen(function*() {
      const failingJournal = Layer.effect(
        Journal.Journal,
        Effect.map(Journal.Journal, (journal) =>
          Journal.makeNoop({
            ...journal,
            emitDurable: () =>
              Effect.fail(
                new Journal.JournalError({
                  code: "sink_failed",
                  message: "sink_failed: journal sink is down",
                  cause: undefined
                })
              )
          }))
      )
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("journal-broken")
          return yield* Effect.exit(dispatch({
            runId: "journal-broken",
            key: "edge/journal-broken",
            tier: "sealed",
            execute: () => Effect.succeed("value")
          }))
        }).pipe(Effect.provide(Layer.provideMerge(failingJournal, base())), Effect.scoped)
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
        code: "sink_failed"
      })
    }))
})

describe("compensable attempts that fail after snapshotting", () => {
  it.effect("records the snapshot on the failed attempt and restores it before the retry", () =>
    Effect.gen(function*() {
      const restores: Array<string> = []
      const snapshots: Array<string> = []
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("compensable-failure")
          const first = yield* Effect.exit(dispatch({
            runId: "compensable-failure",
            key: "edge/compensable",
            tier: "compensable",
            attempt: 1,
            execute: () => Effect.fail("boom")
          }))
          const attempts = yield* AttemptStore.AttemptStore
          const failed = yield* attempts.get({
            runId: "compensable-failure",
            stepKeyDigest: sha256("edge/compensable"),
            attempt: 1
          })
          const second = yield* dispatch({
            runId: "compensable-failure",
            key: "edge/compensable",
            tier: "compensable",
            attempt: 2,
            execute: () => Effect.succeed("recovered")
          })
          return { first, failed: Option.getOrThrow(failed), second }
        }).pipe(Effect.provide(base(restores, snapshots)), Effect.scoped)
      )

      expect(Exit.isFailure(result.first)).toBe(true)
      expect(result.failed.state).toBe("failed")
      // The failed attempt kept its snapshot id, which is what lets attempt 2
      // roll the worktree back before re-executing.
      expect(result.failed.meta).toMatchObject({ tier: "compensable", snapshotId: snapshots[0] })
      expect(restores).toEqual([snapshots[0]])
      expect(result.second).toBe("recovered")
    }))

  it.effect("self-interrupts when the failed attempt cannot be finished under this fence", () =>
    Effect.gen(function*() {
      const finishBlocked = Layer.effect(
        AttemptStore.AttemptStore,
        Effect.map(AttemptStore.AttemptStore, (store) =>
          AttemptStore.makeNoop({
            ...store,
            finish: () => Effect.succeed({ _tag: "FenceLost" as const })
          }))
      )
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("finish-fence-lost")
          return yield* Effect.exit(dispatch({
            runId: "finish-fence-lost",
            key: "edge/finish-fence-lost",
            tier: "compensable",
            execute: () => Effect.fail("boom")
          }))
        }).pipe(Effect.provide(Layer.provideMerge(finishBlocked, base())), Effect.scoped)
      )

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))
})

describe("boundary violations on a compensable-snapshotted attempt", () => {
  const violating = Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.StepBoundary.of({
      prepare: () => Effect.succeed({ descriptor: boundary, readSnapshot: [] }),
      settle: () => Effect.fail(new Error("write outside the declared write set") as never),
      replayOutputs: () => Effect.void
    })
  )

  it.effect("journals a hard violation and fails when the settle check rejects the attempt", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("settle-violation")
          const exit = yield* Effect.exit(dispatch({
            runId: "settle-violation",
            key: "edge/settle-violation",
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.succeed("value")
          }))
          const journal = yield* Journal.Journal
          yield* journal.flush
          const page = yield* journal.entries({ runId: "settle-violation" as never, limit: 50 })
          return { exit, types: page.entries.map((entry) => entry.eventType) }
        }).pipe(
          Effect.provide(Layer.provideMerge(violating, base())),
          Effect.scoped
        )
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(result.types).toContain("flows.engine.hard-violation")
      expect(result.types).toContain("flows.engine.attempt-finished")
    }))

  it.effect("self-interrupts when a settle violation cannot be finished under this fence", () =>
    Effect.gen(function*() {
      const finishBlocked = Layer.effect(
        AttemptStore.AttemptStore,
        Effect.map(AttemptStore.AttemptStore, (store) =>
          AttemptStore.makeNoop({
            ...store,
            finish: () => Effect.succeed({ _tag: "StateChanged" as const })
          }))
      )
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("settle-fence-lost")
          return yield* Effect.exit(dispatch({
            runId: "settle-fence-lost",
            key: "edge/settle-fence-lost",
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.succeed("value")
          }))
        }).pipe(
          Effect.provide(Layer.provideMerge(finishBlocked, Layer.provideMerge(violating, base()))),
          Effect.scoped
        )
      )

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))
})

describe("cache convergence from a succeeded attempt row", () => {
  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("stamps the cache entry with the current time when the attempt records no finish time", () =>
    Effect.gen(function*() {
      const key = "edge/no-finish-time"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("no-finish-time")
          const attempts = yield* AttemptStore.AttemptStore
          // A crash between `finish` and `cache.put` can leave a succeeded row
          // whose finish time never made it to storage; convergence must still
          // record the sealed result.
          const succeeded = AttemptStore.makeNoop({
            ...attempts,
            get: () =>
              Effect.succeedSome({
                runId: "no-finish-time",
                stepKeyDigest: keyDigest,
                attempt: 1,
                state: "succeeded",
                startedAtMs: 0,
                outcome: "recorded-outcome",
                meta: {
                  tier: "sealed",
                  boundary: {
                    // The abstract boundary records its declared paths. Keep
                    // this fixture admissible so it exercises timestamp convergence.
                    declaredOutputs: { paths: ["output.txt"] },
                    diffIdentity: "identity",
                    wholeTreeWritesVerified: true,
                    // Convergence fails closed on BOTH proofs, exactly like the
                    // fresh-completion publication gate.
                    hermeticReadsVerified: true
                  },
                  // Convergence re-records only completions whose read set was
                  // verified at prepare time (issue #106).
                  readSetVerified: true
                }
              })
          })
          const value = yield* dispatch({
            runId: "no-finish-time",
            key,
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.die("must not dispatch")
          }).pipe(Effect.provideService(AttemptStore.AttemptStore, succeeded))
          const cache = yield* CacheStore.CacheStore
          return { value, cached: yield* cache.get(keyDigest) }
        }).pipe(Effect.provide(base()), Effect.scoped)
      )

      expect(result.value).toBe("recorded-outcome")
      const cached = Option.getOrThrow(result.cached)
      expect(cached.result).toBe("recorded-outcome")
      expect(cached.createdAtMs).toBeGreaterThan(0)
    }))

  it.effect("does not converge a row carrying the write proof alone", () =>
    Effect.gen(function*() {
      // A durable succeeded row persisted before read verification existed
      // carries `wholeTreeWritesVerified` only. Resume must serve the run its
      // own recorded outcome but never promote the row into the shared cache:
      // convergence fails closed on BOTH proofs.
      const key = "edge/write-proof-only"
      const keyDigest = sha256(key)
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("write-proof-only")
          const attempts = yield* AttemptStore.AttemptStore
          const succeeded = AttemptStore.makeNoop({
            ...attempts,
            get: () =>
              Effect.succeedSome({
                runId: "write-proof-only",
                stepKeyDigest: keyDigest,
                attempt: 1,
                state: "succeeded",
                startedAtMs: 0,
                outcome: "recorded-outcome",
                meta: {
                  tier: "sealed",
                  boundary: {
                    declaredOutputs: {},
                    diffIdentity: "identity",
                    wholeTreeWritesVerified: true
                  },
                  readSetVerified: true
                }
              })
          })
          const value = yield* dispatch({
            runId: "write-proof-only",
            key,
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.die("must not dispatch")
          }).pipe(Effect.provideService(AttemptStore.AttemptStore, succeeded))
          const cache = yield* CacheStore.CacheStore
          return { value, cached: yield* cache.get(keyDigest) }
        }).pipe(Effect.provide(base()), Effect.scoped)
      )

      expect(result.value).toBe("recorded-outcome")
      expect(Option.isNone(result.cached)).toBe(true)
    }))
})

describe("compensable retries with no recorded predecessor", () => {
  it.effect("does not restore anything when the previous attempt left no snapshot", () =>
    Effect.gen(function*() {
      const restores: Array<string> = []
      const snapshots: Array<string> = []
      const value = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("no-previous")
          // Attempt 2 with no attempt-1 row at all (the first attempt died
          // before it was ever recorded): there is nothing to roll back to.
          return yield* dispatch({
            runId: "no-previous",
            key: "edge/no-previous",
            tier: "compensable",
            attempt: 2,
            execute: () => Effect.succeed("fresh")
          })
        }).pipe(Effect.provide(base(restores, snapshots)), Effect.scoped)
      )

      expect(value).toBe("fresh")
      expect(restores).toEqual([])
      expect(snapshots).toHaveLength(1)
    }))
})

describe("boundary preparation failures", () => {
  const rejectingPrepare = Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.StepBoundary.of({
      prepare: () => Effect.fail(new Error("read set is not hermetic") as never),
      settle: () => Effect.succeed({ declaredOutputs: {}, diffIdentity: "identity" }),
      replayOutputs: () => Effect.void
    })
  )

  it.effect("journals a hard violation and never dispatches when preparation is rejected", () =>
    Effect.gen(function*() {
      let dispatches = 0
      const result = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("prepare-violation")
          const exit = yield* Effect.exit(dispatch({
            runId: "prepare-violation",
            key: "edge/prepare-violation",
            tier: "sealed",
            metadata: boundary,
            execute: () =>
              Effect.sync(() => {
                dispatches++
                return "value"
              })
          }))
          const journal = yield* Journal.Journal
          yield* journal.flush
          const page = yield* journal.entries({ runId: "prepare-violation" as never, limit: 50 })
          return { exit, types: page.entries.map((entry) => entry.eventType) }
        }).pipe(Effect.provide(Layer.provideMerge(rejectingPrepare, base())), Effect.scoped)
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(dispatches).toBe(0)
      expect(result.types).toContain("flows.engine.hard-violation")
    }))

  it.effect("self-interrupts when a rejected preparation cannot be finished under this fence", () =>
    Effect.gen(function*() {
      const finishBlocked = Layer.effect(
        AttemptStore.AttemptStore,
        Effect.map(AttemptStore.AttemptStore, (store) =>
          AttemptStore.makeNoop({
            ...store,
            finish: () => Effect.succeed({ _tag: "NotFound" as const })
          }))
      )
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("prepare-fence-lost")
          return yield* Effect.exit(dispatch({
            runId: "prepare-fence-lost",
            key: "edge/prepare-fence-lost",
            tier: "sealed",
            metadata: boundary,
            execute: () => Effect.succeed("value")
          }))
        }).pipe(
          Effect.provide(Layer.provideMerge(finishBlocked, Layer.provideMerge(rejectingPrepare, base()))),
          Effect.scoped
        )
      )

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))
})
