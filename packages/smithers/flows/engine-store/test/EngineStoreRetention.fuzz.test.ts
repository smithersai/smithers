/**
 * Retention and artifact collection against a model, over the real stores.
 *
 * Each property builds its durable state through the production stores under
 * a controlled clock, runs the operation, and compares what the database and
 * the object store hold afterwards with what a model of the rules says they
 * must hold. A pass that deletes nothing, a dry run that deletes, a grace
 * period that is ignored, and a mark that omits a live root each fail here.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { Fuzz } from "@smthrs/fuzz"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Arbitrary, Effect, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { memoryFileSystem } from "./fixtures/MemoryFileSystem.ts"
import { hostPath } from "./HostPath.ts"
import { sha256 } from "./Sha256.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "120" : "30"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261202")
const runState = JSON.stringify({ version: 1, flowName: "fuzz/flow", payload: {}, capabilityCeilings: [[]] })
const owner: Ownership.OwnerId = { hostId: "retention-fuzz", pid: 3, nonce: "retention-fuzz" }

/** The instant every pass runs at. Finish times are this minus a generated age. */
const passAtMs = 1_000_000

const Status = Schema.Literals(["completed", "failed", "cancelled", "running", "pending"])
const Age = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 }))
const Member = Schema.Struct({ status: Status, ageMs: Age })
/** A root run and, optionally, the continuation round that names it as `parent_run_id`. */
const Chain = Schema.Struct({ root: Member, child: Schema.NullOr(Member) })

interface ModelRun {
  readonly id: string
  readonly parent: string | null
  readonly status: typeof Status.Type
  readonly ageMs: number
}

const isTerminal = (run: ModelRun): boolean => run.status !== "running" && run.status !== "pending"

/**
 * The runs a sequence of passes must delete in total: aged terminal runs with
 * no live run above or below, minus every continuation parent whose child is
 * staying.
 */
const deletable = (runs: ReadonlyArray<ModelRun>, olderThanMs: number): ReadonlySet<string> => {
  const byId = new Map(runs.map((run) => [run.id, run]))
  const childOf = new Map(runs.flatMap((run) => run.parent === null ? [] : [[run.parent, run] as const]))
  const eligible = (run: ModelRun): boolean => {
    if (!isTerminal(run) || run.ageMs < olderThanMs) return false
    const parent = run.parent === null ? undefined : byId.get(run.parent)
    const child = childOf.get(run.id)
    return (parent === undefined || isTerminal(parent)) && (child === undefined || isTerminal(child))
  }
  const result = new Set<string>()
  for (const run of runs) {
    const child = childOf.get(run.id)
    if (eligible(run) && (child === undefined || eligible(child))) result.add(run.id)
  }
  return result
}

const encoder = new TextEncoder()
const objectsDirectory = ".flows/objects"
const blobPathOf = (digest: string): string => `${objectsDirectory}/${digest.slice(0, 2)}/${digest}`
const dayMs = 24 * 60 * 60 * 1000

describe("@smthrs/engine-store retention and artifact collection against a model", () => {
  it("retain deletes exactly the aged terminal runs no live lineage holds, within its bound", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        chains: Schema.Array(Chain).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        olderThanMs: Age
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ chains, limit, olderThanMs }) =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const runs = yield* RunStore.RunStore
            const retention = yield* RetentionOps.make()

            const model: Array<ModelRun> = chains.flatMap((chain, index) => [
              { id: `root-${index}`, parent: null, ...chain.root },
              ...(chain.child === null ? [] : [{ id: `child-${index}`, parent: `root-${index}`, ...chain.child }])
            ])
            // Real rows in their real statuses: created, claimed by an owner
            // when they have started, and settled by that owner at the
            // instant the model says they finished.
            yield* TestClock.setTime(0)
            for (const run of model) {
              yield* runs.create(run.id, runState, run.parent === null ? undefined : { parentRunId: run.parent })
            }
            for (const run of model) {
              if (run.status === "pending") continue
              const claimed = yield* runs.claimAndOwn(run.id, yield* runs.get(run.id), owner, 0)
              if (claimed._tag !== "Activated") throw new Error(`could not start ${run.id}: ${claimed._tag}`)
            }
            const finishing = model.filter(isTerminal).sort((left, right) => right.ageMs - left.ageMs)
            for (const run of finishing) {
              yield* TestClock.setTime(passAtMs - run.ageMs)
              const settled = yield* runs.transitionOwned(run.id, owner, run.status as RunStore.RunStatus)
              if (settled._tag !== "Transitioned") throw new Error(`could not settle ${run.id}: ${settled._tag}`)
            }
            yield* TestClock.setTime(passAtMs)

            const stored = sql<{
              readonly run_id: string
              readonly parent_run_id: string | null
              readonly status: string
              readonly finished_at_ms: number | null
            }>`SELECT run_id, parent_run_id, status, finished_at_ms FROM flows_runs ORDER BY run_id`.pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  id: row.run_id,
                  parent: row.parent_run_id,
                  status: row.status,
                  finishedAtMs: row.finished_at_ms === null ? null : Number(row.finished_at_ms)
                }))
              )
            )
            const seeded = yield* stored
            // The model and the database describe the same runs before any pass.
            expect(seeded).toEqual(
              [...model].sort((left, right) => left.id < right.id ? -1 : 1).map((run) => ({
                id: run.id,
                parent: run.parent,
                status: run.status,
                finishedAtMs: isTerminal(run) ? passAtMs - run.ageMs : null
              }))
            )

            const expected = deletable(model, olderThanMs)
            const options = { olderThanMs, limit }

            // A dry run reports the pass and changes nothing.
            const planned = yield* retention.retain({ ...options, dryRun: true })
            expect(yield* stored).toEqual(seeded)

            const deleted = new Set<string>()
            let previous = planned
            for (let pass = 0; pass <= model.length; pass++) {
              const before = yield* stored
              const outcome = yield* retention.retain(options)
              // The pass is the one its dry run described.
              expect(outcome).toEqual({ ...previous, dryRun: false })
              expect(outcome.runs).toBe(Math.min(limit, expected.size - deleted.size))
              for (const runId of outcome.runIds) {
                expect(expected.has(runId)).toBe(true)
                expect(deleted.has(runId)).toBe(false)
                deleted.add(runId)
              }
              // Exactly the reported rows left, and no surviving round names a parent that is gone.
              const after = yield* stored
              expect(after).toEqual(before.filter((row) => !outcome.runIds.includes(row.id)))
              const surviving = new Set(after.map((row) => row.id))
              expect(after.filter((row) => row.parent !== null && !surviving.has(row.parent))).toEqual([])
              if (outcome.runs === 0) break
              previous = yield* retention.retain({ ...options, dryRun: true })
            }

            // Passes converge on the model: every deletable run is gone and nothing else is.
            expect([...deleted].sort()).toEqual([...expected].sort())
            expect((yield* stored).map((row) => row.id)).toEqual(
              model.map((run) => run.id).filter((id) => !expected.has(id)).sort()
            )
            return true
          }).pipe(
            Effect.provide(
              TestStores.layer().pipe(
                Layer.provideMerge(TestStores.database),
                Layer.provideMerge(NodeCrypto.layer)
              )
            ),
            Effect.scoped,
            Effect.provide(TestClock.layer())
          ),
        { seed, executions: Math.min(executions, 25) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)

  it("gc sweeps exactly the unreferenced blobs older than the grace period, and only when asked to", async () => {
    const Blob = Schema.Struct({
      /** What keeps the blob: an attempt row, a cache entry, or nothing. */
      root: Schema.Literals(["attempt", "cache", "none"]),
      /** Far on either side of every generated grace period. */
      recent: Schema.Boolean
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        blobs: Schema.Array(Blob).check(Schema.isMaxLength(6)),
        dryRun: Schema.Boolean,
        graceMs: Schema.Literals([0, 60_000, -1])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ blobs, dryRun, graceMs }) =>
          Effect.gen(function*() {
            const host = memoryFileSystem()
            const durable = Layer.provideMerge(
              Layer.mergeAll(RunStore.layer, AttemptStore.layer, CacheStore.layer),
              TestStores.database
            )
            const fullLayer = ArtifactGc.layer({}).pipe(
              Layer.provide(
                Layer.succeed(ArtifactSweep.ArtifactSweep)(
                  ArtifactSweep.makeFileSystem(host.fs, { coordination: "process" })
                )
              ),
              Layer.provideMerge(
                Layer.succeed(ArtifactStore.ArtifactStore)(
                  ArtifactStore.makeFileSystem(host.fs, hostPath, {
                    durability: "best-effort",
                    coordination: "process"
                  })
                )
              ),
              Layer.provideMerge(durable),
              Layer.provideMerge(NodeCrypto.layer)
            )
            return yield* Effect.gen(function*() {
              const runs = yield* RunStore.RunStore
              const attempts = yield* AttemptStore.AttemptStore
              const cache = yield* CacheStore.CacheStore
              yield* runs.create("gc-run", runState)
              const claimed = yield* runs.claimAndOwn("gc-run", yield* runs.get("gc-run"), owner, 0)
              if (claimed._tag !== "Activated") throw new Error(`could not start gc-run: ${claimed._tag}`)

              const nowMs = Date.now()
              const seeded = yield* Effect.forEach(blobs, (blob, index) =>
                Effect.gen(function*() {
                  const content = encoder.encode(`blob-${index}-${blob.root}`)
                  const digest = sha256(content)
                  host.files.set(blobPathOf(digest), content)
                  host.mtimes.set(blobPathOf(digest), nowMs - (blob.recent ? 10_000 : 100 * dayMs))
                  const boundary = {
                    declaredOutputs: { outputs: [{ path: `out/${index}.bin`, digest, sizeBytes: content.length }] },
                    diffIdentity: `diff-${index}`
                  }
                  if (blob.root === "attempt") {
                    const put = yield* attempts.put({
                      runId: "gc-run",
                      stepKeyDigest: `step-${index}`,
                      attempt: 1,
                      state: "succeeded",
                      startedAtMs: 0,
                      finishedAtMs: 1,
                      meta: { tier: "sealed", boundary }
                    }, owner)
                    if (put._tag !== "Inserted") throw new Error(`could not record attempt ${index}`)
                  }
                  if (blob.root === "cache") {
                    const put = yield* cache.put({
                      keyDigest: `cache-key-${index}`,
                      result: { ok: true },
                      meta: { tier: "sealed", boundary },
                      createdAtMs: 0,
                      recordedRunId: "gc-run",
                      recordedEventSeq: 0
                    })
                    if (put._tag !== "Inserted") throw new Error(`could not record cache entry ${index}`)
                  }
                  return { ...blob, digest, bytes: content.length }
                }))
              const present = () =>
                seeded.filter((blob) => host.files.has(blobPathOf(blob.digest))).map((blob) => blob.digest)
              const all = seeded.map((blob) => blob.digest)

              const collector = yield* ArtifactGc.ArtifactGc
              const outcome = yield* collector.gc({ dryRun, graceMs }).pipe(Effect.result)
              if (graceMs < 0) {
                // A refused option deletes nothing.
                expect(outcome._tag).toBe("Failure")
                expect(present()).toEqual(all)
                return true
              }
              if (outcome._tag !== "Success") throw new Error(`gc failed: ${JSON.stringify(outcome.failure)}`)

              const orphans = seeded.filter((blob) => blob.root === "none")
              const expired = orphans.filter((blob) => !blob.recent || graceMs === 0)
              expect([...outcome.success.sweptDigests].sort()).toEqual(expired.map((blob) => blob.digest).sort())
              expect(outcome.success).toMatchObject({
                scannedBlobs: seeded.length,
                liveDigests: seeded.length - orphans.length,
                keptByGrace: orphans.length - expired.length,
                reclaimedBytes: expired.reduce((total, blob) => total + blob.bytes, 0),
                dryRun
              })
              // The object store holds every live and every recent blob, and
              // an expired orphan exactly when the pass was a dry run.
              const swept = new Set(dryRun ? [] : expired.map((blob) => blob.digest))
              expect(present()).toEqual(all.filter((digest) => !swept.has(digest)))
              return true
            }).pipe(Effect.provide(fullLayer), Effect.scoped)
          }),
        { seed: seed + 1, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)
})
