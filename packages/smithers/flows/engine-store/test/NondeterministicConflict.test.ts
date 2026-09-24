import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = {
  hostId: "nondeterministic-conflict-host",
  pid: 73,
  nonce: "nondeterministic-conflict-process"
}

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () =>
      Effect.succeed({
        commitId: "nondeterministic-conflict-snapshot" as never,
        changeId: "nondeterministic-conflict-snapshot" as never
      }),
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
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
    const activated = yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    if (activated._tag !== "Activated") return yield* Effect.die(new Error("activation lost"))
  })

const seed = (keyDigest: string) =>
  Effect.flatMap(CacheStore.CacheStore, (cache) =>
    cache.put({
      keyDigest,
      result: "first",
      meta: {},
      createdAtMs: 1,
      recordedRunId: "winning-run",
      recordedEventSeq: 7
    }))

const missThenRecorded = (cache: CacheStore.Service) => {
  let reads = 0
  const service = CacheStore.makeNoop({
    ...cache,
    get: (keyDigest) => {
      reads = reads + 1
      return reads % 2 === 1 ? Effect.succeedNone : cache.get(keyDigest)
    }
  })
  return { service, reads: () => reads }
}

describe("declared nondeterministic cache conflicts", () => {
  it.effect("keeps the first cache row and journals one idempotent first-writer observation", () =>
    Effect.gen(function*() {
      let executions = 0
      const key = "nondeterministic/first-writer"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("nondeterministic-first-writer-run")
          yield* seed(keyDigest)
          const cache = yield* CacheStore.CacheStore
          const racing = missThenRecorded(cache)
          const execute = ActionPersistence.make({
            runId: "nondeterministic-first-writer-run",
            owner,
            sourceId: "nondeterministic-first-writer",
            execute: () =>
              Effect.sync(() => {
                executions = executions + 1
                return "second"
              })
          })
          const dispatch = Effect.provideService(
            execute({
              action: {},
              attempt: 1,
              key,
              tier: "sealed",
              nondeterministic: true,
              metadata: boundary
            }),
            CacheStore.CacheStore,
            racing.service
          )
          const first = yield* dispatch
          const redriven = yield* dispatch
          const attempts = yield* AttemptStore.AttemptStore
          const attempt = yield* attempts.get({
            runId: "nondeterministic-first-writer-run",
            stepKeyDigest: keyDigest,
            attempt: 1
          })
          const journal = yield* Journal.Journal
          yield* journal.flush
          const page = yield* journal.entries({
            runId: "nondeterministic-first-writer-run" as never,
            limit: 100
          })
          return {
            first,
            redriven,
            attempt,
            cached: yield* cache.get(keyDigest),
            reads: racing.reads(),
            provenance: page.entries
              .filter((entry) => entry.eventType === "flows.engine.cache-provenance")
              .map((entry) =>
                entry.payload as {
                  readonly action?: string
                  readonly recordedRunId?: string
                  readonly recordedEventSeq?: number
                }
              ),
            inconsistencies: page.entries.filter((entry) => entry.eventType === "flows.engine.cache-conflict")
          }
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(outcome.first).toBe("second")
      expect(outcome.redriven).toBe("second")
      expect(executions).toBe(1)
      expect(outcome.reads).toBe(4)
      expect(Option.getOrThrow(outcome.cached).result).toBe("first")
      expect(Option.getOrThrow(outcome.attempt).meta).toMatchObject({ nondeterministic: true })
      expect(outcome.provenance.filter((record) => record.action === "conflict_first_writer")).toEqual([{
        action: "conflict_first_writer",
        keyDigest,
        recordedRunId: "winning-run",
        recordedEventSeq: 7
      }])
      expect(outcome.inconsistencies).toHaveLength(0)
    }))

  it.effect("keeps the strict default for a conflict without the declaration", () =>
    Effect.gen(function*() {
      const key = "nondeterministic/strict-regression"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("nondeterministic-strict-run")
          yield* seed(keyDigest)
          const cache = yield* CacheStore.CacheStore
          const racing = missThenRecorded(cache)
          const error = yield* Effect.flip(
            Effect.provideService(
              ActionPersistence.make({
                runId: "nondeterministic-strict-run",
                owner,
                sourceId: "nondeterministic-strict",
                execute: () => Effect.succeed("second")
              })({ action: {}, attempt: 1, key, tier: "sealed", metadata: boundary }),
              CacheStore.CacheStore,
              racing.service
            )
          )
          return { error, cached: yield* cache.get(keyDigest) }
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(outcome.error).toBeInstanceOf(ActionPersistence.CacheConflictDetected)
      expect(outcome.error).toMatchObject({
        code: "cache_conflict_detected",
        keyDigest,
        recordedRunId: "winning-run"
      })
      expect(Option.getOrThrow(outcome.cached).result).toBe("first")
    }))

  it.effect("replays a declared nondeterministic cache hit without dispatching", () =>
    Effect.gen(function*() {
      let executions = 0
      const key = "nondeterministic/cache-hit"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          yield* activate("nondeterministic-hit-writer")
          const recorded = yield* ActionPersistence.make({
            runId: "nondeterministic-hit-writer",
            owner,
            sourceId: "nondeterministic-hit-writer",
            execute: () =>
              Effect.sync(() => {
                executions = executions + 1
                return "recorded"
              })
          })({
            action: {},
            attempt: 1,
            key,
            tier: "sealed",
            nondeterministic: true,
            metadata: boundary
          })
          yield* activate("nondeterministic-hit-reader")
          const replayed = yield* ActionPersistence.make({
            runId: "nondeterministic-hit-reader",
            owner,
            sourceId: "nondeterministic-hit-reader",
            execute: () =>
              Effect.sync(() => {
                executions = executions + 1
                return "unexpected"
              })
          })({
            action: {},
            attempt: 1,
            key,
            tier: "sealed",
            nondeterministic: true,
            metadata: boundary
          })
          const cache = yield* CacheStore.CacheStore
          const attempts = yield* AttemptStore.AttemptStore
          return {
            recorded,
            replayed,
            cached: yield* cache.get(keyDigest),
            writerAttempt: yield* attempts.get({
              runId: "nondeterministic-hit-writer",
              stepKeyDigest: keyDigest,
              attempt: 1
            }),
            readerAttempt: yield* attempts.get({
              runId: "nondeterministic-hit-reader",
              stepKeyDigest: keyDigest,
              attempt: 1
            })
          }
        }).pipe(Effect.provide(layer), Effect.scoped)
      )

      expect(outcome.recorded).toBe("recorded")
      expect(outcome.replayed).toBe("recorded")
      expect(executions).toBe(1)
      expect(Option.getOrThrow(outcome.cached).meta).toMatchObject({ nondeterministic: true })
      expect(Option.getOrThrow(outcome.writerAttempt).meta).toMatchObject({ nondeterministic: true })
      expect(Option.isNone(outcome.readerAttempt)).toBe(true)
    }))
})
