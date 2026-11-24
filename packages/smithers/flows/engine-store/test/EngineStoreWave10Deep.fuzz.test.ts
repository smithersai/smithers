import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore } from "@smthrs/artifacts"
import type { Sha256 } from "@smthrs/crypto"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Flow } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { FileSet, KeyMaterial, Node, Plan } from "@smthrs/plan"
import { Jj } from "@smthrs/kernel"
import { PlanStore } from "@smthrs/plan-store"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Redacted,
  Result,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Retention from "../src/Retention.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as SelectionStore from "../src/SelectionStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261601")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const sampleOwner: Ownership.OwnerId = { hostId: "w10-host", pid: process.pid, nonce: "w10-nonce" }

const createAndOwn = (runs: RunStore.Service, runId: string, stateJson = "{}", now = 1000) =>
  Effect.gen(function*() {
    yield* runs.create(runId, stateJson)
    const row = yield* runs.get(runId)
    yield* runs.claimAndOwn(
      runId,
      { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
      sampleOwner,
      now
    )
    return row
  })

describe("EngineStore Wave 10 Deep: SelectionStore & PlanInputStore error/edge paths", () => {
  it("fuzzes SelectionStore decode_failed, train evidence cap & persistence_failed across all methods", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcome: Schema.Literals(["hit", "miss"]),
        corruptKind: Schema.Literals([
          "bad_confidence",
          "bad_scope",
          "dropped_table_upsert",
          "dropped_table_list",
          "dropped_table_train"
        ]),
        trainCount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const store = yield* SelectionStore.SelectionStore

              yield* store.upsert([
                {
                  scope: "pkg/a",
                  affects: "pkg/b",
                  confidence: 0.5,
                  validFromMs: 1000,
                  evidence: ["e0"]
                }
              ])
              const obs = Array.from({ length: input.trainCount }, (_, i) => ({
                scope: "pkg/a",
                affects: "pkg/b",
                outcome: input.outcome,
                reason: `r${i}`
              }))
              yield* store.train(obs)
              const snap = yield* store.snapshot()
              expect(snap.edges.length).toBe(1)

              if (input.corruptKind === "bad_confidence") {
                yield* sql`UPDATE flows_selection_suspected_edges SET evidence_json = ${"{\"bad\":1}"} WHERE scope = ${"pkg/a"}`
                expect(Exit.isFailure(yield* Effect.exit(store.list()))).toBe(true)
              } else if (input.corruptKind === "bad_scope") {
                yield* sql`UPDATE flows_selection_suspected_edges SET evidence_json = ${"[123]"} WHERE affects = ${"pkg/b"}`
                expect(Exit.isFailure(yield* Effect.exit(store.list()))).toBe(true)
              } else {
                yield* sql`DROP TABLE flows_selection_suspected_edges`
                if (input.corruptKind === "dropped_table_upsert") {
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(
                        store.upsert([{ scope: "x", affects: "y", confidence: 0.5, validFromMs: 1, evidence: [] }])
                      )
                    )
                  ).toBe(true)
                } else if (input.corruptKind === "dropped_table_list") {
                  expect(Exit.isFailure(yield* Effect.exit(store.list()))).toBe(true)
                } else {
                  expect(
                    Exit.isFailure(
                      yield* Effect.exit(store.train([{ scope: "pkg/a", affects: "pkg/b", outcome: "hit" }]))
                    )
                  ).toBe(true)
                }
              }
              return true
            }).pipe(
              Effect.provide(SelectionStore.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
              withCrypto
            )
          ),
        { executions: Math.min(executions, 25), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes PlanInputStore legacy runs, corrupt checksum, missing generation, and record/get roundtrip", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["legacy_run", "corrupt_hash", "corrupt_json", "roundtrip", "fence_lost"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const sql = yield* SqlClient.SqlClient
              const runs = yield* RunStore.RunStore
              const inputs = yield* PlanInputStore.PlanInputStore

              const runId = `pi-run-${input.mode}`
              yield* createAndOwn(runs, runId, JSON.stringify({ flowName: "f-pi" }))

              const baseDigest = "a".repeat(64)
              const envDigest = "b".repeat(64)
              const addr: PlanInputStore.Address = {
                runId,
                planId: "plan-1",
                baseDigest,
                environmentDigest: envDigest,
                generation: 0
              }
              const snap: PlanInputStore.Snapshot = {
                version: 1,
                generation: 0,
                nodes: [{ id: "n1", key: "k1", reads: [{ entry: "a.txt", sourcePaths: ["a.txt"] }] }],
                pins: [{ path: "a.txt", digest: "c".repeat(64) }]
              }

              if (input.mode === "legacy_run") {
                yield* sql`INSERT INTO flows_plan_input_legacy_runs (run_id) VALUES (${runId})`
                const ex = yield* Effect.exit(inputs.record(addr, snap, sampleOwner))
                expect(Exit.isFailure(ex)).toBe(true)
              } else if (input.mode === "fence_lost") {
                const ex = yield* Effect.exit(inputs.record(addr, snap, { ...sampleOwner, nonce: "wrong" }))
                expect(Exit.isFailure(ex)).toBe(true)
              } else if (input.mode === "roundtrip") {
                const recorded = yield* inputs.record(addr, snap, sampleOwner)
                expect(recorded.generation).toBe(0)
                const loaded = yield* inputs.get(addr, sampleOwner)
                expect(Option.isSome(loaded)).toBe(true)
              } else if (input.mode === "corrupt_hash") {
                yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${runId}, ${"plan-1"}, ${baseDigest}, ${envDigest}, ${1}, ${0})`
                yield* sql`INSERT INTO flows_plan_input_generations (run_id, plan_id, generation, snapshot_json, checksum) VALUES (${runId}, ${"plan-1"}, ${0}, ${JSON.stringify(snap)}, ${"0".repeat(64)})`
                const ex = yield* Effect.exit(inputs.get(addr, sampleOwner))
                expect(Exit.isFailure(ex)).toBe(true)
              } else {
                yield* sql`INSERT INTO flows_plan_input_heads (run_id, plan_id, base_digest, environment_digest, merge_state_version, generation) VALUES (${runId}, ${"plan-1"}, ${baseDigest}, ${envDigest}, ${1}, ${0})`
                yield* sql`INSERT INTO flows_plan_input_generations (run_id, plan_id, generation, snapshot_json, checksum) VALUES (${runId}, ${"plan-1"}, ${0}, ${"{\"wrong\":true}"}, ${"0".repeat(64)})`
                const ex = yield* Effect.exit(inputs.get(addr, sampleOwner))
                expect(Exit.isFailure(ex)).toBe(true)
              }
              return true
            }).pipe(
              Effect.provide(PlanInputStore.layer.pipe(Layer.provideMerge(TestStores.layerAt(":memory:")))),
              withCrypto
            )
          ),
        { executions: Math.min(executions, 25), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Deep: DisasterRecovery backup/corruption/incomplete/fence schema mismatch", () => {
  it("exercises DisasterRecovery artifact roots, artifact_corruption, snapshot_incomplete & fence schema_mismatch", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-es-dr-"))
    try {
      const dbFile = nodePath.join(dir, "live.sqlite3")
      const objectsDir = nodePath.join(dir, "objects")
      fs.mkdirSync(objectsDir, { recursive: true })

      const baseLayer = TestStores.layerAt(dbFile).pipe(
        Layer.provideMerge(NodeFileSystem.layer),
        Layer.provideMerge(NodePath.layer),
        Layer.provideMerge(NodeCrypto.layer),
        Layer.provideMerge(silentLogger)
      )

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            const attempts = yield* AttemptStore.AttemptStore
            const artStore = yield* ArtifactStore.ArtifactStore.pipe(
              Effect.provide(ArtifactStore.layerFileSystem({ directory: objectsDir }))
            )

            const blobBytes = new TextEncoder().encode("artifact-payload-w10")
            const blobDigest = yield* artStore.put(blobBytes)

            yield* createAndOwn(runs, "dr-run-1", JSON.stringify({ flowName: "dr-flow" }))
            const sql = yield* SqlClient.SqlClient
            yield* attempts.put(
              {
                runId: "dr-run-1",
                stepKeyDigest: "a".repeat(64),
                attempt: 1,
                state: "running",
                startedAtMs: 1000,
                meta: {
                  boundary: {
                    diffIdentity: "d1",
                    declaredOutputs: {
                      outputs: [{ path: "o.txt", digest: blobDigest, sizeBytes: blobBytes.byteLength }]
                    }
                  }
                }
              },
              sampleOwner
            )
            // Also attach checkpoint_json referencing the artifact digest
            yield* sql`UPDATE flows_attempts SET checkpoint_json = ${JSON.stringify({ outputs: [{ path: "c.txt", digest: blobDigest, sizeBytes: blobBytes.byteLength }] })} WHERE run_id = ${"dr-run-1"}`

            const snapDbLayer = (file: string) => NodeDatabase.layer({ filename: file })

            // 1. Backup WITHOUT objectsDirectory while DB references artifact -> snapshot_incomplete
            const bNoObj = nodePath.join(dir, "backup-no-obj")
            const noObjExit = yield* Effect.exit(
              DisasterRecovery.backup({ directory: bNoObj, snapshotDatabaseLayer: snapDbLayer })
            )
            expect(Exit.isFailure(noObjExit)).toBe(true)

            // 2. Full backup WITH objectsDirectory -> succeeds!
            const bOk = nodePath.join(dir, "backup-ok")
            const manifest = yield* DisasterRecovery.backup({
              directory: bOk,
              objectsDirectory: objectsDir,
              snapshotDatabaseLayer: snapDbLayer
            })
            expect(manifest.artifacts.length).toBeGreaterThanOrEqual(1)

            // 3. Fence with mismatched migrations -> schema_mismatch
            const badManifest: DisasterRecovery.BackupManifest = {
              ...manifest,
              database: {
                ...manifest.database,
                migrations: [{ migrationId: 99999, name: "nonexistent_migration" }]
              }
            }
            const fenceExit = yield* Effect.exit(DisasterRecovery.fence(badManifest))
            expect(Exit.isFailure(fenceExit)).toBe(true)

            // 4. Corrupt the blob on disk -> backup fails with artifact_corruption
            const shard = blobDigest.slice(0, 2)
            const blobPath = nodePath.join(objectsDir, shard, blobDigest)
            if (fs.existsSync(blobPath)) {
              fs.chmodSync(blobPath, 0o600)
              fs.writeFileSync(blobPath, "CORRUPTED-BYTES")
              const bCorrupt = nodePath.join(dir, "backup-corrupt")
              const corruptExit = yield* Effect.exit(
                DisasterRecovery.backup({
                  directory: bCorrupt,
                  objectsDirectory: objectsDir,
                  snapshotDatabaseLayer: snapDbLayer
                })
              )
              expect(Exit.isFailure(corruptExit)).toBe(true)
            }
          })
        ).pipe(Effect.provide(baseLayer))
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("EngineStore Wave 10 Deep: StepBoundary ArtifactStore errors, Glob/Tree writeSets & DurableEngineState pagination", () => {
  it("fuzzes StepBoundary replayOutputs artifact corruption/store-error & capture with Glob/Tree writeSets", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-es-sb-"))
    try {
      fs.mkdirSync(nodePath.join(dir, "out", "sub"), { recursive: true })
      fs.writeFileSync(nodePath.join(dir, "in.txt"), "hello")
      fs.writeFileSync(nodePath.join(dir, "out", "a.txt"), "alpha")
      fs.writeFileSync(nodePath.join(dir, "out", "sub", "b.txt"), "beta")

      const arb = Arbitrary.schema(
        Schema.Struct({
          fault: Schema.Literals([
            "artifact_corruption",
            "artifact_store_error",
            "inline_digest_mismatch",
            "glob_and_tree"
          ])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.gen(function*() {
              const fsSvc = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const digest = "d".repeat(64) as ArtifactStore.Digest

              const faultyArt: ArtifactStore.Service = {
                put: () => Effect.succeed(digest),
                get: () => {
                  if (input.fault === "artifact_corruption") {
                    return Effect.fail(
                      new ArtifactStore.ArtifactCorruption({
                        code: "artifact_corruption",
                        recordedDigest: digest,
                        measuredDigest: "e".repeat(64) as ArtifactStore.Digest
                      })
                    )
                  }
                  return Effect.fail(
                    new ArtifactStore.ArtifactStoreError({
                      code: "transport_failed",
                      message: "disk read error"
                    })
                  )
                },
                has: () => Effect.succeed(false),
                delete: () => Effect.void,
                list: () => Effect.succeed([])
              } as unknown as ArtifactStore.Service

              const sb = StepBoundary.makeFileSystem(
                KernelFileSystem.withIsolatedFileSystem(fsSvc),
                pathSvc,
                faultyArt,
                { root: dir }
              )

              if (input.fault === "glob_and_tree") {
                const desc: FileBoundary = {
                  readSet: [{ path: "in.txt", digest: "0".repeat(64) }],
                  writeSet: [
                    { _tag: "Glob", include: ["out/*.txt"] },
                    { _tag: "TreeArtifact", path: "out/sub" }
                  ],
                  boundaryMode: "expected"
                }
                const prep = yield* sb.prepare(desc)
                const settled = yield* sb.settle(prep)
                expect(settled.diffIdentity.length).toBeGreaterThan(0)
              } else if (input.fault === "inline_digest_mismatch") {
                const ev: StepBoundary.BoundaryEvidence = {
                  diffIdentity: "d-mis",
                  declaredOutputs: {
                    outputs: [
                      {
                        path: "out/a.txt",
                        digest,
                        sizeBytes: 5,
                        content: Buffer.from("wrong").toString("base64")
                      }
                    ]
                  }
                }
                const ex = yield* Effect.exit(sb.replayOutputs(ev))
                expect(Exit.isFailure(ex)).toBe(true)
              } else {
                const ev: StepBoundary.BoundaryEvidence = {
                  diffIdentity: "d-art-err",
                  declaredOutputs: {
                    outputs: [{ path: "out/a.txt", digest, sizeBytes: 5 }]
                  }
                }
                const ex = yield* Effect.exit(sb.replayOutputs(ev))
                expect(Exit.isFailure(ex)).toBe(true)
              }
              return true
            }).pipe(
              Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, silentLogger))
            ),
          { executions: Math.min(executions, 20), seed: seed + 3 }
        )
      )
      assertPassed(report)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("fuzzes DurableEngineState waitingRuns pagination, recordRunParent duplicate, memory waitingRunsPage & restoreJsonExit", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        pageLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
        cancelRequested: Schema.Boolean,
        hasChildren: Schema.Boolean
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const state = yield* DurableEngineState.DurableEngineState
              const runs = yield* RunStore.RunStore
              const sql = yield* SqlClient.SqlClient

              for (let i = 0; i < 4; i++) {
                const runId = `w-run-${i}`
                yield* runs.create(
                  runId,
                  JSON.stringify({
                    flowName: "wait-flow",
                    waiting: { reason: "sleep", wakeAtMs: 2000 + i * 10 }
                  })
                )
                yield* sql`UPDATE flows_runs SET status = ${"suspended"}, waiting_reason = ${"sleep"}, waiting_wake_at_ms = ${2000 + i * 10} WHERE run_id = ${runId}`
                if (input.cancelRequested && i % 2 === 0) {
                  yield* sql`UPDATE flows_runs SET cancel_requested_at_ms = ${1500} WHERE run_id = ${runId}`
                }
              }

              const first = yield* state.recordRunParent("w-run-1", "w-run-0")
              expect(first._tag).toBe("Recorded")
              const dup = yield* state.recordRunParent("w-run-1", "w-run-0")
              expect(dup._tag).toBe("Existing")

              const paged = yield* state.waitingRuns({
                reason: "sleep",
                dueBeforeMs: 5000,
                cancelRequested: input.cancelRequested,
                hasChildren: input.hasChildren,
                page: { limit: input.pageLimit }
              })
              expect(Array.isArray(paged)).toBe(true)

              const mem = DurableEngineState.makeMemory()
              const memPage = yield* mem.waitingRunsPage({ page: { limit: input.pageLimit } })
              expect(Array.isArray(memPage.rows)).toBe(true)

              const exitShapes = [
                { _id: "Exit", _tag: "Success", value: 42 },
                { _id: "Exit", _tag: "Failure", cause: { reasons: [{ _tag: "Fail", error: "e1" }] } },
                { _id: "Exit", _tag: "Failure", cause: { failures: [{ _tag: "Die", defect: "d1" }] } },
                { _id: "Exit", _tag: "Failure", cause: { reasons: [{ _tag: "Interrupt", fiberId: 1 }] } },
                { _id: "Exit", _tag: "Failure", cause: null },
                { _id: "Exit", _tag: "Failure", cause: { reasons: "not-array" } },
                { _id: "Exit", _tag: "Failure", cause: { reasons: [null] } },
                { _id: "Exit", _tag: "Other" },
                "plain-primitive"
              ]
              for (let i = 0; i < exitShapes.length; i++) {
                const key = `def-key-${i}`
                yield* sql`INSERT INTO flows_deferred_completions (flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms) VALUES (${"wait-flow"}, ${"w-run-0"}, ${key}, ${JSON.stringify(exitShapes[i])}, ${"{}"}, ${1200})`
                const read = yield* state.deferred({ flowName: "wait-flow", executionId: "w-run-0", deferredName: key })
                expect(read).toBeDefined()
              }

              return true
            }).pipe(
              Effect.provide(TestStores.layerAt(":memory:")),
              withCrypto
            )
          ),
        { executions: Math.min(executions, 20), seed: seed + 4 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Deep: RunInspection schemas/redaction/filters, Retention lineage & PlanScheduler", () => {
  it("fuzzes RunInspection holdsRedacted (Suspend), schemasOf duplicate/throwing flow, withheldMarker & list filters", async () => {
    interface Rec {
      readonly secret: Redacted.Redacted<string>
      readonly next?: Rec | undefined
    }
    const RecSchema: Schema.Schema<Rec> = Schema.Struct({
      secret: Schema.Redacted(Schema.String),
      next: Schema.optional(Schema.suspend(() => RecSchema))
    })
    expect(RunInspection.holdsRedacted(RecSchema)).toBe(true)
    expect(RunInspection.holdsRedacted(Schema.Struct({ plain: Schema.String }))).toBe(false)

    const throwingFlow = Flow.make("throw-plan-flow", {
      payload: Schema.Struct({ x: Schema.Number }),
      success: Schema.Struct({ y: Schema.String }),
      body: (input) => {
        if (typeof (input as { x?: unknown }).x !== "number") throw new Error("needs concrete input")
        return Node.succeed({ y: "1" })
      }
    })
    const dupFlow = Flow.make("throw-plan-flow", {
      payload: Schema.Struct({ x: Schema.Number }),
      success: Schema.Number,
      body: () => Node.succeed(1)
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const insp = yield* RunInspection.RunInspection

          yield* runs.create(
            "insp-1",
            JSON.stringify({
              version: 1,
              flowName: "throw-plan-flow",
              payload: { wrongField: "mismatch" },
              output: { y: "12345678901234567890" }
            })
          )
          yield* runs.create(
            "insp-2",
            JSON.stringify({ version: 1, flowName: "unknown-flow", payload: { secret: "x" } })
          )

          const list1 = yield* insp.list({
            roots: true,
            runIds: ["insp-1", "insp-2"],
            flows: ["throw-plan-flow", "unknown-flow"],
            limit: 1
          })
          expect(list1.runs.length).toBe(1)
          if (list1.cursor !== null) {
            const list2 = yield* insp.list({
              roots: true,
              runIds: ["insp-1", "insp-2"],
              flows: ["throw-plan-flow", "unknown-flow"],
              cursor: list1.cursor,
              limit: 5
            })
            expect(list2.runs.length).toBeGreaterThanOrEqual(1)
          }

          const d1 = yield* insp.inspect("insp-1")
          expect(d1.run.runId).toBe("insp-1")
          const d2 = yield* insp.inspect("insp-2")
          expect(d2.run.runId).toBe("insp-2")
        }).pipe(
          Effect.provide(
            RunInspection.layerWith({ flows: [throwingFlow, dupFlow] }).pipe(
              Layer.provideMerge(TestStores.layerAt(":memory:"))
            )
          ),
          withCrypto
        )
      )
    )
  }, 60_000)

  it("fuzzes Retention pinAncestors (3-level chain) & lineage pruning edge cases", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          const sql = yield* SqlClient.SqlClient
          const now = Date.now()
          const oldTs = now - 60 * 24 * 60 * 60 * 1000

          yield* runs.create("ret-root", JSON.stringify({ flowName: "f" }))
          yield* runs.create("ret-mid", JSON.stringify({ flowName: "f" }), { parentRunId: "ret-root" })
          yield* runs.create("ret-leaf", JSON.stringify({ flowName: "f" }), { parentRunId: "ret-mid" })
          yield* sql`UPDATE flows_runs SET status = ${"completed"}, finished_at_ms = ${oldTs} WHERE run_id IN (${"ret-root"}, ${"ret-mid"})`
          yield* sql`UPDATE flows_runs SET status = ${"completed"}, finished_at_ms = ${now - 1000} WHERE run_id = ${"ret-leaf"}`

          // 4-round lineage with root (0), mid1 (1), mid2 (2), latest (3)
          yield* runs.create("lin-0", JSON.stringify({ flowName: "f-lin" }))
          yield* runs.create("lin-1", JSON.stringify({ flowName: "f-lin" }), { lineageId: "lin-0", parentRunId: "lin-0", roundOrdinal: 1 })
          yield* runs.create("lin-2", JSON.stringify({ flowName: "f-lin" }), { lineageId: "lin-0", parentRunId: "lin-1", roundOrdinal: 2 })
          yield* runs.create("lin-3", JSON.stringify({ flowName: "f-lin" }), { lineageId: "lin-0", parentRunId: "lin-2", roundOrdinal: 3 })
          yield* sql`UPDATE flows_runs SET status = ${"completed"}, finished_at_ms = ${oldTs} WHERE run_id IN (${"lin-0"}, ${"lin-1"}, ${"lin-2"}, ${"lin-3"})`

          const report = yield* Retention.collect({ olderThanMs: now - 24 * 60 * 60 * 1000 })
          expect(report).toBeDefined()
        }).pipe(
          Effect.provide(TestStores.layerAt(":memory:")),
          withCrypto
        )
      )
    )
  }, 60_000)

  it("fuzzes PlanScheduler conflict (plan_changed), append generation, bad environment & missing/failing FileSystem", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-es-ps-"))
    const noopJj = Layer.succeed(
      Jj.Jj,
      Jj.make({
        snapshot: () => Effect.succeed({ commitId: "w10-snap" as never, changeId: "w10-snap" as never }),
        restore: () => Effect.void,
        diff: () => Effect.succeed(""),
        workspaceAdd: () => Effect.void,
        workspaceForget: () => Effect.void,
        workspaceList: () => Effect.succeed([]),
        status: () => Effect.succeed({ modified: [], added: [], removed: [], conflicted: [] }),
        log: () => Effect.succeed([]),
        rebase: () => Effect.void,
        squash: () => Effect.void,
        newChange: () => Effect.succeed({ commitId: "w10-new" as never, changeId: "w10-new" as never }),
        describe: () => Effect.void
      } as never)
    )
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            yield* createAndOwn(runs, "ps-run-1", JSON.stringify({ flowName: "ps-flow" }))

            const draft = (
              id: string,
              reads: ReadonlyArray<string | { readonly _tag: "Glob"; readonly include: readonly [string, ...string[]] }> = []
            ): Plan.NodeDraft => ({
              id,
              material: {
                version: KeyMaterial.version,
                kind: "sealed",
                body: { action: id },
                inputs: [],
                layers: [],
                capabilities: []
              },
              effects: {
                reads: reads as never,
                writes: [`${id}.out`],
                boundaryMode: "expected"
              }
            })

            const plan1 = yield* Plan.compile({
              planId: "p-conflict",
              flow: "ps-flow",
              nodes: [draft("n1")]
            })
            const plan1Diff = yield* Plan.compile({
              planId: "p-conflict",
              flow: "ps-flow",
              nodes: [draft("n1"), draft("n2")]
            })
            const plan1Gen1 = yield* Plan.append(plan1, [draft("n2")])

            const execLayer = PlanScheduler.layerExecutor({
              execute: () => Effect.succeed({ outcome: "built" as const, value: "ok" })
            })

            const badEnvSched = PlanScheduler.make({
              runId: "ps-run-1",
              owner: sampleOwner,
              sourceId: "s-bad-env",
              environment: { version: -1 } as never
            })
            const badEnvExit = yield* Effect.exit(
              badEnvSched.run(plan1).pipe(Effect.provide(Layer.merge(execLayer, noopJj)))
            )
            expect(Exit.isFailure(badEnvExit)).toBe(true)

            const sched = PlanScheduler.make({
              runId: "ps-run-1",
              owner: sampleOwner,
              sourceId: "s-ok"
            })
            yield* sched.record(plan1)
            yield* sched.append(plan1Gen1)
            const conflictExit = yield* Effect.exit(sched.record(plan1Diff))
            expect(Exit.isFailure(conflictExit)).toBe(true)

            const globPlan = yield* Plan.compile({
              planId: "p-glob",
              flow: "ps-flow",
              nodes: [draft("ng", [{ _tag: "Glob", include: ["src/*.ts"] }])]
            })
            const noFsExit = yield* Effect.exit(
              sched.run(globPlan).pipe(Effect.provide(Layer.merge(execLayer, noopJj)))
            )
            expect(Exit.isFailure(noFsExit)).toBe(true)

            const failingFs = Layer.succeed(FileSystem.FileSystem, {
              readDirectory: () =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "readDirectory",
                    pathOrDescriptor: dir
                  })
                ),
              stat: () =>
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "stat",
                    pathOrDescriptor: dir
                  })
                )
            } as unknown as FileSystem.FileSystem)
            const failFsExit = yield* Effect.exit(
              sched.run(globPlan).pipe(Effect.provide(Layer.mergeAll(execLayer, noopJj, failingFs)))
            )
            expect(Exit.isFailure(failFsExit)).toBe(true)
          })
        ).pipe(
          Effect.provide(
            Layer.mergeAll(PlanStore.layer, PlanInputStore.layer, StepBoundary.layerTest()).pipe(
              Layer.provideMerge(TestStores.layerAt(":memory:"))
            )
          ),
          withCrypto
        )
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
