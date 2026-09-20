/**
 * Issue #129: the `cacheSource("recorded")` producer identity was a constant
 * per key, so when a run evicted a stale row and re-recorded a fresh result
 * under the same key, the second `cacheProvenance` emit collapsed into a
 * `Duplicate` whose receipt returned the ORIGINAL emission's seq — the fresh
 * cache row was persisted with the evicted generation's exact
 * `(recordedRunId, recordedEventSeq)`. A laggard dispatch still holding
 * pre-eviction provenance then passed the #119 `ifRecordedBy` CAS and
 * deleted the valid new row. The producer identity now folds a digest of the
 * recorded content, so a re-record with different content is a distinct
 * generation with fresh provenance, while the #124 convergence re-record
 * (identical content) still collapses into a `Duplicate`.
 */
import { describe, expect, it } from "@effect/vitest"
import type { FileInput } from "@smthrs/flow/FileInput"
import { Journal } from "@smthrs/journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import * as PlanStore from "@smthrs/plan-store/PlanStore"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as OwnerIdentity from "../src/OwnerIdentity.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { key, sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "generation-host", pid: 29, nonce: "generation-process" }

const declared: ActionPersistence.BoundaryMetadata = {
  readSet: [{ path: "config.json", digest: "D1" }],
  writeSet: ["output.txt"],
  boundaryMode: "hard"
}

const jjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ changeId: "generation-snapshot" as never }),
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

/**
 * A boundary whose `prepare` answers from a queue of measured read
 * snapshots: the cache-hit verification sees the first measurement, the
 * dispatch path's re-prepare sees the next. This models the #129 window —
 * the hit verification measures a changed file (stale read set → fenced
 * evict), the re-execution measures content matching the declaration again,
 * so its fresh completion is recorded under the same key.
 */
const flappingBoundary = (measurements: Array<ReadonlyArray<FileInput>>) =>
  Layer.succeed(
    StepBoundary.StepBoundary,
    StepBoundary.make({
      prepare: (descriptor) =>
        Effect.sync(() => ({
          descriptor,
          readSnapshot: measurements.length > 1 ? measurements.shift()! : measurements[0]!
        })),
      settle: (prepared) =>
        Effect.succeed({
          declaredOutputs: { paths: prepared.descriptor.writeSet },
          diffIdentity: "generation-diff",
          wholeTreeWritesVerified: true,
          hermeticReadsVerified: true
        }),
      replayOutputs: () => Effect.void
    })
  )

describe("post-eviction re-records take fresh provenance (issue #129)", () => {
  it.effect("stamps a re-recorded generation with its own event seq so the evicted fence cannot delete it", () =>
    Effect.gen(function*() {
      const runId = "generation-run"
      const key = "generation/evict-re-record"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate(runId)
          const execute = (result: string, attempt: number, boundary: Layer.Layer<StepBoundary.Service>) =>
            ActionPersistence.make({
              runId,
              owner,
              sourceId: `generation-${runId}`,
              execute: () => Effect.succeed(result)
            })({ action: {}, attempt, key, tier: "sealed", metadata: declared }).pipe(
              Effect.provide(boundary)
            )
          // Generation 0: records the row under a healthy measurement.
          yield* execute("recorded", 1, flappingBoundary([declared.readSet as never]))
          const generation0 = yield* cache.get(keyDigest)
          if (Option.isNone(generation0)) return yield* Effect.die(new Error("generation 0 missing"))
          // Generation 1, same run: the hit verification measures a stale read
          // set (fenced evict of generation 0), the re-execution's prepare
          // measures the declaration again and records a DIFFERENT result.
          const second = yield* execute(
            "regenerated",
            2,
            flappingBoundary([
              [{ path: "config.json", digest: "D2" }],
              declared.readSet as never
            ])
          )
          const generation1 = yield* cache.get(keyDigest)
          if (Option.isNone(generation1)) return yield* Effect.die(new Error("generation 1 missing"))
          // A laggard still holding generation 0's provenance must no-op.
          const laggardDeleted = yield* cache.evict(keyDigest, {
            ifRecordedBy: {
              runId: generation0.value.recordedRunId,
              eventSeq: generation0.value.recordedEventSeq
            }
          })
          const survivor = yield* cache.get(keyDigest)
          return {
            second,
            generation0: generation0.value,
            generation1: generation1.value,
            laggardDeleted,
            survivorPresent: Option.isSome(survivor)
          }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.second).toBe("regenerated")
      expect(outcome.generation1.result).toBe("regenerated")
      // The re-record is a NEW generation: it must not inherit the evicted
      // row's provenance through the journal's Duplicate receipt.
      expect(outcome.generation1.recordedEventSeq).not.toBe(outcome.generation0.recordedEventSeq)
      // And so the laggard's pre-eviction fence no longer matches anything.
      expect(outcome.laggardDeleted).toBe(false)
      expect(outcome.survivorPresent).toBe(true)
    }))
})

describe("identical-content re-records collapse into the original provenance", () => {
  it.effect("re-drives the #124 convergence re-record into a journal Duplicate with no new row (issue #140)", () =>
    Effect.gen(function*() {
      // The other half of the #129 contract: a crash between the provenance
      // emit and `cache.put` converges on the next dispatch by re-recording
      // the SAME content rebuilt from the persisted attempt row. That
      // re-record must collapse into a journal `Duplicate` — the producer
      // identity digest over `{ meta, result }` must be byte-stable across
      // the DB round-trip of `row.meta` — or every convergence appends a
      // fresh `cacheProvenance` row forever.
      const runId = "generation-convergence"
      const key = "generation/convergence-duplicate"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          const journal = yield* Journal.Journal
          yield* activate(runId)
          // Counted body (issue #146): the convergence under test re-records
          // from the PERSISTED succeeded row without re-running the body. A
          // constant body cannot distinguish that from a plain re-execution —
          // the sibling #141 cell proves an identical re-execution is
          // byte-identical in provenance — so only the counter pins the
          // `row.state === "succeeded"` replay branch itself.
          let executions = 0
          const execute = ActionPersistence.make({
            runId,
            owner,
            sourceId: `generation-${runId}`,
            execute: () =>
              Effect.sync(() => {
                executions++
                return "recorded"
              })
          })
          const dispatch = execute({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
            Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
          )
          yield* dispatch
          const original = yield* cache.get(keyDigest)
          if (Option.isNone(original)) return yield* Effect.die(new Error("original row missing"))
          // Model the crash window: the provenance row is journalled but the
          // cache row is gone, so the next dispatch of the same attempt takes
          // the succeeded-row convergence branch and re-records.
          yield* cache.evict(keyDigest)
          const replayed = yield* dispatch
          const converged = yield* cache.get(keyDigest)
          if (Option.isNone(converged)) return yield* Effect.die(new Error("converged row missing"))
          yield* journal.flush
          const page = yield* journal.entries({ runId: runId as never, limit: 100 })
          const recorded = page.entries.filter((entry) =>
            entry.eventType === "flows.engine.cache-provenance" &&
            (entry.payload as { readonly action?: string }).action === "recorded"
          )
          return { replayed, executions, original: original.value, converged: converged.value, recorded }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      expect(outcome.replayed).toBe("recorded")
      // The convergence replayed the persisted attempt row — it did NOT
      // re-execute the body (issue #146).
      expect(outcome.executions).toBe(1)
      // The identical-content re-record collapsed into a Duplicate: exactly
      // one recorded row in the journal, and the converged cache row carries
      // the ORIGINAL emission's canonical provenance.
      expect(outcome.recorded).toHaveLength(1)
      expect(outcome.converged.recordedEventSeq).toBe(outcome.original.recordedEventSeq)
      expect(outcome.converged.recordedRunId).toBe(outcome.original.recordedRunId)
    }))

  it.effect("pins the #129 by-design residual: an identical re-execution shares the evicted provenance (issue #141)", () =>
    Effect.gen(function*() {
      // A post-eviction RE-EXECUTION whose fresh content happens to equal the
      // evicted generation's collapses into the Duplicate and inherits the
      // evicted `(recordedRunId, recordedEventSeq)` — by design, since the two
      // rows are indistinguishable. The documented consequence is a lost hit,
      // not corruption: a laggard still holding pre-eviction provenance CAN
      // fence-delete the fresh row. This cell pins that residual so a change
      // to the generation digest or Duplicate-receipt handling cannot flip it
      // into different, unreviewed behaviour silently.
      const runId = "generation-residual"
      const key = "generation/evict-identical-re-record"
      const keyDigest = sha256(key)
      const outcome = yield* withCrypto(
        Effect.gen(function*() {
          const cache = yield* CacheStore.CacheStore
          yield* activate(runId)
          const execute = (attempt: number, boundary: Layer.Layer<StepBoundary.Service>) =>
            ActionPersistence.make({
              runId,
              owner,
              sourceId: `generation-${runId}`,
              execute: () => Effect.succeed("recorded")
            })({ action: {}, attempt, key, tier: "sealed", metadata: declared }).pipe(
              Effect.provide(boundary)
            )
          yield* execute(1, flappingBoundary([declared.readSet as never]))
          const generation0 = yield* cache.get(keyDigest)
          if (Option.isNone(generation0)) return yield* Effect.die(new Error("generation 0 missing"))
          // Fenced evict, then a re-execution recording the SAME result.
          yield* execute(
            2,
            flappingBoundary([
              [{ path: "config.json", digest: "D2" }],
              declared.readSet as never
            ])
          )
          const generation1 = yield* cache.get(keyDigest)
          if (Option.isNone(generation1)) return yield* Effect.die(new Error("generation 1 missing"))
          const laggardDeleted = yield* cache.evict(keyDigest, {
            ifRecordedBy: {
              runId: generation0.value.recordedRunId,
              eventSeq: generation0.value.recordedEventSeq
            }
          })
          const survivor = yield* cache.get(keyDigest)
          return {
            generation0: generation0.value,
            generation1: generation1.value,
            laggardDeleted,
            survivorPresent: Option.isSome(survivor)
          }
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jjLayer)), Effect.scoped)
      )
      // The indistinguishable re-record inherits the evicted provenance...
      expect(outcome.generation1.recordedEventSeq).toBe(outcome.generation0.recordedEventSeq)
      expect(outcome.generation1.recordedRunId).toBe(outcome.generation0.recordedRunId)
      // ...so the laggard's pre-eviction fence deletes the fresh row: the
      // documented lost-hit residual, pinned as a lost hit and nothing more.
      expect(outcome.laggardDeleted).toBe(true)
      expect(outcome.survivorPresent).toBe(false)
    }))
})

/**
 * B7: the `generation` identity was `Sha256(JSON.stringify({meta, result}))`,
 * whose "byte stable across the round trip" argument held only because the two
 * paths happened to emit the same key order. The fresh path spreads an object;
 * the convergence path decodes through `Schema.decodeUnknownEffect(AttemptMeta)`,
 * which emits keys in schema declaration order. The cases below permute the
 * PERSISTED `meta_json` so the two orders cannot coincide, which is what makes
 * the latent break observable.
 */
describe("the generation digest is canonical, not key-order-coincident (B7)", () => {
  // Composed here rather than through `TestStores.layer()` so `SqlClient` for
  // the SAME in-memory database stays reachable: that layer provides its
  // database inward, which hides the client the meta rewrite below needs.
  const services = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    PlanStore.layer,
    OwnerIdentity.layer,
    jjLayer
  ).pipe(Layer.provideMerge(TestStores.database))

  /** Rewrites the run's persisted attempt meta, keeping the fields, changing the order. */
  const rewriteMeta = (runId: string, transform: (meta: Record<string, unknown>) => Record<string, unknown>) =>
    Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const rows = yield* sql<{ readonly meta_json: string }>`
        SELECT meta_json FROM flows_attempts WHERE run_id = ${runId}
      `
      const original = rows[0]?.meta_json
      if (original === undefined) return yield* Effect.die(new Error("attempt row missing"))
      const rewritten = JSON.stringify(transform(JSON.parse(original) as Record<string, unknown>))
      yield* sql`UPDATE flows_attempts SET meta_json = ${rewritten} WHERE run_id = ${runId}`
      return { original, rewritten }
    })

  const driveConvergence = (
    runId: string,
    key: string,
    transform: (meta: Record<string, unknown>) => Record<string, unknown>
  ) =>
    withCrypto(
      Effect.gen(function*() {
        const cache = yield* CacheStore.CacheStore
        const journal = yield* Journal.Journal
        yield* activate(runId)
        const execute = ActionPersistence.make({
          runId,
          owner,
          sourceId: `generation-${runId}`,
          execute: () => Effect.succeed("recorded")
        })
        const dispatch = execute({ action: {}, attempt: 1, key, tier: "sealed", metadata: declared }).pipe(
          Effect.provide(StepBoundary.layerTest({ readSnapshot: StepBoundary.exactReads(declared) }))
        )
        yield* dispatch
        const rewrite = yield* rewriteMeta(runId, transform)
        // The crash window #124 converges from: provenance journalled, cache
        // row gone, so the next dispatch re-records from the persisted row.
        yield* cache.evict(sha256(key))
        yield* dispatch
        yield* journal.flush
        const page = yield* journal.entries({ runId: runId as never, limit: 100 })
        const recorded = page.entries.filter((entry) =>
          entry.eventType === "flows.engine.cache-provenance" &&
          (entry.payload as { readonly action?: string }).action === "recorded"
        )
        return { recorded, rewrite }
      }).pipe(Effect.provide(services), Effect.scoped)
    )

  it.effect("derives the same generation digest when the decoded AttemptMeta reorders keys", () =>
    Effect.gen(function*() {
      const outcome = yield* driveConvergence(
        "generation-key-order",
        "generation/key-order",
        (meta) => Object.fromEntries(Object.entries(meta).reverse())
      )

      // The permutation has to be a real one, or the case proves nothing.
      expect(outcome.rewrite.rewritten).not.toBe(outcome.rewrite.original)
      expect(JSON.parse(outcome.rewrite.rewritten)).toEqual(JSON.parse(outcome.rewrite.original))
      // One recorded row: the convergence collapsed into a journal Duplicate.
      // Under `JSON.stringify` the reordered meta digests differently, so the
      // re-record appended a second row — the unbounded append issue #124 closed.
      expect(outcome.recorded).toHaveLength(1)
    }))

  it("digests the generation identity independently of meta key order", () => {
    // The discriminating case. The two end-to-end cells below cannot fail
    // today: `Schema.decodeUnknownEffect(AttemptMeta)` re-emits keys in schema
    // declaration order whatever order the row was persisted in, and that
    // order currently coincides with the spread order the fresh emission uses.
    // That coincidence is the whole of B7 — it is latent, not live. This cell
    // pins the property the coincidence was standing in for, at the shape the
    // call site builds.
    const meta = { tier: "sealed", boundary: { b: "B", a: "A" }, readSetVerified: true }
    const reordered = Object.fromEntries(Object.entries(meta).reverse())

    expect(key({ kind: "cache-generation", meta, result: "recorded" }))
      .toBe(key({ kind: "cache-generation", meta: reordered, result: "recorded" }))
    // And the digest the identity used to be taken over does NOT have that
    // property, which is what adding one optional field to `AttemptMeta` above
    // an existing one would have exposed.
    expect(JSON.stringify({ meta, result: "recorded" }))
      .not.toBe(JSON.stringify({ meta: reordered, result: "recorded" }))
  })

  it.effect("converges when the persisted AttemptMeta carries an unexpected extra field", () =>
    Effect.gen(function*() {
      const outcome = yield* driveConvergence(
        "generation-extra-field",
        "generation/extra-field",
        (meta) => ({ unexpectedFutureField: "written by a newer writer", ...meta })
      )

      expect(JSON.parse(outcome.rewrite.rewritten)).toHaveProperty("unexpectedFutureField")
      // `AttemptMeta` strips the unknown field on decode, so the convergence
      // digests the same fields as the original emission — in declaration order
      // rather than the persisted order. Only a canonical digest makes that a
      // Duplicate rather than a fresh provenance row.
      expect(outcome.recorded).toHaveLength(1)
    }))
})
