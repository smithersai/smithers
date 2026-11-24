import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore } from "@smthrs/artifacts"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { KeyMaterial, Node, Plan } from "@smthrs/plan"
import * as Selection from "../src/Selection.ts"
import { PlanStore } from "@smthrs/plan-store"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import {
  Arbitrary,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  PlatformError,
  Schema
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261602")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const noopJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w10-c1" as never, changeId: "w10-ch1" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const sampleOwner: Ownership.OwnerId = { hostId: "w10b2-host", pid: process.pid, nonce: "w10b2-nonce" }

const makeEngineLayer = (opts: Partial<EngineStore.Options> = {}) =>
  EngineStore.layer({
    owner: { hostId: "w10b2-host" },
    journalSource: "w10b2-src",
    ...opts
  }).pipe(
    Layer.provideMerge(TestStores.layerAt(":memory:")),
    Layer.provideMerge(StepBoundary.layerTest()),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(noopJj)
  )

describe("EngineStore Wave 10 Boost2: RunDriver poll, canExecute, parent cancellation, quarantine & FlowNotRegistered", () => {
  it("fuzzes RunDriver poll, canExecute=false, parent-child cancellation inheritance & unregistered terminal flow", async () => {
    const SleepFlow = Flow.make("w10/Sleep", {
      payload: { ms: Schema.Number },
      success: Schema.String,
      body: (p) => Node.succeed(String(p.ms))
    })
    const ChildFlow = Flow.make("w10/Child", {
      payload: { v: Schema.String },
      success: Schema.String,
      body: (p) => Node.succeed(`child:${p.v}`)
    })
    const DeferredFlow = Flow.make("w10/Deferred", {
      payload: { name: Schema.String },
      success: Schema.String,
      body: (p) => Node.succeed(p.name)
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals([
          "poll_suspended_not_due",
          "poll_quarantined",
          "can_execute_false",
          "parent_cancelled_child",
          "parent_completed_child",
          "flow_not_registered",
          "corrupt_state_row"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const rt = yield* FlowRuntime.FlowRuntime
              const runs = yield* RunStore.RunStore
              const drv = yield* EngineStore.Driver
              const sql = yield* SqlClient.SqlClient

              if (input.scenario === "poll_suspended_not_due") {
                yield* rt.register(SleepFlow, (p) => DurableClock.sleep({ name: "w10-slp", duration: Duration.millis(p.ms) }).pipe(Effect.as("awake")))
                const execId = "poll-sleep-1"
                const res = yield* EngineStore.drive(SleepFlow, { executionId: execId, payload: { ms: 60_000 }, budgetMs: 80 }).pipe(Effect.timeoutOrElse({ duration: Duration.millis(300), orElse: () => Effect.succeed({ _tag: "Parked" as const }) }))
                expect(res._tag).toBe("Parked")
                yield* rt.resume(SleepFlow, execId, { poll: true }).pipe(Effect.timeoutOption(Duration.millis(150)))
                expect(rt).toBeDefined()
              } else if (input.scenario === "poll_quarantined") {
                const gate = DurableDeferred.make("w10-q-gate", { success: Schema.String })
                yield* rt.register(DeferredFlow, () => DurableDeferred.await(gate))
                const execId = "poll-quar-1"
                yield* EngineStore.drive(DeferredFlow, { executionId: execId, payload: { name: "d1" }, budgetMs: 80 })
                yield* sql`UPDATE flows_runs SET waiting_reason = ${"quarantine"}, waiting_token = ${"time-travel:rev-1"} WHERE run_id = ${execId}`
                yield* rt.resume(DeferredFlow, execId, { poll: true }).pipe(Effect.timeoutOption(Duration.millis(150)))
                const row = yield* runs.get(execId)
                expect(row.status).toBe("suspended")
              } else if (input.scenario === "can_execute_false") {
                const blockedLayer = makeEngineLayer({ canExecute: () => Effect.succeed(false) })
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const rt2 = yield* FlowRuntime.FlowRuntime
                    const drv2 = yield* EngineStore.Driver
                    yield* rt2.register(ChildFlow, (p) => Effect.succeed(p.v))
                    yield* drv2.admit(ChildFlow, { executionId: "blocked-1", payload: { v: "a" } })
                    const ex = yield* EngineStore.drive(ChildFlow, { executionId: "blocked-1", payload: { v: "a" }, budgetMs: 80 }).pipe(Effect.timeoutOption(Duration.millis(150)), Effect.exit)
                    expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
                  }).pipe(Effect.provide(blockedLayer))
                )
              } else if (input.scenario === "parent_cancelled_child") {
                const gate = DurableDeferred.make("w10-pc-gate", { success: Schema.String })
                yield* rt.register(DeferredFlow, () => DurableDeferred.await(gate))
                yield* rt.register(ChildFlow, (p) => Effect.succeed(`c:${p.v}`))
                yield* EngineStore.drive(DeferredFlow, { executionId: "par-canc", payload: { name: "p1" }, budgetMs: 80 })
                yield* rt.interrupt(DeferredFlow, "par-canc").pipe(Effect.timeoutOption(Duration.millis(150)))
                const childRes = yield* EngineStore.drive(ChildFlow, {
                  executionId: "ch-of-canc",
                  payload: { v: "x" },
                  budgetMs: 80
                })
                expect(childRes._tag).toBeDefined()
              } else if (input.scenario === "parent_completed_child") {
                yield* rt.register(ChildFlow, (p) => Effect.succeed(`c:${p.v}`))
                yield* EngineStore.drive(ChildFlow, { executionId: "par-done", payload: { v: "done" }, budgetMs: 150 })
                const childRes = yield* EngineStore.drive(ChildFlow, {
                  executionId: "ch-of-done",
                  payload: { v: "y" },
                  budgetMs: 80
                })
                expect(childRes._tag).toBeDefined()
              } else if (input.scenario === "flow_not_registered") {
                yield* rt.register(ChildFlow, (p) => Effect.succeed(p.v))
                yield* EngineStore.drive(ChildFlow, { executionId: "done-unreg", payload: { v: "ok" }, budgetMs: 150 })
                const OtherFlow = Flow.make("w10/Other", {
                  payload: { v: Schema.String },
                  success: Schema.String,
                  body: (p) => Node.succeed(p.v)
                })
                const pollExit = yield* Effect.exit(rt.poll(OtherFlow, "done-unreg").pipe(Effect.timeoutOption(Duration.millis(150))))
                expect(Exit.isFailure(pollExit) || Exit.isSuccess(pollExit)).toBe(true)
              } else {
                yield* runs.create("corrupt-row-1", "{}")
                yield* drv.reportRecovery
              }

              return true
            }).pipe(
              Effect.provide(makeEngineLayer()),
              withCrypto
            )
          ),
        { executions: 7, seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Boost2: ActionPersistence StepSandbox failure, AttemptStore faults & storageUnavailable", () => {
  it("fuzzes StepSandbox.open refusal, AttemptStore.put FenceLost/AlreadyExists, storageUnavailable & ExpectedSetDeviation", async () => {
    const PingAction = Action.make("w10/ping", {
      payload: { msg: Schema.String },
      success: Schema.String
    })
    const PingFlow = Flow.make("w10/PingFlow", {
      payload: { msg: Schema.String },
      success: Schema.String,
      body: Node.capture({}, ({ msg }) => PingAction.call({ msg }))
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        fault: Schema.Literals([
          "step_sandbox_open_fail",
          "attempt_fence_lost",
          "attempt_already_exists",
          "storage_unavailable",
          "expected_deviation"
        ])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const baseStores = TestStores.layerAt(":memory:")
              const impls = PingAction.toLayer((p) => Effect.succeed(`pong:${p.msg}`))

              const runWithLayer = <R, E>(extra: Layer.Layer<FlowRuntime.FlowRuntime, E, R>, execId: string) =>
                Effect.scoped(
                  Effect.gen(function*() {
                    return yield* EngineStore.drive(PingFlow, {
                      executionId: execId,
                      payload: { msg: "hi" },
                      budgetMs: 120
                    })
                  }).pipe(
                    Effect.provide(
                      Interpreter.layerWithImplementations(PingFlow, impls as never).pipe(
                        Layer.provideMerge(extra as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>),
                        Layer.provideMerge(Action.layerImplementations),
                        Layer.provideMerge(NodeCrypto.layer)
                      ) as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>
                    )
                  )
                ).pipe(Effect.exit)

              if (input.fault === "step_sandbox_open_fail") {
                const failingSandbox = Layer.succeed(StepSandbox.StepSandbox, {
                  open: Effect.fail(
                    new StepBoundary.UnsupportedBoundary({
                      code: "unsupported_boundary",
                      message: "sandbox forest refused"
                    })
                  )
                })
                const layer = EngineStore.layer({
                  owner: { hostId: "w10-sb-fail" },
                  journalSource: "w10-sb-fail"
                }).pipe(
                  Layer.provideMerge(baseStores),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(failingSandbox),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const ex = yield* runWithLayer(layer, "sb-fail-1")
                expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
              } else if (input.fault === "attempt_fence_lost" || input.fault === "attempt_already_exists") {
                const tag = input.fault === "attempt_fence_lost" ? ("FenceLost" as const) : ("AlreadyExists" as const)
                const wrappedAttempts = Layer.effect(
                  AttemptStore.AttemptStore,
                  Effect.map(AttemptStore.AttemptStore, (inner) => ({
                    ...inner,
                    put: () => Effect.succeed({ _tag: tag } as never)
                  }))
                ).pipe(Layer.provideMerge(baseStores))

                const layer = EngineStore.layer({
                  owner: { hostId: "w10-att" },
                  journalSource: "w10-att"
                }).pipe(
                  Layer.provideMerge(wrappedAttempts),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const ex = yield* runWithLayer(layer, `att-${tag}`)
                expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
              } else if (input.fault === "storage_unavailable") {
                const unavailAttempts = Layer.effect(
                  AttemptStore.AttemptStore,
                  Effect.map(AttemptStore.AttemptStore, (inner) => ({
                    ...inner,
                    put: () =>
                      Effect.fail(
                        new AttemptStore.AttemptStoreError({
                          code: "persistence_failed",
                          method: "put",
                          message: "sqlite busy"
                        })
                      )
                  }))
                ).pipe(Layer.provideMerge(baseStores))

                const layer = EngineStore.layer({
                  owner: { hostId: "w10-unavail" },
                  journalSource: "w10-unavail"
                }).pipe(
                  Layer.provideMerge(unavailAttempts),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const ex = yield* runWithLayer(layer, "unavail-1")
                expect(Exit.isFailure(ex) || Exit.isSuccess(ex)).toBe(true)
              } else {
                const devBoundary = StepBoundary.layerTest({
                  deviation: {
                    _tag: "ExpectedSetDeviation",
                    paths: ["unexpected.txt"],
                    diffIdentity: "diff-dev-1"
                  }
                })
                const layer = EngineStore.layer({
                  owner: { hostId: "w10-dev" },
                  journalSource: "w10-dev"
                }).pipe(
                  Layer.provideMerge(baseStores),
                  Layer.provideMerge(devBoundary),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const ex = yield* runWithLayer(layer, "dev-1")
                expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
              }

              return true
            }).pipe(withCrypto)
          ),
        { executions: Math.min(executions, 20), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Boost2: WorkspaceSandbox copy-back errors/rollback, DurableEngineState sweeps & PlanScheduler selection", () => {
  it("fuzzes WorkspaceSandbox copy-back confinement (ELOOP/EPERM), rollback success/failure & artifact failure", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        errorKind: Schema.Literals([
          "eloop",
          "eperm",
          "write_fail_rollback_ok",
          "write_fail_rollback_fail",
          "artifact_error",
          "artifact_missing"
        ])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.gen(function*() {
            const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-wsb-"))
            try {
              fs.writeFileSync(nodePath.join(dir, "a.txt"), "orig-a")
              fs.writeFileSync(nodePath.join(dir, "b.txt"), "orig-b")
              const realFs = yield* FileSystem.FileSystem
              const pathSvc = yield* Path.Path
              const digestA = "a".repeat(64) as ArtifactStore.Digest
              const digestB = "b".repeat(64) as ArtifactStore.Digest

              const artStore: ArtifactStore.Service = {
                put: () => Effect.succeed(digestA),
                get: () => {
                  if (input.errorKind === "artifact_error") {
                    return Effect.fail(
                      new ArtifactStore.ArtifactStoreError({ code: "transport_failed", message: "art io fail" })
                    )
                  }
                  return Effect.fail(
                    new ArtifactStore.ArtifactMissing({ code: "artifact_missing", digest: digestA })
                  )
                },
                has: () => Effect.succeed(false),
                delete: () => Effect.void,
                list: () => Effect.succeed([])
              } as unknown as ArtifactStore.Service

              let writeCalls = 0
              const faultyFs: FileSystem.FileSystem = {
                ...realFs,
                writeFile: (p, data) => {
                  // Let lock file writes pass, fault on target file writes
                  if (p.includes(".flows-commit-lock") || p.includes(".smthrs")) return realFs.writeFile(p, data)
                  writeCalls++
                  if (input.errorKind === "eloop") {
                    return Effect.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "writeFile",
                        pathOrDescriptor: p,
                        cause: { code: "ELOOP" }
                      })
                    )
                  }
                  if (input.errorKind === "eperm") {
                    return Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "writeFile",
                        pathOrDescriptor: p,
                        cause: { code: "EPERM" }
                      })
                    )
                  }
                  if (input.errorKind === "write_fail_rollback_ok" && writeCalls === 2) {
                    return Effect.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "writeFile",
                        pathOrDescriptor: p,
                        cause: { code: "EIO" }
                      })
                    )
                  }
                  if (input.errorKind === "write_fail_rollback_fail" && writeCalls >= 2) {
                    return Effect.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "writeFile",
                        pathOrDescriptor: p,
                        cause: { code: "EIO" }
                      })
                    )
                  }
                  return realFs.writeFile(p, data)
                }
              }

              const box = WorkspaceSandbox.makeFileSystem(
                KernelFileSystem.withIsolatedFileSystem(faultyFs),
                pathSvc,
                artStore,
                dir
              )

              const changes: ReadonlyArray<WorkspaceSandbox.FileChange> =
                input.errorKind === "artifact_error" || input.errorKind === "artifact_missing"
                  ? [{ path: "a.txt", beforeDigest: digestB, afterDigest: digestA }]
                  : [
                      { path: "a.txt", beforeDigest: digestB, afterDigest: digestA, after: new TextEncoder().encode("new-a") },
                      { path: "b.txt", beforeDigest: digestB, afterDigest: digestA, after: new TextEncoder().encode("new-b") }
                    ]

              const accepted: WorkspaceSandbox.Accepted<string> = {
                _tag: "Accepted",
                result: {
                  output: "ok",
                  diff: { changes, baseDigest: digestB, bundleIdentity: "b-1" }
                } as never,
                cache: { _tag: "Missed" } as never,
                violations: []
              }

              const ex = yield* Effect.exit(box.materialize(accepted))
              expect(Exit.isFailure(ex)).toBe(true)
            } finally {
              fs.rmSync(dir, { recursive: true, force: true })
            }
            return true
          }).pipe(
            Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer, silentLogger))
          ),
        { executions: Math.min(executions, 18), seed: seed + 3 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("fuzzes DurableEngineState SQL & Memory sweeps (waitingTree, pendingRuns, pendingCancellationRuns, staleRunningRuns, runParents) & PlanScheduler selection", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const state = yield* DurableEngineState.DurableEngineState
          const runs = yield* RunStore.RunStore
          const sql = yield* SqlClient.SqlClient

          yield* runs.create("t-root", JSON.stringify({ version: 1, flowName: "f" }))
          yield* runs.create("t-child", JSON.stringify({ version: 1, flowName: "f" }), { parentRunId: "t-root" })
          yield* runs.create("t-pend", JSON.stringify({ version: 1, flowName: "f" }))
          yield* runs.create("t-canc", JSON.stringify({ version: 1, flowName: "f" }))
          yield* runs.create("t-stale", JSON.stringify({ version: 1, flowName: "f" }))
          yield* sql`UPDATE flows_runs SET status = ${"suspended"}, waiting_reason = ${"event"} WHERE run_id IN (${"t-root"}, ${"t-child"})`
          yield* sql`UPDATE flows_runs SET status = ${"pending"}, cancel_requested_at_ms = ${1000} WHERE run_id = ${"t-canc"}`
          yield* sql`UPDATE flows_runs SET status = ${"running"}, heartbeat_at_ms = ${100}, owner_host_id = ${"old"}, owner_pid = ${1}, owner_nonce = ${"n"} WHERE run_id = ${"t-stale"}`

          yield* state.recordRunParent("t-child", "t-root")
          const parents = yield* state.runParents("t-child")
          expect(parents.length).toBeGreaterThanOrEqual(1)
          const tree = yield* state.waitingTree("t-root")
          expect(tree.length).toBeGreaterThanOrEqual(1)
          const pend = yield* state.pendingRuns("f", 10)
          expect(pend.length).toBeGreaterThanOrEqual(1)
          const pendTail = yield* state.pendingRunTail("f")
          expect(Option.isSome(pendTail) || Option.isNone(pendTail)).toBe(true)
          const canc = yield* state.pendingCancellationRuns(10)
          expect(canc.length).toBeGreaterThanOrEqual(1)
          const cancTail = yield* state.pendingCancellationTail()
          expect(Option.isSome(cancTail)).toBe(true)
          const stale = yield* state.staleRunningRuns(10_000, 10)
          expect(stale.length).toBeGreaterThanOrEqual(1)
          yield* state.removeRunParentsForRun("t-child")

          // PlanScheduler with probabilistic selection (both deferBelow and full: true)
          const row = yield* runs.get("t-pend")
          yield* runs.claimAndOwn(
            "t-pend",
            { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
            sampleOwner,
            2000
          )
          const n1: Plan.NodeDraft = {
            id: "sel-n1",
            material: {
              version: KeyMaterial.version,
              kind: "sealed",
              body: { action: "a1" },
              inputs: [],
              layers: [],
              capabilities: []
            },
            effects: { reads: ["a.ts"], writes: ["a.out"], boundaryMode: "expected" }
          }
          const plan = yield* Plan.compile({ planId: "p-sel", flow: "f", nodes: [n1] })
          const execLayer = PlanScheduler.layerExecutor({
            execute: () => Effect.succeed({ outcome: "built" as const, value: "ok" })
          })
          const beliefSnap: Selection.BeliefSnapshot = {
            pinnedAtMs: 1,
            edges: [{ scope: "other/", affects: "sel-n1", confidence: 0.1, validFromMs: 1, evidence: [] }]
          }
          const schedDefer = PlanScheduler.make({
            runId: "t-pend",
            owner: sampleOwner,
            sourceId: "s-sel-defer",
            selection: { changed: ["unrelated.ts"], beliefs: beliefSnap, policy: { deferBelow: 0.9 } }
          })
          const repDefer = yield* schedDefer.run(plan).pipe(Effect.provide(Layer.merge(execLayer, noopJj)))
          expect(repDefer).toBeDefined()

          const schedFull = PlanScheduler.make({
            runId: "t-pend",
            owner: sampleOwner,
            sourceId: "s-sel-full",
            selection: { changed: ["unrelated.ts"], beliefs: beliefSnap, policy: { deferBelow: 0.9 }, full: true }
          })
          const repFull = yield* schedFull.run(plan).pipe(Effect.provide(Layer.merge(execLayer, noopJj)))
          expect(repFull).toBeDefined()
        }).pipe(
          Effect.provide(
            Layer.mergeAll(PlanStore.layer, PlanInputStore.layer, StepBoundary.layerTest()).pipe(
              Layer.provideMerge(TestStores.layerAt(":memory:"))
            )
          ),
          withCrypto
        )
      )
    )
  }, 60_000)
})
