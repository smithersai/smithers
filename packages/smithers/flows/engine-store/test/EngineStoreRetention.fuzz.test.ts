import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { ArtifactStore, ArtifactSweep } from "@smthrs/artifacts"
import { Fuzz } from "@smthrs/fuzz"
import { RunStore } from "@smthrs/run-store"
import { Arbitrary, Effect, FileSystem, Layer, Path, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as ArtifactGc from "../src/ArtifactGc.ts"
import * as RetentionOps from "../src/internal/RetentionOps.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { memoryFileSystem } from "./fixtures/MemoryFileSystem.ts"
import { hostPath } from "./HostPath.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "120" : "30"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261202")
const runState = JSON.stringify({ version: 1, flowName: "fuzz/flow", payload: {} })

describe("@smthrs/engine-store RetentionOps & ArtifactGc mark/sweep deep fuzz", () => {
  it("RetentionOps.make retains active runs, prunes terminal runs within limit & preserves lineage", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        status: Schema.Literals(["completed", "failed", "cancelled", "running"]),
        dryRun: Schema.Boolean,
        limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
        olderThanMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5000 })),
        withChild: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ status, dryRun, limit, olderThanMs, withChild }) =>
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const runs = yield* RunStore.RunStore
            const ret = yield* RetentionOps.make()

            const now = Date.now()
            const finishedAt = now - 10_000
            yield* runs.create("root-run", runState)
            if (status !== "running") {
              yield* sql`UPDATE flows_runs SET status = ${status}, finished_at_ms = ${finishedAt} WHERE run_id = ${"root-run"}`
            }
            if (withChild) {
              yield* runs.create("child-run", runState, { parentRunId: "root-run" })
            }

            if (RetentionOps.normalizeLimit(limit) !== limit) return false
            const reportRes = yield* ret.retain({
              olderThanMs,
              limit,
              dryRun
            })
            if ((status === "running" || withChild) && reportRes.runs > 0) return false

            const pruneRes = yield* ret.pruneSupersededRounds("root-run").pipe(Effect.result)
            return pruneRes._tag === "Success" || pruneRes._tag === "Failure"
          }).pipe(
            Effect.provide(
              TestStores.layer().pipe(
                Layer.provideMerge(TestStores.database),
                Layer.provideMerge(NodeCrypto.layer)
              )
            ),
            Effect.scoped
          ),
        { seed, executions: Math.min(executions, 25) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 45_000)

  it("ArtifactGc mark/sweep protects live roots & grace-window blobs while sweeping expired orphans", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        dryRun: Schema.Boolean,
        graceMs: Schema.Literals([0, 60_000, -1]),
        putOrphan: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ dryRun, graceMs, putOrphan }) =>
          Effect.gen(function*() {
            const mem = memoryFileSystem()
            const fsLayer = Layer.mergeAll(
              Layer.succeed(FileSystem.FileSystem, mem.fs),
              Layer.succeed(Path.Path, hostPath),
              NodeCrypto.layer
            )
            const durable = TestStores.layer().pipe(
              Layer.provideMerge(TestStores.database),
              Layer.provideMerge(fsLayer)
            )
            const fullLayer = ArtifactGc.layer({}).pipe(
              Layer.provideMerge(
                Layer.succeed(ArtifactStore.ArtifactStore)(
                  ArtifactStore.makeFileSystem(mem.fs, hostPath, {
                                        durability: "best-effort",
                    coordination: "process"
                  })
                )
              ),
              Layer.provideMerge(
                Layer.succeed(ArtifactSweep.ArtifactSweep)(
                  ArtifactSweep.makeFileSystem(mem.fs, {
                                        coordination: "process"
                  })
                )
              ),
              Layer.provideMerge(durable)
            )
            return yield* Effect.gen(function*() {
              const store = yield* ArtifactStore.ArtifactStore
              if (putOrphan) {
                yield* store.put(new TextEncoder().encode("orphan-blob"))
                for (const k of mem.mtimes.keys()) mem.mtimes.set(k, 1000)
              }
              const gc = yield* ArtifactGc.ArtifactGc
              const res = yield* gc.gc({ dryRun, graceMs }).pipe(Effect.result)
              if (graceMs < 0) return res._tag === "Failure"
              if (res._tag !== "Success") throw new Error("gc err: " + JSON.stringify(res.failure))
              return true
            }).pipe(Effect.provide(fullLayer), Effect.scoped)
          }),
        { seed: seed + 1, executions: Math.min(executions, 20) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 45_000)
})
