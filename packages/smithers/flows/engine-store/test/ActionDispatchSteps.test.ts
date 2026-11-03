/**
 * Decisions inside one action dispatch that the rest of the suite only
 * executed: which settlements project a checkpoint or call fact, what reaches
 * the shared cache tier, which replay refusals are worth a download, what an
 * admission does when its run vanished, which tiers prepare a boundary, which
 * withheld completions are journalled, and what a crossing write carries over
 * from an adopted row.
 */
import { describe, expect, it } from "@effect/vitest"
import { CallFact, Journal, JournalEvent, StepFact } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CacheSync from "../src/CacheSync.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "dispatch-steps", pid: 5, nonce: "dispatch-steps-process" }

const boundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "dispatch-steps" as never, changeId: "dispatch-steps" as never }),
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

const entries = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    return (yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 1000 })).entries
  })

const attemptState = (runId: string, key: string) =>
  Effect.gen(function*() {
    const attempts = yield* AttemptStore.AttemptStore
    const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
    return Option.isSome(row) ? row.value.state : undefined
  })

const call: CallFact.Call = {
  callId: `cell-call-v1:${"b".repeat(64)}`,
  identity: { runId: "failed-call", frame: 1, cell: "cell", ordinal: 0, declaration: "declaration", layers: [] },
  flowName: "write",
  input: { path: "a" }
}

describe("action dispatch steps", () => {
  it.effect("a failed checkpoint step settles failed and projects no step fact from its missing outcome", () =>
    Effect.gen(function*() {
      const runId = "failed-checkpoint", key = `${runId}/checkpoint`
      yield* activate(runId)
      const exit = yield* Effect.exit(
        ActionPersistence.make({ runId, owner, sourceId: "dispatch-steps", execute: () => Effect.fail("broke") })({
          action: {
            name: "agent/checkpoint",
            successSchema: StepFact.Fact,
            annotations: Context.make(StepFact.Annotation, {})
          },
          key,
          attempt: 1,
          tier: "sealed"
        })
      )
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("broke")
      expect(yield* attemptState(runId, key)).toBe("failed")
      const recorded = yield* entries(runId)
      expect(recorded.filter((entry) => entry.eventType === StepFact.eventType)).toEqual([])
      expect(recorded.some((entry) => entry.eventType.includes("attempt-finished"))).toBe(true)
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("a failed settled-phase call settles failed and projects no call fact from its missing outcome", () =>
    Effect.gen(function*() {
      const runId = "failed-call", key = `${runId}/write`
      yield* activate(runId)
      const exit = yield* Effect.exit(
        ActionPersistence.make({
          runId,
          owner,
          sourceId: "dispatch-steps",
          idempotencyKey: "failed-call",
          execute: () => Effect.fail("refused")
        })({
          action: {
            name: "call/settled",
            successSchema: CallFact.Result,
            annotations: Context.make(CallFact.Annotation, { phase: "settled", call })
          },
          key,
          attempt: 1,
          tier: "irreversible"
        })
      )
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe("refused")
      expect(yield* attemptState(runId, key)).toBe("failed")
      expect((yield* entries(runId)).filter((entry) => entry.eventType === CallFact.eventType)).toEqual([])
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("a recording that lost the first-writer race is never published to the shared tier", () =>
    Effect.gen(function*() {
      const runId = "conflict-unpublished", key = `${runId}/sealed`
      const keyDigest = sha256(key)
      yield* activate(runId)
      const cache = yield* CacheStore.CacheStore
      yield* cache.put({
        keyDigest,
        result: "first",
        meta: {},
        createdAtMs: 1,
        recordedRunId: "winning-run",
        recordedEventSeq: 7
      })
      // The lookup misses once, so the dispatch executes and its put loses
      // to the row another run already recorded.
      let reads = 0
      const missOnce = CacheStore.makeNoop({
        ...cache,
        get: (digest) => {
          reads = reads + 1
          return reads === 1 ? Effect.succeedNone : cache.get(digest)
        }
      })
      const published: Array<unknown> = []
      const shared: CacheSync.Service = {
        publishEntry: (entry) =>
          Effect.sync(() => {
            published.push(entry.result)
            return Option.none()
          })
      }
      const result = yield* ActionPersistence.make({
        runId,
        owner,
        sourceId: "dispatch-steps",
        execute: () => Effect.succeed("second")
      })({ action: {}, attempt: 1, key, tier: "sealed", nondeterministic: true, metadata: boundary }).pipe(
        Effect.provideService(CacheStore.CacheStore, missOnce),
        Effect.provideService(CacheSync.CacheSync, shared)
      )
      expect(result).toBe("second")
      expect(published).toEqual([])
      expect(Option.getOrThrow(yield* cache.get(keyDigest)).result).toBe("first")
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("a host refusal of a verified hit's replay is not a missing artifact: no hydration, no retry", () =>
    Effect.gen(function*() {
      const bytes = new TextEncoder().encode("host-refused artifact")
      const recorded: StepBoundary.BoundaryEvidence = {
        declaredOutputs: { outputs: [{ path: "artifact", digest: sha256(bytes), sizeBytes: bytes.length }] },
        diffIdentity: "host-refused-diff",
        wholeTreeWritesVerified: true,
        hermeticReadsVerified: true
      }
      const host = (replayOutputs: StepBoundary.Service["replayOutputs"]) =>
        StepBoundary.make({
          prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: [] }),
          settle: () => Effect.succeed(recorded),
          replayOutputs
        })
      let bodies = 0, replays = 0, hydrations = 0
      const dispatch = (runId: string) =>
        ActionPersistence.make({
          runId,
          owner,
          sourceId: runId,
          execute: () =>
            Effect.sync(() => {
              bodies++
              return "settled"
            })
        })({
          action: {},
          attempt: 1,
          key: "host-refused",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["artifact"], boundaryMode: "hard" }
        })
      yield* activate("host-refused-producer")
      yield* dispatch("host-refused-producer").pipe(
        Effect.provideService(StepBoundary.StepBoundary, host(() => Effect.void))
      )
      yield* activate("host-refused-consumer")
      const result = yield* dispatch("host-refused-consumer").pipe(
        Effect.provideService(
          StepBoundary.StepBoundary,
          host(() =>
            Effect.suspend(() => {
              replays++
              return Effect.fail(
                new StepBoundary.UnsupportedBoundary({ code: "unsupported_boundary", message: "host refused" })
              )
            })
          )
        ),
        Effect.provideService(ArtifactSync.ArtifactSync, {
          publish: () => Effect.void,
          hydrate: () =>
            Effect.sync(() => {
              hydrations++
              return true
            })
        })
      )
      expect(result).toBe("settled")
      expect({ bodies, replays, hydrations }).toEqual({ bodies: 2, replays: 1, hydrations: 0 })
      const refusals = (yield* entries("host-refused-consumer"))
        .map((entry) => entry.payload as { readonly action?: string; readonly reason?: string })
        .filter((payload) => payload.action === "replay_failed")
      expect(refusals.map((payload) => payload.reason)).toEqual(["host"])
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("an admission whose run vanished self-interrupts instead of reporting a rejected admission", () =>
    Effect.gen(function*() {
      const runId = "vanished-run", key = `${runId}/step`
      yield* activate(runId)
      const attempts = yield* AttemptStore.AttemptStore
      // The run row disappears between the dispatch's fence and its admission.
      const vanished: AttemptStore.Service = { ...attempts, put: () => Effect.succeed({ _tag: "RunNotFound" }) }
      let bodies = 0
      const exit = yield* Effect.exit(
        ActionPersistence.make({
          runId,
          owner,
          sourceId: "dispatch-steps",
          execute: () =>
            Effect.sync(() => {
              bodies++
            })
        })({ action: {}, attempt: 1, key, tier: "sealed" }).pipe(
          Effect.provideService(AttemptStore.AttemptStore, vanished)
        )
      )
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(bodies).toBe(0)
      expect(yield* attemptState(runId, key)).toBeUndefined()
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  for (const tier of ["compensable", "irreversible"] as const) {
    it.effect(`a ${tier} action's declared boundary is never prepared or settled: only sealed work has one`, () =>
      Effect.gen(function*() {
        const runId = `${tier}-metadata`, key = `${runId}/step`
        yield* activate(runId)
        const calls: Array<string> = []
        const measuring = StepBoundary.make({
          prepare: (descriptor) =>
            Effect.sync(() => {
              calls.push("prepare")
              return { descriptor, readSnapshot: [] }
            }),
          settle: () =>
            Effect.sync(() => {
              calls.push("settle")
              return { declaredOutputs: { outputs: [] }, diffIdentity: "unsealed" }
            }),
          replayOutputs: () => Effect.void
        })
        const result = yield* ActionPersistence.make({
          runId,
          owner,
          sourceId: "dispatch-steps",
          execute: () => Effect.succeed("done")
        })({ action: {}, attempt: 1, key, tier, metadata: boundary }).pipe(
          Effect.provideService(StepBoundary.StepBoundary, measuring)
        )
        expect(result).toBe("done")
        expect(calls).toEqual([])
        const attempts = yield* AttemptStore.AttemptStore
        const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
        expect(Option.getOrThrow(row).meta).not.toHaveProperty("boundary")
      }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))
  }

  it.effect("only a completion whose recorded reads were unverified journals the unverified read set", () =>
    Effect.gen(function*() {
      const evidence: StepBoundary.BoundaryEvidence = {
        declaredOutputs: { outputs: [] },
        diffIdentity: "unverified-reads",
        wholeTreeWritesVerified: true,
        hermeticReadsVerified: true
      }
      // The host measures different bytes than the declaration claims.
      const changed = StepBoundary.make({
        prepare: (descriptor) =>
          Effect.succeed({ descriptor, readSnapshot: [{ path: "input.txt", digest: "measured" }] }),
        settle: () => Effect.succeed(evidence),
        replayOutputs: () => Effect.void
      })
      const unverified = (runId: string, input: Omit<ActionPersistence.ActionInput, "action" | "attempt" | "key">) =>
        Effect.gen(function*() {
          yield* activate(runId)
          yield* ActionPersistence.make({ runId, owner, sourceId: runId, execute: () => Effect.succeed("done") })({
            ...input,
            action: {},
            attempt: 1,
            key: `${runId}/step`
          }).pipe(Effect.provideService(StepBoundary.StepBoundary, changed))
          return (yield* entries(runId)).filter((entry) =>
            (entry.payload as { readonly action?: string } | null)?.action === "unverified_read_set"
          ).length
        })
      expect(
        yield* unverified("stale-declaration", {
          tier: "sealed",
          metadata: { ...boundary, readSet: [{ path: "input.txt", digest: "declared" }] }
        })
      ).toBe(1)
      // An unsealed completion is withheld from the cache for its tier, not
      // for its reads, so it journals no read-set refusal.
      expect(yield* unverified("unsealed-completion", { tier: "irreversible" })).toBe(0)
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))

  it.effect("a crossing write carries the adopted row's meta across into the body's attempt", () =>
    Effect.gen(function*() {
      const runId = "adopted-park", key = `${runId}/charge`
      const id = { runId, stepKeyDigest: sha256(key), attempt: 1 }
      yield* activate(runId)
      const attempts = yield* AttemptStore.AttemptStore
      // A dead incarnation parked this keyed attempt mid-body.
      yield* attempts.put({
        ...id,
        state: "running",
        startedAtMs: 1,
        meta: {
          tier: "irreversible",
          keyed: true,
          effectCrossing: "parked",
          admittedBy: { hostId: "dead-host", pid: 1, nonce: "dead-process" }
        }
      }, owner)
      const seen: Array<unknown> = []
      const result = yield* ActionPersistence.make({
        runId,
        owner,
        sourceId: "dispatch-steps",
        execute: () =>
          Effect.map(attempts.get(id), (row) => {
            seen.push(Option.getOrThrow(row).meta)
            return "charged"
          })
      })({ action: {}, attempt: 1, key, tier: "irreversible" })
      expect(result).toBe("charged")
      expect(seen).toEqual([{ tier: "irreversible", keyed: true, admittedBy: owner, effectCrossing: "intended" }])
    }).pipe(Effect.provide(layer), Effect.scoped, withCrypto))
})
