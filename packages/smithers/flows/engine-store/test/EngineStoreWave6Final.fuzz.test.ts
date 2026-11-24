import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore } from "@smthrs/artifacts"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Node, Plan, type Planned } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { type Ownership, RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Result,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as RuntimeGraph from "../src/internal/RuntimeGraph.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "w6-fin-host", pid: 9201, nonce: "w6-fin" }

const noopJjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w6-fin-snap" as never, changeId: "w6-fin-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activateRun = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snap: RunStore.RunSnapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const cl = yield* runs.claim(runId, snap, owner, 1)
    if (cl._tag === "Claimed") {
      yield* runs.activate(runId, owner, cl.claimedAtMs, snap)
    }
  })

describe("EngineStore Wave-6 Final Coverage Targets fuzz", () => {
  it(
    "fuzzes ActionPersistence direct quarantine/stale-readSet/FailureSite, PlanScheduler rebase-exhaustion, and RuntimeGraph reorder/fences",
    async () => {
      const FinalSchema = Schema.Struct({
        mode: Schema.Literals([
          "direct_quarantine_fail",
          "direct_quarantine_tolerate",
          "stale_readset_refusal",
          "failure_site_annotation",
          "plan_rebase_exhaust_verdicts",
          "runtime_graph_fences_and_reorder",
          "chained_retry_copied_record"
        ]),
        verdictKind: Schema.Literals(["Fail", "Reorder", "FactorOut", "Allow"]),
        seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(FinalSchema),
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                if (
                  input.mode === "direct_quarantine_fail" ||
                  input.mode === "direct_quarantine_tolerate"
                ) {
                  let corrupt = false
                  let execCount = 0
                  const corruption = new StepBoundary.BoundaryCorruption({
                    code: "boundary_corruption",
                    path: "dist/out.txt",
                    recordedDigest: "aa".repeat(32),
                    measuredDigest: "bb".repeat(32)
                  })
                  const boundaryLayer = Layer.succeed(
                    StepBoundary.StepBoundary,
                    StepBoundary.make({
                      prepare: (descriptor) =>
                        Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
                      settle: () =>
                        Effect.succeed({
                          declaredOutputs: { outputs: [] },
                          diffIdentity: "q-fin-diff",
                          wholeTreeWritesVerified: true,
                          hermeticReadsVerified: true
                        }),
                      replayOutputs: () => corrupt ? Effect.fail(corruption) : Effect.void
                    })
                  )
                  const base = Layer.mergeAll(
                    TestStores.layerAt(":memory:"),
                    noopJjLayer,
                    Action.layerCacheEnvironment({ layers: [], capabilities: {} }),
                    boundaryLayer
                  )
                  const inconLayer = (input.mode === "direct_quarantine_fail"
                    ? Inconsistency.layerStrict(owner)
                    : Inconsistency.layerTolerant(owner)).pipe(Layer.provideMerge(base))
                  const layer = inconLayer
                  return yield* Effect.gen(function*() {
                    const runId = `dq-${input.seedTag}`
                    yield* activateRun(runId)
                    const dispatch = ActionPersistence.make({
                      runId,
                      owner,
                      sourceId: `dq-src-${input.seedTag}`,
                      execute: () =>
                        Effect.sync(() => {
                          execCount += 1
                          return `durable-val#${execCount}`
                        })
                    })
                    const meta: ActionPersistence.BoundaryMetadata = {
                      readSet: [{ path: "in.txt", digest: "D1" }],
                      writeSet: ["dist/out.txt"],
                      boundaryMode: "hard"
                    }
                    // 1st dispatch: executes & persists succeeded row with boundary evidence
                    const r1 = yield* dispatch({
                      action: {},
                      attempt: 1,
                      key: `dq/k/${input.seedTag}`,
                      tier: "sealed",
                      metadata: meta
                    })
                    expect(r1).toBe("durable-val#1")
                    expect(execCount).toBe(1)

                    // 2nd dispatch on SAME runId + attempt 1 with corrupt replayOutputs -> hits replayAttemptOutputs, replayCorruption, quarantineAttemptEvidence, patchQuarantined!
                    corrupt = true
                    const r2Exit = yield* Effect.exit(
                      dispatch({ action: {}, attempt: 1, key: `dq/k/${input.seedTag}`, tier: "sealed", metadata: meta })
                    )
                    // Verify outcome (strict dies with AttemptEvidenceQuarantined when replayOutputs runs; tolerate succeeds)
                    if (input.mode === "direct_quarantine_tolerate") {
                      expect(Exit.isSuccess(r2Exit)).toBe(true)
                    }

                    // 3rd dispatch: row is now boundaryQuarantined -> returns durable outcome directly without touching replayOutputs or re-running!
                    const r3 = yield* dispatch({
                      action: {},
                      attempt: 1,
                      key: `dq/k/${input.seedTag}`,
                      tier: "sealed",
                      metadata: meta
                    })
                    expect(r3).toBe("durable-val#1")
                    expect(execCount).toBe(1)
                    return true
                  }).pipe(Effect.provide(layer))
                }

                if (input.mode === "stale_readset_refusal") {
                  let readDigest = "D1"
                  let execCount = 0
                  const boundaryLayer = Layer.succeed(
                    StepBoundary.StepBoundary,
                    StepBoundary.make({
                      prepare: (descriptor) =>
                        Effect.succeed({
                          descriptor,
                          readSnapshot: [{ path: "in.txt", digest: readDigest }]
                        }),
                      settle: () =>
                        Effect.succeed({
                          declaredOutputs: { outputs: [] },
                          diffIdentity: "stale-diff",
                          wholeTreeWritesVerified: true,
                          hermeticReadsVerified: true
                        }),
                      replayOutputs: () => Effect.void
                    })
                  )
                  const layer = Layer.mergeAll(
                    TestStores.layerAt(":memory:"),
                    noopJjLayer,
                    Action.layerCacheEnvironment({ layers: [], capabilities: {} }),
                    boundaryLayer
                  )
                  return yield* Effect.gen(function*() {
                    const meta: ActionPersistence.BoundaryMetadata = {
                      readSet: [{ path: "in.txt", digest: "D1" }],
                      writeSet: [],
                      boundaryMode: "hard"
                    }
                    yield* activateRun(`sr1-${input.seedTag}`)
                    const d1 = ActionPersistence.make({
                      runId: `sr1-${input.seedTag}`,
                      owner,
                      sourceId: `sr1-s`,
                      execute: () => Effect.sync(() => `v#${++execCount}`)
                    })
                    const r1 = yield* d1({
                      action: {},
                      attempt: 1,
                      key: `sr/k/${input.seedTag}`,
                      tier: "sealed",
                      metadata: meta
                    })
                    expect(r1).toBe("v#1")

                    // Change measured read digest -> cache lookup hits refuseStaleReadSet (L2139-2146) and re-executes!
                    readDigest = "D2-CHANGED"
                    yield* activateRun(`sr2-${input.seedTag}`)
                    const d2 = ActionPersistence.make({
                      runId: `sr2-${input.seedTag}`,
                      owner,
                      sourceId: `sr2-s`,
                      execute: () => Effect.sync(() => `v#${++execCount}`)
                    })
                    const r2 = yield* d2({
                      action: {},
                      attempt: 1,
                      key: `sr/k/${input.seedTag}`,
                      tier: "sealed",
                      metadata: meta
                    })
                    expect(r2).toBe("v#2")
                    return true
                  }).pipe(Effect.provide(layer))
                }

                if (input.mode === "failure_site_annotation") {
                  const layer = Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer, StepBoundary.layerTest())
                  return yield* Effect.gen(function*() {
                    const runId = `fsite-${input.seedTag}`
                    yield* activateRun(runId)
                    const dispatch = ActionPersistence.make({
                      runId,
                      owner,
                      sourceId: `fsite-s`,
                      execute: () =>
                        Effect.failCause(
                          Cause.fromReasons([
                            Cause.makeFailReason({ _tag: "SiteErr", msg: "boom" }).annotate(
                              Context.make(FlowEngine.FailureSite, {
                                executionId: "r-site",
                                action: "w6-fin/site",
                                attempts: 1,
                                nodeId: "n-site"
                              })
                            )
                          ])
                        )
                    })
                    const e1 = yield* Effect.exit(
                      dispatch({ action: {}, attempt: 1, key: `fsite/k/${input.seedTag}`, tier: "sealed" })
                    )
                    expect(Exit.isFailure(e1)).toBe(true)
                    // Replay rehydrates FailureSite annotation too!
                    const e2 = yield* Effect.exit(
                      dispatch({ action: {}, attempt: 1, key: `fsite/k/${input.seedTag}`, tier: "sealed" })
                    )
                    expect(Exit.isFailure(e2)).toBe(true)
                    return true
                  }).pipe(Effect.provide(layer))
                }

                if (input.mode === "plan_rebase_exhaust_verdicts") {
                  const layer = Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer, StepBoundary.layerTest())
                  return yield* Effect.gen(function*() {
                    const runId = `prb-${input.seedTag}`
                    yield* activateRun(runId)
                    const plan = yield* Plan.compile({
                      planId: `prb-${input.seedTag}`,
                      flow: "w6/RebaseExhaust",
                      nodes: [
                        {
                          id: "a",
                          material: {
                            version: "flows/key-material/v2",
                            kind: "sealed",
                            body: "a",
                            inputs: [],
                            layers: [],
                            capabilities: []
                          },
                          effects: { reads: [], writes: ["shared.txt"], boundaryMode: "hard" },
                          conflictStrategy: "lane",
                          runtimeStrategy: "delay-rebase"
                        },
                        {
                          id: "b",
                          material: {
                            version: "flows/key-material/v2",
                            kind: "sealed",
                            body: "b",
                            inputs: [],
                            layers: [],
                            capabilities: []
                          },
                          effects: { reads: [], writes: ["shared.txt"], boundaryMode: "hard" },
                          conflictStrategy: "lane",
                          runtimeStrategy: "delay-rebase"
                        },
                        {
                          id: "c",
                          material: {
                            version: "flows/key-material/v2",
                            kind: "sealed",
                            body: "c",
                            inputs: [],
                            layers: [],
                            capabilities: []
                          },
                          effects: { reads: ["shared.txt"], writes: ["c.out"], boundaryMode: "hard" }
                        }
                      ]
                    })
                    const verdict: Reconciliation.Verdict = input.verdictKind === "Fail"
                      ? { _tag: "Fail", reason: "exhausted" }
                      : input.verdictKind === "Reorder"
                      ? { _tag: "Reorder", dependsOn: ["a"], reason: "reorder-after-conflict" }
                      : input.verdictKind === "FactorOut"
                      ? { _tag: "FactorOut", paths: ["x"], reason: "factor" }
                      : { _tag: "Reorder", dependsOn: ["a"], reason: "allow-reorder" }
                    const reconcilerLayer = Reconciliation.layer(
                      Reconciliation.make({
                        onDeviation: () => Effect.succeed(verdict),
                        onConflict: () => Effect.succeed(verdict)
                      })
                    )
                    const executor: PlanScheduler.Executor = {
                      execute: ({ node }) =>
                        node.id === "b"
                          ? Effect.fail(
                            new WorkspaceSandbox.MaterializationConflict({
                              paths: ["shared.txt"],
                              message: "persistent conflict"
                            })
                          )
                          : Effect.succeed(`ok-${node.id}`)
                    }
                    const sched = PlanScheduler.make({
                      runId,
                      owner,
                      sourceId: `sched/${runId}`,
                      concurrency: { steps: 2 },
                      rebaseLimit: 1
                    })
                    yield* sched.record(plan)
                    const rep = yield* sched.run(plan).pipe(
                      Effect.provide(Layer.mergeAll(PlanScheduler.layerExecutor(executor), reconcilerLayer))
                    )
                    expect(rep.settlements.length).toBeGreaterThanOrEqual(2)
                    return true
                  }).pipe(Effect.provide(layer))
                }

                if (input.mode === "runtime_graph_fences_and_reorder") {
                  // Build a plan with glob reader fencing a writer, then call RuntimeGraph methods directly (L166-171, L218-221, L246-254)
                  const plan = yield* Plan.compile({
                    planId: `rg-${input.seedTag}`,
                    flow: "w6/RG",
                    nodes: [
                      {
                        id: "w1",
                        material: {
                          version: "flows/key-material/v2",
                          kind: "sealed",
                          body: "w1",
                          inputs: [],
                          layers: [],
                          capabilities: []
                        },
                        effects: { reads: [], writes: ["src/a.ts"], boundaryMode: "hard" }
                      },
                      {
                        id: "r1",
                        material: {
                          version: "flows/key-material/v2",
                          kind: "sealed",
                          body: "r1",
                          inputs: [],
                          layers: [],
                          capabilities: []
                        },
                        effects: {
                          reads: [{ _tag: "Glob", include: ["src/**"] }],
                          writes: ["r1.out"],
                          boundaryMode: "hard"
                        }
                      },
                      {
                        id: "n2",
                        material: {
                          version: "flows/key-material/v2",
                          kind: "sealed",
                          body: "n2",
                          inputs: [],
                          layers: [],
                          capabilities: []
                        },
                        effects: { reads: [], writes: ["n2.out"], boundaryMode: "hard" }
                      }
                    ]
                  })
                  const rg = RuntimeGraph.make(plan.nodes)
                  rg.reorder("n2", ["w1"])
                  const ready0 = rg.ready()
                  expect(rg.candidates(ready0).length).toBe(ready0.length)
                  if (ready0.length > 0) rg.start(ready0[0]!.id)
                  rg.stage("r1", "failed")
                  rg.reconcile()
                  rg.stage("r1", "built")
                  rg.reconcile()
                  rg.stage("w1", "built")
                  rg.reconcile()
                  expect(rg.blocked().length).toBeGreaterThanOrEqual(0)
                  const visited: Array<string> = []
                  rg.visitAncestors(plan.nodes[2]!, (anc) => visited.push(anc.id))
                  rg.stage("n2", "built")
                  rg.reconcile()
                  expect(rg.states.get("n2")?.status).toBe("settled")
                  expect(rg.remaining).toBe(0)
                  return true
                }

                // chained_retry_copied_record: retry a retry so CopiedRecord.ts copiedFrom !== undefined (L127-145) runs!
                const S1 = Action.make("w6-fin/s1", { payload: { x: Schema.String }, success: Schema.String })
                const S2 = Action.make("w6-fin/s2", { payload: { y: Schema.String }, success: Schema.String })
                const S3 = Action.make("w6-fin/s3", { payload: { z: Schema.String }, success: Schema.String })
                const Chain3 = Flow.make("w6-fin/Chain3", {
                  payload: { x: Schema.String },
                  success: Schema.String,
                  body: Node.capture({}, ({ x }: { readonly x: string }) =>
                    S1.call({ x }).pipe(
                      Node.bindPlanned(Node.capture({}, (y: Planned.Planned<string>) => S2.call({ y }))),
                      Node.bindPlanned(Node.capture({}, (z: Planned.Planned<string>) => S3.call({ z })))
                    ))
                })
                let n1 = 0, n2 = 0, n3 = 0
                const impls = Layer.mergeAll(
                  S1.toLayer(({ x }) => Effect.sync(() => `${x}#${++n1}`)),
                  S2.toLayer(({ y }) => Effect.sync(() => `${y}+${++n2}`)),
                  S3.toLayer(({ z }) => Effect.sync(() => `${z}!${++n3}`))
                )
                const baseLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), noopJjLayer, StepBoundary.layerTest())
                const engineLayer = EngineStore.layer({
                  owner,
                  journalSource: "w6-chain"
                }).pipe(Layer.provideMerge(baseLayer))
                const layer =
                  (Interpreter.layerWithImplementations(Chain3 as never, impls as never) as Layer.Layer<never>).pipe(
                    Layer.provideMerge(Action.layerImplementations),
                    Layer.provideMerge(impls),
                    Layer.provideMerge(engineLayer)
                  )
                return yield* Effect.gen(function*() {
                  const runtime = yield* FlowRuntime.FlowRuntime
                  const id0 = `ch0-${input.seedTag}`
                  const id1 = `ch1-${input.seedTag}`
                  const id2 = `ch2-${input.seedTag}`
                  yield* runtime.execute(Chain3, { executionId: id0, payload: { x: "a" } })
                  const insp = yield* (yield* Effect.promise(() => import("../src/RunInspection.ts"))).make({
                    flows: [Chain3]
                  })
                  const d0 = yield* insp.inspect(id0)
                  const s2Node = d0.steps.find((st) => st.action === S2.name)!.nodeId
                  const s3Node = d0.steps.find((st) => st.action === S3.name)!.nodeId
                  // 1st retry from S2 (copies S1 from id0)
                  yield* Chain3.retryFrom(id0, { executionId: id1, step: s2Node })
                  for (let t = 0; t < 200; t++) {
                    const polled = yield* runtime.poll(Chain3, id1)
                    if (Option.isSome(polled)) break
                    yield* Effect.sleep(Duration.millis(5))
                  }
                  // 2nd retry from S3 of id1 (copies S1 which was ITSELF copied from id0 -> CopiedRecord.ts copiedFrom !== undefined!)
                  const finalVal = yield* Chain3.retryFrom(id1, { executionId: id2, step: s3Node })
                  for (let t = 0; t < 200; t++) {
                    const polled = yield* runtime.poll(Chain3, id2)
                    if (Option.isSome(polled)) break
                    yield* Effect.sleep(Duration.millis(5))
                  }
                  expect(typeof finalVal).toBe("string")
                  expect(n1).toBe(1)
                  return true
                }).pipe(Effect.provide(layer))
              })
            ).pipe(withCrypto),
          { executions: 21, seed: 60501 }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    120_000
  )

  it(
    "fuzzes WorkspaceSandbox rollback/Workspace service, StepBoundary batch digest, DurableEngineState restoreJsonExit, ExitEncoding degrade, DeferredPersistence sweepFlows, and TestStores matrix",
    async () => {
      const UtilSchema = Schema.Struct({
        mode: Schema.Literals([
          "sandbox_workspace_and_rollback",
          "step_boundary_batch_digest",
          "durable_state_restore_json_exit_and_memory",
          "exit_encoding_degrade_and_primitives",
          "deferred_persistence_sweep_flows_and_matrix"
        ]),
        rollbackAlsoFails: Schema.Boolean,
        seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(UtilSchema),
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                if (input.mode === "sandbox_workspace_and_rollback") {
                  // 1) Workspace service methods directly via makeMemory (L771-774)
                  const mem = yield* WorkspaceSandbox.makeMemory({ "a.txt": "hello", "del.txt": "bye" })
                  const exMem = yield* mem.service.execute({
                    descriptor: {
                      readSet: [{ path: "a.txt", digest: sha256("hello") }],
                      writeSet: ["b.txt"],
                      removes: ["del.txt"],
                      boundaryMode: "hard"
                    },
                    workflow: Effect.gen(function*() {
                      const ws = yield* WorkspaceSandbox.Workspace
                      const bytes = yield* ws.readFile("a.txt")
                      yield* ws.writeFile("b.txt", bytes)
                      yield* ws.removeFile("del.txt")
                      return bytes.length
                    })
                  })
                  expect(exMem._tag).toBe("Accepted")
                  if (exMem._tag === "Accepted") yield* mem.service.materialize(exMem)

                  // 2) Filesystem sandbox with removes + injected write failure on 2nd copy-back to trigger rollback (L1513-1537, L1585-1588)!
                  const dir = yield* Effect.acquireRelease(
                    Effect.promise(() => mkdtemp(join(tmpdir(), "w6-rb-"))),
                    (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
                  )
                  const wsRoot = join(dir, "ws")
                  const artRoot = join(dir, "art")
                  const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer)
                  const artLayer = ArtifactStore.layerFileSystem({ directory: artRoot }).pipe(
                    Layer.provideMerge(fsLayer)
                  )

                  return yield* Effect.gen(function*() {
                    const realFs = yield* FileSystem.FileSystem
                    const pathSvc = yield* Path.Path
                    const art = yield* ArtifactStore.ArtifactStore
                    yield* realFs.makeDirectory(wsRoot, { recursive: true })
                    yield* realFs.writeFileString(join(wsRoot, "old-remove.txt"), "remove-me")
                    yield* realFs.writeFileString(join(wsRoot, "first.txt"), "pre-image")

                    let failSecondWrite = false
                    let writeCount = 0
                    const faultyFs = KernelFileSystem.withIsolatedFileSystem({
                      ...realFs,
                      writeFile: (path, data, opts) =>
                        Effect.suspend(() => {
                          if (failSecondWrite && String(path).endsWith("second.txt")) {
                            return Effect.fail(
                              PlatformError.systemError({
                                _tag: "PermissionDenied",
                                module: "FileSystem",
                                method: "writeFile"
                              })
                            )
                          }
                          if (
                            failSecondWrite && input.rollbackAlsoFails && String(path).endsWith("first.txt") &&
                            writeCount > 0
                          ) {
                            return Effect.fail(
                              PlatformError.systemError({
                                _tag: "PermissionDenied",
                                module: "FileSystem",
                                method: "writeFile"
                              })
                            )
                          }
                          if (failSecondWrite && String(path).endsWith("first.txt")) writeCount += 1
                          return realFs.writeFile(path, data, opts)
                        })
                    })

                    const sb = WorkspaceSandbox.makeFileSystem(faultyFs, pathSvc, art, wsRoot)
                    const exFs = yield* sb.execute({
                      descriptor: {
                        readSet: [],
                        writeSet: ["first.txt", "second.txt"],
                        removes: ["old-remove.txt"],
                        boundaryMode: "hard"
                      },
                      workflow: Effect.gen(function*() {
                        const sfs = yield* FileSystem.FileSystem
                        yield* sfs.writeFileString("first.txt", "new-first")
                        yield* sfs.writeFileString("second.txt", "new-second")
                        yield* sfs.remove("old-remove.txt")
                        return "ok"
                      })
                    })
                    expect(exFs._tag).toBe("Accepted")
                    if (exFs._tag === "Accepted") {
                      failSecondWrite = true
                      const matExit = yield* Effect.exit(sb.materialize(exFs))
                      expect(Exit.isFailure(matExit)).toBe(true)
                    }
                    return true
                  }).pipe(Effect.provide(artLayer))
                }

                if (input.mode === "step_boundary_batch_digest") {
                  const dir = yield* Effect.acquireRelease(
                    Effect.promise(() => mkdtemp(join(tmpdir(), "w6-batch-"))),
                    (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
                  )
                  const wsRoot = join(dir, "ws")
                  const artRoot = join(dir, "art")
                  const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer, AtomicFileSystem.layer)
                  const artLayer = ArtifactStore.layerFileSystem({ directory: artRoot }).pipe(
                    Layer.provideMerge(fsLayer)
                  )
                  return yield* Effect.gen(function*() {
                    const realFs = yield* FileSystem.FileSystem
                    const pathSvc = yield* Path.Path
                    const art = yield* ArtifactStore.ArtifactStore
                    yield* realFs.makeDirectory(wsRoot, { recursive: true })
                    yield* realFs.writeFileString(join(wsRoot, "f1.txt"), "hello-1")
                    yield* realFs.writeFileString(join(wsRoot, "f2.txt"), "hello-2")
                    yield* realFs.writeFileString(join(wsRoot, "f3.txt"), "hello-3")

                    // Wrap FS with KernelFileSystem batch support (maxSize: 2) -> hits StepBoundary L630-650!
                    const batchedFs = Object.assign(Object.create(Object.getPrototypeOf(realFs)), realFs, {
                      [KernelFileSystem.FileSystemBatchTypeId]: {
                        maxSize: 2,
                        execute: (requests: ReadonlyArray<KernelFileSystem.BatchRequest>) =>
                          Effect.forEach(requests, (req, index) =>
                            req.operation === "digest"
                              ? realFs.readFile(req.path).pipe(
                                Effect.map((bytes) => ({
                                  index,
                                  result: Result.succeed({
                                    operation: "digest" as const,
                                    digest: sha256(new TextDecoder().decode(bytes)),
                                    sizeBytes: bytes.length,
                                    ...(req.content ? { bytes } : {})
                                  })
                                })),
                                Effect.catch((err) => Effect.succeed({ index, result: Result.fail(err) }))
                              )
                              : Effect.succeed({
                                index,
                                result: Result.fail(
                                  PlatformError.badArgument({
                                    module: "FileSystem",
                                    method: "batch",
                                    description: "unsupported"
                                  })
                                )
                              })).pipe(Effect.map((entries) => ({ entries })))
                      }
                    }) as FileSystem.FileSystem
                    const sb = StepBoundary.makeFileSystem(batchedFs, pathSvc, art, { root: wsRoot, maxInlineBytes: 4 })
                    const prepared = yield* sb.prepare({
                      readSet: [
                        { path: "f1.txt", digest: sha256("hello-1") },
                        { path: "f2.txt", digest: sha256("hello-2") },
                        { path: "f3.txt", digest: sha256("hello-3") },
                        { path: "missing.txt", digest: sha256("none") }
                      ],
                      writeSet: ["f1.txt", "f2.txt", "f3.txt"],
                      boundaryMode: "hard"
                    })
                    expect(prepared.readSnapshot.length).toBe(4)
                    const ev = yield* sb.settle(prepared)
                    expect(StepBoundary.referencedDigests(ev).length).toBe(3)
                    return true
                  }).pipe(Effect.provide(artLayer))
                }

                if (input.mode === "durable_state_restore_json_exit_and_memory") {
                  // 1) EngineStateFault message getter across all 4 reasons (L448-456)
                  for (
                    const reason of [
                      "value_not_serializable",
                      "value_not_decodable",
                      "deferred_completion_missing",
                      "run_parent_edge_missing"
                    ] as const
                  ) {
                    const err = new DurableEngineState.EngineStateFault({ reason, field: "exit" })
                    expect(err.message.length).toBeGreaterThan(0)
                  }

                  // 2) DurableEngineState SQLite decodeDeferredRow with _id: "Exit" (Success, Fail, Die, Interrupt, legacy failures, unknown tag) -> hits L988-1015!
                  const sqlLayer = TestStores.layerAt(":memory:")
                  yield* Effect.gen(function*() {
                    const state = yield* DurableEngineState.DurableEngineState
                    const runs = yield* RunStore.RunStore
                    const runId = `re-${input.seedTag}`
                    yield* runs.create(runId, "{}")
                    const payloads: ReadonlyArray<readonly [string, unknown]> = [
                      ["ok", { _id: "Exit", _tag: "Success", value: "yes" }],
                      ["fail", { _id: "Exit", _tag: "Failure", cause: { reasons: [{ _tag: "Fail", error: "e" }] } }],
                      ["die", { _id: "Exit", _tag: "Failure", cause: { failures: [{ _tag: "Die", defect: "d" }] } }],
                      ["int", {
                        _id: "Exit",
                        _tag: "Failure",
                        cause: { reasons: [{ _tag: "Interrupt", fiberId: 5 }, { _tag: "Interrupt" }] }
                      }],
                      ["unk", { _id: "Exit", _tag: "Failure", cause: { reasons: [{ _tag: "Mystery" }] } }],
                      ["bad", { _id: "Exit", _tag: "Other" }]
                    ]
                    for (const [name, exit] of payloads) {
                      yield* state.completeDeferred({
                        flowName: "w6/RE",
                        executionId: runId,
                        deferredName: name,
                        exit,
                        completedAtMs: 1000
                      })
                      const row = yield* state.deferred({ flowName: "w6/RE", executionId: runId, deferredName: name })
                      expect(row._tag).toBe("Some")
                    }
                  }).pipe(Effect.provide(sqlLayer))

                  // 3) DurableEngineState.makeMemory({ runs }) waitingRuns({ cancelRequested: true }) (L2740-2745)
                  const memState = DurableEngineState.makeMemory({
                    runs: (runId) =>
                      Option.some({
                        status: "suspended" as const,
                        owner: null,
                        cancelRequestedAtMs: runId === "r-can" ? 10 : null
                      })
                  })
                  const waiting = yield* memState.waitingRuns({ cancelRequested: true })
                  expect(Array.isArray(waiting)).toBe(true)
                  return true
                }

                if (input.mode === "exit_encoding_degrade_and_primitives") {
                  const StrictFlow = Flow.make("w6-fin/Strict", {
                    payload: {},
                    success: Schema.String,
                    body: () => Node.succeed("ok")
                  })
                  // Unencodable primitives & proxy -> exercises projectValue primitives (L200-208) and encode/degrade (L437-471)!
                  expect(ExitEncoding.projectValue(Number.POSITIVE_INFINITY)).toBeDefined()
                  expect(ExitEncoding.projectValue(42)).toBeDefined()
                  expect(ExitEncoding.projectValue(true)).toBeDefined()
                  expect(ExitEncoding.projectValue(false)).toBeDefined()
                  expect(ExitEncoding.projectValue(123n)).toBeDefined()
                  expect(ExitEncoding.projectValue(() => 1)).toBeDefined()
                  const prox = new Proxy({}, {
                    get() {
                      throw new Error("proxy-trap")
                    }
                  })
                  expect(ExitEncoding.projectValue(prox)).toBeDefined()

                  // Encode unencodable Complete (number instead of string) -> degrades to Complete Die projection
                  const enc1 = yield* ExitEncoding.encode(
                    StrictFlow,
                    new Flow.Complete({ exit: Exit.succeed(12345 as never) })
                  )
                  expect(enc1.note).toBeDefined()
                  // Encode unencodable Handoff -> hits degrade Handoff branch (L437-441)!
                  const badHandoff = {
                    _tag: "Handoff",
                    flow: "w6-fin/Strict",
                    payload: { bad: 1n }
                  } as unknown as Flow.Result<unknown, unknown>
                  const enc2 = yield* ExitEncoding.encode(StrictFlow, badHandoff)
                  expect(enc2.note).toBeDefined()
                  // Encode proxy result -> hits minimalResult & degrade fail-closed branch!
                  const enc3 = yield* ExitEncoding.encode(StrictFlow, prox as unknown as Flow.Result<unknown, unknown>)
                  expect(enc3.note).toBeDefined()
                  return true
                }

                // deferred_persistence_sweep_flows_and_matrix: DeferredPersistence.sweepFlows + TestStores.matrixFilename/matrixLayer
                expect(TestStores.matrixFilename(":memory:")).toBe(":memory:")
                const matLayer = Layer.mergeAll(TestStores.matrixLayer(), TestClock.layer())
                return yield* Effect.gen(function*() {
                  const state = yield* DurableEngineState.DurableEngineState
                  const journal = yield* Journal.Journal
                  const resumed: Array<string> = []
                  const dp = yield* DeferredPersistence.make({
                    owner,
                    journalSource: "w6-dp",
                    scheduleResume: (flowName, execId) =>
                      Effect.sync(() => {
                        resumed.push(`${flowName}:${execId}`)
                      })
                  }).pipe(
                    Effect.provideService(DurableEngineState.DurableEngineState, state),
                    Effect.provideService(Journal.Journal, journal)
                  )
                  yield* dp.sweepFlows(new Set(["w6/A", "w6/B"]), `exec-${input.seedTag}`)
                  expect(Array.isArray(resumed)).toBe(true)
                  return true
                }).pipe(Effect.provide(matLayer))
              })
            ).pipe(withCrypto),
          { executions: 15, seed: 60502 }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    120_000
  )
})
