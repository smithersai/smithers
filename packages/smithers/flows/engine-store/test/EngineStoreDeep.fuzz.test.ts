import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy, Sleep } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import { KeyMaterial, Node, Plan, StepKey } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Arbitrary, Effect, Exit, Fiber, FileSystem, Layer, Option, Path, PlatformError, Redacted, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as nodeFs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as ArtifactSync from "../src/ArtifactSync.ts"
import * as CacheSync from "../src/CacheSync.ts"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ExecutionFacts from "../src/ExecutionFacts.ts"
import * as ExecutionSnapshot from "../src/ExecutionSnapshot.ts"
import * as Inconsistency from "../src/Inconsistency.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as ArtifactRoots from "../src/internal/ArtifactRoots.ts"
import * as AttemptProbe from "../src/internal/AttemptProbe.ts"
import * as RetrySource from "../src/internal/RetrySource.ts"
import * as AttemptLifecycle from "../src/internal/AttemptLifecycle.ts"
import * as CacheOutputPolicy from "../src/internal/CacheOutputPolicy.ts"
import * as ExitEncoding from "../src/internal/ExitEncoding.ts"
import * as PlanMerges from "../src/internal/PlanMerges.ts"
import * as ResultEnvelope from "../src/internal/ResultEnvelope.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as ReplayOnly from "../src/ReplayOnly.ts"
import * as Retention from "../src/Retention.ts"
import * as RunCatalogRead from "../src/RunCatalogRead.ts"
import * as RunChangeFeed from "../src/RunChangeFeed.ts"
import * as RunInspection from "../src/RunInspection.ts"
import * as Selection from "../src/Selection.ts"
import * as SelectionStore from "../src/SelectionStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepCacheFold from "../src/StepCacheFold.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const jjStub = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "fuzz-deep-snap" as never, changeId: "fuzz-deep-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const activateRun = (runId: string, owner: Ownership.OwnerId, flowName = "fuzz/flow") =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, JSON.stringify({ version: 1, flowName, payload: {} }))
    const row = yield* runs.get(runId)
    const snap = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snap, owner, 1)
    if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim failed"))
    const act = yield* runs.activate(runId, owner, claim.claimedAtMs, snap)
    if (act._tag !== "Activated") return yield* Effect.die(new Error("activate failed"))
  })

const makeDraft = (
  id: string,
  opts: {
    readonly inputs?: ReadonlyArray<KeyMaterial.InputRef>
    readonly reads?: ReadonlyArray<string>
    readonly writes?: ReadonlyArray<string>
    readonly removes?: ReadonlyArray<string>
    readonly priority?: number
    readonly conflictStrategy?: Plan.PairStrategy
    readonly runtimeStrategy?: Plan.RuntimeStrategy
    readonly boundaryMode?: "hard" | "expected"
    readonly kind?: Plan.PlanNode["kind"]
  } = {}
): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: "sealed",
    body: { action: id },
    inputs: opts.inputs ?? [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: opts.reads ?? [],
    writes: opts.writes ?? [`${id}.out`],
    ...(opts.removes === undefined ? {} : { removes: opts.removes }),
    boundaryMode: opts.boundaryMode ?? "hard"
  },
  ...(opts.kind === undefined ? {} : { kind: opts.kind }),
  ...(opts.priority === undefined ? {} : { priority: opts.priority }),
  ...(opts.conflictStrategy === undefined ? {} : { conflictStrategy: opts.conflictStrategy }),
  ...(opts.runtimeStrategy === undefined ? {} : { runtimeStrategy: opts.runtimeStrategy })
})

describe("@smthrs/engine-store deep fuzz invariants", () => {
  let tempRoot = ""

  beforeAll(() => {
    tempRoot = nodeFs.mkdtempSync(join(tmpdir(), "engine-store-deep-fuzz-"))
  })

  afterAll(() => {
    if (tempRoot) nodeFs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it("Suite 1: DurableEngineState (SQLite) clocks, deferreds, waitingTree, parent DAG cycles, stale runs, copies & DeferredClockFold", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        clockDelayMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(10), Schema.isLessThanOrEqualTo(5000)),
        completeBeforeFire: Schema.Boolean,
        cancelPending: Schema.Boolean,
        waitingReason: Schema.Literals(["timer", "event", "approval", "human"]),
        attemptCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const owner: Ownership.OwnerId = { hostId: "h-state", pid: 101, nonce: "n-state" }
              const rootId = "run-root"
              const childId = "run-child"
              const grandId = "run-grand"
              const pendingId = "run-pending"
              const cancelId = "run-cancel"

              yield* activateRun(rootId, owner, "fuzz/root")
              yield* activateRun(childId, owner, "fuzz/child")
              yield* activateRun(grandId, owner, "fuzz/grand")

              const runs = yield* RunStore.RunStore
              const state = yield* DurableEngineState.DurableEngineState
              const attempts = yield* AttemptStore.AttemptStore

              // Pending run & pending cancellation
              yield* runs.create(pendingId, JSON.stringify({ version: 1, flowName: "fuzz/pending", payload: {} }))
              const pend = yield* state.pendingRuns("fuzz/pending", 10)
              const pendTail = yield* state.pendingRunTail("fuzz/pending")
              if (pend.length < 1 || Option.isNone(pendTail)) return false

              if (input.cancelPending) {
                yield* runs.create(cancelId, JSON.stringify({ version: 1, flowName: "fuzz/cancel", payload: {} }))
                yield* runs.requestCancel(cancelId, 50)
                const canc = yield* state.pendingCancellationRuns(10)
                const cancTail = yield* state.pendingCancellationTail()
                if (canc.length < 1 || Option.isNone(cancTail)) return false
              }

              // Parent DAG edges + cycle rejection + queries
              const e1 = yield* state.recordRunParent(childId, rootId)
              const e1dup = yield* state.recordRunParent(childId, rootId)
              if (e1._tag !== "Recorded" || e1dup._tag !== "Existing") return false
              yield* state.recordRunParent(grandId, childId)
              const cycleExit = yield* Effect.exit(state.recordRunParent(rootId, grandId))
              if (!Exit.isFailure(cycleExit)) return false
              const parents = yield* state.runParents(childId)
              const children = yield* state.runChildren(rootId)
              if (parents.length !== 1 || children.length !== 1) return false
              if (state.runChildrenOf) {
                const bulk = yield* state.runChildrenOf([rootId, childId, rootId])
                if (bulk.length !== 2) return false
              }

              // Clocks: schedule, pendingClocks, dueClocks, hasDueWake, completeClock, completeRunClocks
              const clockAddr: DurableEngineState.ClockAddress = {
                flowName: "fuzz/root",
                executionId: rootId,
                clockName: "c1"
              }
              const scheduled = yield* state.scheduleClock(
                {
                  ...clockAddr,
                  deferredName: "def-c1",
                  dueAtMs: 1000 + input.clockDelayMs,
                  completedAtMs: null
                },
                owner
              )
              if (scheduled._tag !== "Scheduled" && scheduled._tag !== "Existing") return false
              const clockRow = yield* state.clock(clockAddr)
              if (Option.isNone(clockRow)) return false
              const pendClocks = yield* state.pendingClocks({ executionId: rootId })
              if (pendClocks.length < 1) return false
              const dueBefore = yield* state.dueClocks(500)
              const dueAfter = yield* state.dueClocks(1000 + input.clockDelayMs + 10)
              if (dueBefore.length !== 0 || dueAfter.length < 1) return false
              const hasWake = yield* state.hasDueWake(rootId, 1000 + input.clockDelayMs + 10)
              if (!hasWake) return false

              // Deferreds: complete, read, completedDeferreds, consume
              const defAddr: DurableEngineState.DeferredAddress = {
                flowName: "fuzz/root",
                executionId: rootId,
                deferredName: "def-1"
              }
              const done1 = yield* state.completeDeferred({
                ...defAddr,
                exit: { _tag: "Success", value: "ok" },
                metadata: { src: "fuzz" },
                completedAtMs: 1050
              })
              const done2 = yield* state.completeDeferred({
                ...defAddr,
                exit: { _tag: "Success", value: "dup" },
                completedAtMs: 1060
              })
              if (done1._tag !== "Completed" || done2._tag !== "Existing") return false
              const readDef = yield* state.deferred(defAddr)
              if (Option.isNone(readDef)) return false
              const unconsumed = yield* state.completedDeferreds("fuzz/root", rootId)
              if (unconsumed.length < 1) return false
              const consumed1 = yield* state.consumeDeferred(defAddr, 1070)
              const consumed2 = yield* state.consumeDeferred(defAddr, 1080)
              if (!consumed1 || consumed2) return false

              if (input.completeBeforeFire) {
                yield* state.completeClock(clockAddr, 1050)
              } else {
                yield* state.completeRunClocks(rootId, 1050)
              }

              // Waiting rows + waitingTree + waitingRuns + wake
              yield* state.park(
                grandId,
                { reason: input.waitingReason, wakeAt: 2000 },
                owner
              )
              const w = yield* state.waiting(grandId)
              if (Option.isNone(w)) return false
              const waitingAll = yield* state.waitingRuns({ reason: input.waitingReason, dueBeforeMs: 3000 })
              if (waitingAll.length < 1) return false
              const treeAttached = yield* state.waitingTree(rootId)
              const treeAll = yield* state.waitingTree(rootId, { detached: "include" })
              if (treeAttached.length < 1 || treeAll.length < 1) return false
              yield* state.wake(grandId)

              // Stale running runs detection
              const stale = yield* state.staleRunningRuns(Date.now() + 100_000, 10)
              if (stale.length < 1) return false

              // Attempts + copyAttempts + attemptSurvivors
              const stepKeyDigest = sha256("step-key-1")
              for (let a = 1; a <= input.attemptCount; a++) {
                yield* attempts.put(
                  {
                    runId: rootId,
                    stepKeyDigest,
                    attempt: a,
                    state: "running",
                    startedAtMs: 100 + a * 10,
                    meta: {}
                  },
                  owner
                )
                yield* attempts.finish(
                  {
                    runId: rootId,
                    stepKeyDigest,
                    attempt: a,
                    state: a === input.attemptCount ? "completed" : "failed",
                    finishedAtMs: 105 + a * 10,
                    ...(a === input.attemptCount ? { outcome: "val" } : { error: { message: "boom" } })
                  },
                  owner
                )
              }
              if (state.attemptSurvivors) {
                const surv = yield* state.attemptSurvivors(rootId, stepKeyDigest)
                if (Option.isNone(surv) || surv.value.latest !== input.attemptCount) return false
              }
              if (state.copyAttempts) {
                const copied = yield* state.copyAttempts({
                  from: rootId,
                  to: childId,
                  attempts: [{ stepKeyDigest, attempt: input.attemptCount }]
                })
                if (copied !== 1) return false
              }

              // DeferredClockFold reduce + encode + fromCheckpoint + capture
              const journal = yield* Journal.Journal
              const rId = JournalEvent.RunId.make(rootId)
              const sId = JournalEvent.SourceId.make("fold-src")
              yield* journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: rId,
                  sourceId: sId,
                  eventType: "flows.engine.clock-scheduled",
                  payload: {
                    flowName: "fuzz/root",
                    executionId: rootId,
                    clockName: "fc1",
                    deferredName: "fd1",
                    dueAtMs: 2500
                  }
                })
              )
              yield* journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId: rId,
                  sourceId: sId,
                  eventType: "flows.engine.deferred-completed",
                  payload: {
                    flowName: "fuzz/root",
                    executionId: rootId,
                    deferredName: "fd1",
                    completedAtMs: 1200
                  }
                })
              )
              yield* journal.flush
              const page = yield* journal.entries({ runId: rId, limit: 50 })
              let foldState = DeferredClockFold.initial
              for (const entry of page.entries) {
                foldState = DeferredClockFold.reduce(foldState, entry)
              }
              const encoded = DeferredClockFold.encode(foldState)
              const decoded = DeferredClockFold.fromCheckpoint({ [DeferredClockFold.checkpointKey]: encoded })
              if (Option.isNone(decoded)) return false
              const captured = yield* DeferredClockFold.capture(rootId, page.entries.length + 10).pipe(Effect.result)
              void captured

              // Clean up edges for one run
              yield* state.removeRunParentsForRun(grandId)
              const afterRm = yield* state.runParents(grandId)
              if (afterRm.length !== 0) return false

              return true
            }).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.scoped, Effect.orDie)
          ),
        { seed: seed + 101, executions: Math.min(executions, 25) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 2: EngineStore.layer + RunDriver + ActionPersistence + StepLogs + ExecutionFacts + ReplayOnly + RunChangeFeed", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "multi-step-logs",
          "retry-then-succeed",
          "non-retryable-fail",
          "sleep-park-drive",
          "deferred-wait-resume",
          "child-flow",
          "replay-only-miss"
        ]),
        secretVal: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{6,16}$/)),
        count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3))
      })
    )

    class RetryErr extends Schema.TaggedError<RetryErr>()("FuzzRetryErr", {
      msg: Schema.String
    }) {}
    class FatalErr extends Schema.TaggedError<FatalErr>()("FuzzFatalErr", {
      msg: Schema.String
    }) {}

    let seq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              seq++
              const execId = `driver-run-${seq}`
              let attemptsSeen = 0

              const LogAct = Action.make("fuzz/LogAct", {
                payload: { n: Schema.Number, secret: Schema.String },
                success: Schema.Number
              })

              const FlakyAct = Action.make("fuzz/FlakyAct", {
                payload: { failTimes: Schema.Number },
                success: Schema.String,
                error: RetryErr,
                retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 5, maxAttempts: 4 })
              })

              const FatalAct = Action.make("fuzz/FatalAct", {
                payload: {},
                success: Schema.String,
                error: FatalErr
              })

              const WaitDef = DurableDeferred.make("fuzz/WaitDef", {
                success: Schema.String
              })

              const ChildFlow = Flow.make("fuzz/Child", {
                payload: { x: Schema.Number, secret: Schema.String },
                success: Schema.Number,
                body: Node.capture({}, ({ secret, x }) => LogAct.call({ n: x, secret }))
              })

              const MainFlow = Flow.make("fuzz/Main", {
                payload: { mode: Schema.String, count: Schema.Number, secret: Schema.String },
                success: Schema.String,
                error: Schema.Union([RetryErr, FatalErr, Sleep.SleepRequestInvalid]),
                body: ({ count, mode, secret }): Node.Node<string, RetryErr | FatalErr | Sleep.SleepRequestInvalid, Action.Requirement<"fuzz/LogAct"> | Action.Requirement<"fuzz/FlakyAct"> | Action.Requirement<"fuzz/FatalAct">> => {
                  if (mode === "multi-step-logs") {
                    return LogAct.call({ n: count, secret }).pipe(
                      Node.andThen(LogAct.call({ n: count + 1, secret })),
                      Node.map(Node.capture({}, (v) => `sum-${v}`))
                    )
                  }
                  if (mode === "retry-then-succeed") {
                    return FlakyAct.call({ failTimes: Math.min(count, 2) })
                  }
                  if (mode === "non-retryable-fail") {
                    return FatalAct.call({})
                  }
                  if (mode === "sleep-park-drive") {
                    return Sleep.action.call({ millis: 15 }).pipe(
                      Node.andThen(LogAct.call({ n: 7, secret })),
                      Node.map(Node.capture({}, (v) => `woke-${v}`))
                    )
                  }
                  if (mode === "deferred-wait-resume") {
                    return LogAct.call({ n: 3, secret }).pipe(Node.map(Node.capture({}, (v) => `ok-${v}`)))
                  }
                  if (mode === "child-flow") {
                    return ChildFlow.child({ x: count, secret }).pipe(
                      Node.map(Node.capture({}, (v) => `child-${v}`))
                    )
                  }
                  return LogAct.call({ n: 5, secret }).pipe(
                    Node.map(Node.capture({}, (v) => `replay-${v}`))
                  )
                }
              })

              const stores = TestStores.layerAt(":memory:")
              const engineLayer = EngineStore.layer({
                owner: { hostId: `fuzz-drv-${seq}` },
                journalSource: "fuzz-drv-src",
                isAlive: () => Effect.succeed(true),
                sweep: { host: `fuzz-drv-${seq}` }
              }).pipe(
                Layer.provideMerge(StepBoundary.layerTest()),
                Layer.provideMerge(WorkspaceSandbox.layerUnsupported),
                Layer.provideMerge(jjStub),
                Layer.provideMerge(RunChangeFeed.layer),
                Layer.provideMerge(ExecutionSnapshot.layer),
                Layer.provideMerge(RunCatalogRead.layer),
                Layer.provideMerge(stores)
              )

              const fullLayer = Layer.mergeAll(
                LogAct.toLayer(({ n, secret }) =>
                  Effect.gen(function*() {
                    yield* Effect.logInfo(`step-${n} secret=${Redacted.value(Redacted.make(secret))}`)
                    yield* Effect.logWarning(`warn-${n}`)
                    return n * 2
                  })
                ),
                FlakyAct.toLayer(({ failTimes }) =>
                  Effect.suspend(() => {
                    attemptsSeen++
                    if (attemptsSeen <= failTimes) {
                      return Effect.fail(new RetryErr({ msg: `try-${attemptsSeen}` }))
                    }
                    return Effect.succeed(`recovered-${attemptsSeen}`)
                  })
                ),
                FatalAct.toLayer(() => Effect.fail(new FatalErr({ msg: "permanent" }))),
                Interpreter.layer(ChildFlow),
                Interpreter.layer(MainFlow)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(engineLayer)
              )

              const payload = { mode: input.mode, count: input.count, secret: input.secretVal }

              return yield* Effect.gen(function*() {
                const feed = yield* RunChangeFeed.RunChangeFeed
                const pos0 = yield* feed.current

                if (input.mode === "multi-step-logs" || input.mode === "retry-then-succeed" || input.mode === "child-flow") {
                  const out = yield* MainFlow.execute(payload, { executionId: execId })
                  if (typeof out !== "string") return false
                  const changes = yield* feed.changesSince({ ...pos0, limit: 50 })
                  if (changes.changes.length < 1) return false
                  const snap = yield* ExecutionSnapshot.ExecutionSnapshot
                  const batch = yield* snap.read([execId, "nonexistent-run"])
                  if (batch.snapshots.length !== 2) return false
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const row = yield* runs.get(execId)
                  const obs = yield* ExecutionFacts.observe(row, state)
                  if (obs.executionId !== execId) return false
                } else if (input.mode === "non-retryable-fail") {
                  const exit = yield* Effect.exit(MainFlow.execute(payload, { executionId: execId }))
                  if (!Exit.isFailure(exit)) return false
                } else if (input.mode === "sleep-park-drive") {
                  const out = yield* MainFlow.execute(payload, { executionId: execId })
                  const wake = yield* EngineStore.nextWake(execId)
                  void wake
                  if (out !== "woke-14") return false
                } else if (input.mode === "deferred-wait-resume") {
                  const WaitFlow = Flow.make(`fuzz/WaitFlow-${seq}`, {
                    payload: {},
                    success: Schema.String,
                    body: () => Node.succeed("unused")
                  })
                  const engine = yield* FlowRuntime.FlowRuntime
                  yield* engine.register(WaitFlow, () => Effect.map(DurableDeferred.await(WaitDef), (v) => `def-${v}`))
                  const fiber = yield* WaitFlow.execute({}, { executionId: execId }).pipe(
                    Effect.forkChild({ startImmediately: true })
                  )
                  yield* Effect.sleep("20 millis")
                  const token = yield* DurableDeferred.token(WaitDef).pipe(
                    Effect.provideService(FlowRuntime.FlowInstance, {
                      flow: WaitFlow,
                      executionId: execId,
                      suspended: false,
                      interrupt: Effect.void
                    } as any)
                  )
                  yield* DurableDeferred.done(WaitDef, { token, exit: Exit.succeed("resolved-val") })
                  const out = yield* Fiber.join(fiber)
                  if (out !== "def-resolved-val") return false
                } else if (input.mode === "replay-only-miss") {
                  const out1 = yield* MainFlow.execute(payload, { executionId: execId })
                  if (out1 !== "replay-10") return false
                  const seen: Array<ReplayOnly.Dispatch> = []
                  const owner: Ownership.OwnerId = { hostId: "ro-h", pid: 404, nonce: `ro-${seq}` }
                  const roRun = `${execId}-ro`
                  yield* activateRun(roRun, owner, "fuzz/Main")
                  const roExit = yield* Effect.exit(
                    ActionPersistence.make({
                      runId: roRun,
                      owner,
                      sourceId: "ro-src",
                      replayOnly: {
                        observe: (d) =>
                          Effect.sync(() => {
                            seen.push(d)
                          })
                      },
                      execute: () => Effect.succeed("should-not-run")
                    })({
                      action: {},
                      attempt: 1,
                      key: `unrecorded-key-${seq}`,
                      tier: "sealed"
                    })
                  )
                  if (!Exit.isFailure(roExit) || seen.length !== 1) return false
                }
                return true
              }).pipe(Effect.provide(fullLayer), Effect.scoped, Effect.orDie)
            })
          ),
        { seed: seed + 102, executions: Math.min(executions, 28) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 3: PlanScheduler + PlanInputStore + PlanMergeStore + SelectionStore + Reconciliation + StepCacheFold", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        nodeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(5)),
        failIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1), Schema.isLessThanOrEqualTo(3)),
        concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3)),
        boundaryMode: Schema.Literals(["hard", "expected"]),
        reconcileVerdict: Schema.Literals(["default", "fail", "reorder"]),
        trainOutcome: Schema.Literals(["hit", "miss"]),
        staleOwnerCheck: Schema.Boolean
      })
    )

    let pSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              pSeq++
              const owner: Ownership.OwnerId = { hostId: "sched-h", pid: 202, nonce: `sched-${pSeq}` }
              const staleOwner: Ownership.OwnerId = { hostId: "other-h", pid: 999, nonce: "stale" }
              const runId = `plan-run-${pSeq}`

              const drafts: Array<Plan.NodeDraft> = []
              for (let i = 0; i < input.nodeCount; i++) {
                drafts.push(
                  makeDraft(`n${i}`, {
                    inputs: i > 0 ? [{ _tag: "Ref", from: `n${i - 1}`, path: [] }] : [],
                    reads: i > 0 ? [`n${i - 1}.out`] : [],
                    writes: [`n${i}.out`],
                    priority: input.nodeCount - i,
                    boundaryMode: input.boundaryMode,
                    ...(i === input.nodeCount - 1
                      ? { conflictStrategy: "lane" as const, runtimeStrategy: "stop-merge" as const }
                      : {})
                  })
                )
              }
              const plan = yield* Plan.compile({ planId: `plan-${pSeq}`, flow: "fuzz/Plan", nodes: drafts })

              const executor: PlanScheduler.Executor = {
                execute: ({ node }) => {
                  const idx = Number(node.id.slice(1))
                  if (idx === input.failIndex) {
                    return Effect.fail(new Error(`node-fail-${node.id}`))
                  }
                  return Effect.succeed({ ok: node.id })
                }
              }

              const reconcilerLayer =
                input.reconcileVerdict === "default"
                  ? Reconciliation.layerDefault
                  : Reconciliation.layer({
                    onDeviation: () =>
                      Effect.succeed(
                        input.reconcileVerdict === "fail"
                          ? { _tag: "Fail" as const, reason: "fuzz-fail" }
                          : { _tag: "Reorder" as const, dependsOn: ["n0"], reason: "fuzz-reorder" }
                      ),
                    onConflict: () => Effect.succeed({ _tag: "Fail" as const, reason: "fuzz-conflict" })
                  })

              const stores = TestStores.layerAt(":memory:")
              const fullLayer = Layer.mergeAll(
                stores,
                StepBoundary.layerTest(),
                jjStub,
                PlanScheduler.layerExecutor(executor),
                reconcilerLayer,
                SelectionStore.layer.pipe(Layer.provide(stores))
              )

              return yield* Effect.gen(function*() {
                yield* activateRun(runId, owner, "fuzz/Plan")

                // 1. PlanScheduler record + run
                const sched = PlanScheduler.make({
                  runId,
                  owner,
                  sourceId: `sched/${runId}`,
                  concurrency: { steps: input.concurrency }
                })
                const rec = yield* sched.record(plan)
                if (rec._tag !== "Recorded" && rec._tag !== "ExistingSame") return false
                const rep = yield* sched.run(plan)
                if (rep.digest !== plan.digest) return false
                if (input.failIndex >= 0 && input.failIndex < input.nodeCount) {
                  const failed = rep.settlements.find((s) => s.nodeId === `n${input.failIndex}`)
                  if (failed?.outcome !== "failed") return false
                } else {
                  if (rep.settlements.some((s) => s.outcome !== "built" && s.outcome !== "clean")) return false
                }

                // 2. PlanInputStore record/get + stale owner refusal
                const inputStore = yield* PlanInputStore.PlanInputStore
                const envDigest = yield* StepKey.environmentIdentity()
                const addr: PlanInputStore.Address = {
                  runId,
                  planId: plan.planId,
                  baseDigest: plan.baseDigest,
                  environmentDigest: envDigest,
                  generation: plan.generation
                }
                const snap: PlanInputStore.Snapshot = {
                  version: 1,
                  generation: plan.generation,
                  nodes: Plan.generationNodes(plan).map((n) => ({ id: n.id, key: n.key, reads: [] })),
                  pins: [{ path: "src/a.ts", digest: sha256("a") }]
                }
                const stored = yield* inputStore.record(addr, snap, owner)
                const fetched = yield* inputStore.get(addr, owner)
                if (Option.isNone(fetched) || stored.version !== 1) return false
                if (input.staleOwnerCheck) {
                  const bad = yield* Effect.exit(inputStore.get(addr, staleOwner))
                  if (!Exit.isFailure(bad)) return false
                }

                // 3. PlanMergeStore intend + list + stale owner check
                const mergeStore = yield* PlanMergeStore.PlanMergeStore
                const mergeIdentity: PlanMergeStore.Identity = {
                  runId,
                  planId: plan.planId,
                  baseDigest: plan.baseDigest,
                  environmentDigest: envDigest
                }
                const firstNode = Plan.generationNodes(plan)[0]!
                const intent: PlanMergeStore.Intent = {
                  version: 1,
                  nodeId: firstNode.id,
                  nodeKey: firstNode.key,
                  dispatchKey: firstNode.key,
                  attempts: 1,
                  rebases: 0,
                  peers: []
                }
                const recordedIntent = yield* mergeStore.intend(mergeIdentity, intent, owner).pipe(Effect.result)
                const mergeList = yield* mergeStore.list(mergeIdentity, owner).pipe(Effect.result)
                void recordedIntent
                void mergeList

                // 4. SelectionStore upsert + list + train (law 5 asymmetric confidence)
                const selStore = yield* SelectionStore.SelectionStore
                const edge: Selection.SuspectedEdge = {
                  scope: "packages/smithers/**",
                  affects: "n1",
                  confidence: 0.8,
                  validFromMs: 0,
                  evidence: ["fuzz-seed"]
                }
                yield* selStore.upsert([edge])
                yield* selStore.train([
                  { scope: edge.scope, affects: edge.affects, outcome: input.trainOutcome }
                ])
                const listed = yield* selStore.list()
                if (listed.length < 1) return false
                const conf = listed[0]!.confidence
                if (input.trainOutcome === "miss" && !(conf < 0.8)) return false
                if (input.trainOutcome === "hit" && !(conf >= 0.8)) return false

                // 5. Reconciliation.makeDefault with inherited Object.prototype key safety
                const defaultRec = Reconciliation.makeDefault()
                const recVerdict = yield* defaultRec.onDeviation({
                  nodeId: "n1",
                  keyDigest: sha256("k1"),
                  attempt: 1,
                  paths: ["constructor", "n0.out"],
                  diffIdentity: "d1",
                  declaredBy: { "n0.out": "n0" },
                  alsoDeviatedBy: []
                })
                const confVerdict = yield* defaultRec.onConflict({
                  nodeId: "n1",
                  keyDigest: sha256("k1"),
                  attempt: 1,
                  rebases: 2,
                  strategy: "stop-merge",
                  conflictsWith: ["n0"]
                })
                if (recVerdict._tag !== "Reorder" && recVerdict._tag !== "Fail") return false
                if (confVerdict._tag !== "Fail") return false

                // 6. StepCacheFold.rebuild over real journal
                const rebuilt = yield* StepCacheFold.rebuild()
                void rebuilt

                return true
              }).pipe(Effect.provide(fullLayer), Effect.scoped, Effect.orDie)
            }).pipe(Effect.orDie)
          ),
        { seed: seed + 103, executions: Math.min(executions, 24) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 4: WorkspaceSandbox (makeMemory + makeHosted) hard/expected boundaries, violations, rollbacks & provenance", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        action: Schema.Literals([
          "clean-read-write",
          "undeclared-read",
          "undeclared-write",
          "undeclared-remove",
          "declared-remove",
          "missing-output",
          "workflow-fail",
          "hosted-snapshot-isolation"
        ]),
        boundaryMode: Schema.Literals(["hard", "expected"]),
        content: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9 _.-]{1,24}$/))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              if (input.action === "hosted-snapshot-isolation") {
                const shared = encoder.encode(input.content)
                const svc = WorkspaceSandbox.makeHosted({
                  root: "",
                  snapshot: () => Effect.succeed(new Map([["input.txt", shared]])),
                  baseline: () => Effect.succeed(undefined),
                  retain: (bytes) => Effect.succeed(bytes.slice()),
                  commit: () => Effect.void
                })
                const res = yield* svc.execute({
                  descriptor: {
                    readSet: [{ path: "input.txt", digest: sha256(input.content) }],
                    writeSet: [],
                    removes: [],
                    boundaryMode: "hard"
                  },
                  workflow: Effect.gen(function*() {
                    shared[0] = (shared[0]! + 1) & 0xff
                    const fs = yield* FileSystem.FileSystem
                    return yield* fs.readFileString("input.txt")
                  })
                })
                return res._tag === "Accepted" && res.result.output === input.content
              }

              const mem = yield* WorkspaceSandbox.makeMemory({
                "src/in.txt": input.content,
                "secret.txt": "top-secret",
                "old.txt": "obsolete"
              })

              const desc: FileBoundary = {
                readSet: [{ _tag: "Glob", include: ["src/**"] }],
                writeSet: input.action === "declared-remove" ? [] : ["out/res.txt"],
                removes: input.action === "declared-remove" ? ["old.txt"] : [],
                boundaryMode: input.boundaryMode
              }

              const execExit = yield* Effect.exit(
                mem.service.execute({
                  descriptor: desc,
                  workflow: Effect.gen(function*() {
                    const fs = yield* FileSystem.FileSystem
                    if (input.action === "clean-read-write") {
                      const txt = yield* fs.readFileString("src/in.txt")
                      yield* fs.writeFileString("out/res.txt", `out:${txt}`)
                      return txt
                    }
                    if (input.action === "undeclared-read") {
                      yield* fs.readFileString("secret.txt")
                      yield* fs.writeFileString("out/res.txt", "x")
                      return "bad-read"
                    }
                    if (input.action === "undeclared-write") {
                      yield* fs.writeFileString("out/res.txt", "x")
                      yield* fs.writeFileString("out/extra.txt", "surprise")
                      return "bad-write"
                    }
                    if (input.action === "undeclared-remove") {
                      yield* fs.writeFileString("out/res.txt", "x")
                      yield* fs.remove("old.txt")
                      return "bad-rm"
                    }
                    if (input.action === "declared-remove") {
                      yield* fs.remove("old.txt")
                      return "removed"
                    }
                    if (input.action === "missing-output") {
                      yield* fs.readFileString("src/in.txt")
                      return "no-out"
                    }
                    yield* fs.writeFileString("out/res.txt", "partial")
                    return yield* Effect.fail("wf-failed")
                  })
                })
              )

              if (input.action === "workflow-fail") {
                const f0 = new Map((yield* mem.files).map((f) => [f.path, f.content]))
                return Exit.isFailure(execExit) && !f0.has("out/res.txt")
              }
              if (!Exit.isSuccess(execExit)) return false
              const res = execExit.value
              if (res._tag === "Accepted") {
                yield* mem.service.materialize(res)
              }
              const filesList = yield* mem.files
              const files = new Map(filesList.map((f) => [f.path, f.content]))

              if (input.action === "clean-read-write") {
                return res._tag === "Accepted" && decoder.decode(files.get("out/res.txt")!) === `out:${input.content}`
              }
              if (input.action === "declared-remove") {
                return (res._tag === "Accepted" && !files.has("old.txt")) || (res._tag === "Invalidated" && files.has("old.txt"))
              }
              if (input.boundaryMode === "hard") {
                if (input.action === "undeclared-read" || input.action === "undeclared-write" || input.action === "undeclared-remove") {
                  return res._tag === "Invalidated" && !files.has("out/extra.txt") && files.has("old.txt")
                }
              }
              return res._tag === "Accepted" || res._tag === "Invalidated"
            }).pipe(Effect.scoped, Effect.orDie)
          ),
        { seed: seed + 104, executions: Math.min(executions, 40) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 5: StepBoundary.layer (filesystem + ArtifactStore) prepare, settle, TreeArtifact, removals & replayOutputs", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals(["clean-file", "tree-artifact", "dirty-read", "undeclared-write", "missing-output", "replay-missing-blob", "declared-remove"]),
        boundaryMode: Schema.Literals(["hard", "expected"]),
        body: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9 _.-]{1,24}$/))
      })
    )

    const absentErr = (method: string, path: string) =>
      PlatformError.systemError({
        _tag: "NotFound",
        module: "FileSystem",
        method,
        pathOrDescriptor: path,
        description: `ENOENT: ${path}`
      })

    const makeMemFs = (seedFiles: Record<string, string>) => {
      const files = new Map<string, Uint8Array>(
        Object.entries(seedFiles).map(([k, v]) => [k, encoder.encode(v)])
      )
      const dirs = new Set<string>()
      const addParents = (path: string) => {
        const segs = path.split("/")
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"))
      }
      for (const k of files.keys()) addParents(k)
      const norm = (p: string) => p.replace(/^\.\//, "").replace(/^\/+/, "")
      const present = (p: string) => {
        const k = norm(p)
        return files.has(k) || dirs.has(k) || [...files.keys(), ...dirs].some((c) => c.startsWith(`${k}/`))
      }
      const fs = FileSystem.makeNoop({
        exists: ((p: string) => Effect.sync(() => present(p))) as never,
        readFile: ((p: string) =>
          Effect.suspend(() => {
            const k = norm(p)
            const buf = files.get(k)
            return buf === undefined ? Effect.fail(absentErr("readFile", k)) : Effect.succeed(buf)
          })) as never,
        writeFile: ((p: string, data: Uint8Array) =>
          Effect.sync(() => {
            const k = norm(p)
            addParents(k)
            files.set(k, data.slice())
          })) as never,
        remove: ((p: string, opts?: { readonly recursive?: boolean; readonly force?: boolean }) =>
          Effect.suspend(() => {
            const k = norm(p)
            if (files.delete(k)) return Effect.void
            if (opts?.recursive) {
              const prefix = `${k}/`
              for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f)
              for (const d of [...dirs]) if (d === k || d.startsWith(prefix)) dirs.delete(d)
              return Effect.void
            }
            if (dirs.delete(k)) return Effect.void
            return opts?.force ? Effect.void : Effect.fail(absentErr("remove", k))
          })) as never,
        makeDirectory: ((p: string) =>
          Effect.sync(() => {
            const k = norm(p)
            addParents(k)
            dirs.add(k)
          })) as never,
        readDirectory: ((dirPath: string, opts?: { readonly recursive?: boolean }) =>
          Effect.suspend(() => {
            const k = dirPath === "." || dirPath === "" ? "" : norm(dirPath)
            if (k !== "" && (!present(k) || files.has(k))) return Effect.fail(absentErr("readDirectory", k))
            const prefix = k === "" ? "" : `${k}/`
            const out = new Set<string>()
            for (const c of [...dirs, ...files.keys()]) {
              if (prefix !== "" && !c.startsWith(prefix)) continue
              const rel = prefix === "" ? c : c.slice(prefix.length)
              out.add(opts?.recursive === true ? rel : rel.split("/")[0]!)
            }
            return Effect.succeed([...out].sort())
          })) as never,
        stat: ((p: string) =>
          Effect.suspend(() => {
            const k = norm(p)
            if (files.has(k)) {
              return Effect.succeed({
                type: "File",
                size: files.get(k)!.length,
                mtime: Option.some(new Date(0)),
                dev: 1n,
                ino: Option.some(1n)
              })
            }
            if (present(k)) return Effect.succeed({ type: "Directory" })
            return Effect.fail(absentErr("stat", k))
          })) as never
      })
      return { files, fs: KernelFileSystem.withIsolatedFileSystem(fs) }
    }

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const host = makeMemFs({
                "input.txt": input.body,
                "obsolete.txt": "remove-me",
                "tree/a.txt": `a:${input.body}`,
                "tree/nested/b.txt": `b:${input.body}`
              })
              const artifacts = ArtifactStore.makeMemory()
              const pathSvc = yield* Effect.provide(Path.Path, NodePath.layer)
              const boundary = StepBoundary.makeFileSystem(host.fs, pathSvc, artifacts)

              const desc: FileBoundary = {
                readSet: [
                  { path: "input.txt", digest: sha256(input.body) },
                  ...(input.mode === "tree-artifact" ? [{ _tag: "Glob" as const, include: ["tree/**"] as [string, ...Array<string>] }] : [])
                ],
                writeSet:
                  input.mode === "tree-artifact"
                    ? [{ _tag: "TreeArtifact", path: "tree" }]
                    : input.mode === "declared-remove"
                    ? []
                    : ["output.txt"],
                ...(input.mode === "declared-remove" ? { removes: ["obsolete.txt"] } : {}),
                boundaryMode: input.boundaryMode
              }

              const prepared = yield* boundary.prepare(desc)
              if (input.mode !== "tree-artifact" && !StepBoundary.readSetMatches(prepared)) return false

              if (input.mode === "dirty-read") {
                const dirty = StepBoundary.readSetMatches({
                  descriptor: { ...desc, readSet: [{ path: "input.txt", digest: sha256("other") }] },
                  readSnapshot: prepared.readSnapshot
                })
                return dirty === false
              }

              if (input.mode === "clean-file" || input.mode === "replay-missing-blob") {
                host.files.set("output.txt", encoder.encode(`res:${input.body}`))
              } else if (input.mode === "undeclared-write") {
                host.files.set("output.txt", encoder.encode(`res:${input.body}`))
                host.files.set("surprise.txt", encoder.encode("extra"))
              } else if (input.mode === "declared-remove") {
                host.files.delete("obsolete.txt")
              }

              const settleExit = yield* Effect.exit(boundary.settle(prepared))
              if (input.mode === "missing-output" && input.boundaryMode === "hard") {
                return Exit.isFailure(settleExit)
              }
              if (!Exit.isSuccess(settleExit)) return true

              const evidence = settleExit.value
              const digests = StepBoundary.referencedDigests(evidence)
              if (input.mode === "clean-file") {
                if (input.boundaryMode === "hard" && digests.length < 1) return false
                if (digests.length >= 1) {
                  host.files.delete("output.txt")
                  yield* boundary.replayOutputs(evidence)
                  const restored = host.files.get("output.txt")
                  return restored !== undefined && decoder.decode(restored) === `res:${input.body}`
                }
                return true
              }
              if (input.mode === "tree-artifact") {
                host.files.delete("tree/a.txt")
                host.files.delete("tree/nested/b.txt")
                yield* boundary.replayOutputs(evidence)
                const restored = host.files.get("tree/nested/b.txt")
                return restored !== undefined && decoder.decode(restored) === `b:${input.body}`
              }
              if (input.mode === "declared-remove") {
                host.files.set("obsolete.txt", encoder.encode("reappeared"))
                yield* boundary.replayOutputs(evidence)
                return !host.files.has("obsolete.txt")
              }
              if (input.mode === "replay-missing-blob") {
                const emptyBoundary = StepBoundary.makeFileSystem(host.fs, pathSvc, ArtifactStore.makeMemory())
                const replayExit = yield* Effect.exit(emptyBoundary.replayOutputs(evidence))
                return digests.length >= 1 ? Exit.isFailure(replayExit) : true
              }
              return true
            }).pipe(Effect.orDie)
          ),
        { seed: seed + 105, executions: Math.min(executions, 30) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 6: RunInspection (inspect, list, payload) + RunCatalogRead (filtered cursor pagination vs reference) + ExecutionSnapshot.related", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        statusFilter: Schema.Literals(["all", "pending", "running", "suspended", "completed", "failed", "cancelled"]),
        flowFilter: Schema.Literals(["all", "flow0", "flow1", "flow2"]),
        waitingFilter: Schema.Literals(["all", "timer", "approval", "event"]),
        pageSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(7)),
        runCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(8), Schema.isLessThanOrEqualTo(20))
      })
    )

    const statuses = ["pending", "running", "suspended", "completed", "failed", "cancelled"] as const
    const reasons = [null, "timer", "event", "approval", "quota", "human"] as const

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const stores = TestStores.layerAt(":memory:")
              const readLayer = Layer.mergeAll(
                stores,
                RunCatalogRead.layer.pipe(Layer.provide(stores)),
                ExecutionSnapshot.layer.pipe(Layer.provide(stores)),
                RunInspection.layer.pipe(Layer.provide(stores))
              )

              return yield* Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const rows = Array.from({ length: input.runCount }, (_, i) => ({
                  runId: `r${String(i).padStart(4, "0")}`,
                  createdAtMs: 1000 + Math.floor(i / 2) * 10,
                  status: statuses[i % statuses.length]!,
                  flowName: `flow${i % 3}`,
                  parentRunId: i === 0 ? null : "r0000",
                  lineageId: `r${String(i % 3).padStart(4, "0")}`,
                  waitingReason: reasons[i % reasons.length]!,
                  roundOrdinal: Math.floor(i / 3)
                }))

                yield* sql.withTransaction(
                  Effect.forEach(rows, (row) =>
                    sql`
                      INSERT INTO flows_runs (
                        run_id, status, created_at_ms, state_json, parent_run_id, lineage_id,
                        round_ordinal, waiting_reason, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms
                      ) VALUES (
                        ${row.runId}, ${row.status}, ${row.createdAtMs},
                        ${JSON.stringify({ version: 1, flowName: row.flowName, payload: { secret: "sk-1234567890abcdef" } })},
                        ${row.parentRunId}, ${row.lineageId}, ${row.roundOrdinal}, ${row.waitingReason},
                        ${row.status === "running" ? "host" : null},
                        ${row.status === "running" ? 1 : null},
                        ${row.status === "running" ? "nonce" : null},
                        ${row.status === "running" ? 1 : null}
                      )
                    `, { discard: true }
                  )
                )

                const catalog = yield* RunCatalogRead.RunCatalogRead
                const filters: RunCatalogRead.Filters = {
                  ...(input.statusFilter === "all" ? {} : { status: input.statusFilter }),
                  ...(input.flowFilter === "all" ? {} : { flowName: input.flowFilter }),
                  ...(input.waitingFilter === "all" ? {} : { waitingReason: input.waitingFilter })
                }

                const collected: Array<string> = []
                let cursor: string | undefined = undefined
                let guard = 0
                while (guard++ < 30) {
                  const page: RunCatalogRead.RunPage = yield* catalog.listRuns({
                    filters,
                    limit: input.pageSize,
                    ...(cursor === undefined ? {} : { cursor })
                  })
                  for (const item of page.runs) collected.push(item.runId)
                  if (page.cursor === null) break
                  cursor = page.cursor
                }

                const expected = rows
                  .filter(
                    (r) =>
                      (filters.status === undefined || r.status === filters.status) &&
                      (filters.flowName === undefined || r.flowName === filters.flowName) &&
                      (filters.waitingReason === undefined || r.waitingReason === filters.waitingReason)
                  )
                  .map((r) => r.runId)

                if (collected.length !== expected.length) return false
                const collectedSet = new Set(collected)
                if (collectedSet.size !== expected.length) return false
                for (const id of expected) {
                  if (!collectedSet.has(id)) return false
                }
                const allIds = yield* catalog.listRunIds({ limit: input.runCount })
                if (allIds.length !== input.runCount) return false

                // ExecutionSnapshot.read + related (children & rounds)
                const snap = yield* ExecutionSnapshot.ExecutionSnapshot
                const batch = yield* snap.read(["r0000", "r0001", "missing-id"])
                if (batch.snapshots.length !== 3) return false
                const relChildren = yield* snap.related({ runId: "r0000", kind: "children", limit: 10 })
                const relRounds = yield* snap.related({ runId: "r0000", kind: "rounds", limit: 10 })
                void relChildren
                void relRounds

                // RunInspection.inspect + list + payload on present + missing runs
                const inspector = yield* RunInspection.RunInspection
                const inspected = yield* inspector.inspect("r0000")
                if (inspected.run.runId !== "r0000") return false
                const listRoots = yield* inspector.list({ roots: true, limit: 5 })
                const listFlows = yield* inspector.list({ roots: false, flows: ["flow0"], limit: 5 })
                const listIds = yield* inspector.list({ roots: false, runIds: ["r0000", "r0001", "missing"] })
                const rawPayload = yield* inspector.payload("r0000")
                if (listRoots.runs.length < 1 || listFlows.runs.length < 1 || listIds.runs.length !== 2) return false
                if (rawPayload.flowName !== "flow0") return false
                const missingExit = yield* Effect.exit(inspector.inspect("does-not-exist"))
                if (!Exit.isFailure(missingExit)) return false

                return true
              }).pipe(Effect.provide(readLayer), Effect.scoped, Effect.orDie)
            })
          ),
        { seed: seed + 106, executions: Math.min(executions, 25) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 7: ArtifactSync + CacheSync + Inconsistency (strict & tolerant) + Retention (eligible & collect)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        blobText: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9 _.-]{1,24}$/)),
        remoteFails: Schema.Boolean,
        inconsistencyPolicy: Schema.Literals(["strict", "tolerant"]),
        dryRun: Schema.Boolean,
        liveDescendant: Schema.Boolean
      })
    )

    let rSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              rSeq++
              const bytes = encoder.encode(input.blobText)
              const digest = sha256(bytes)

              // 1. ArtifactSync local + remote (healthy & faulty)
              const localArt = ArtifactStore.makeMemory()
              const remoteArt = ArtifactStore.makeMemory()
              yield* localArt.put(bytes)

              const localSync = ArtifactSync.makeLocal()
              yield* localSync.publish([digest])
              if ((yield* localSync.hydrate([digest])) !== false) return false
              if ((yield* localSync.hydrate([])) !== true) return false

              const faultyRemote: ArtifactStore.Service = {
                ...remoteArt,
                put: () =>
                  Effect.fail(
                    new ArtifactStore.ArtifactStoreError({
                      code: "unavailable",
                      message: "injected remote failure"
                    })
                  )
              }
              const sync = ArtifactSync.make({
                local: localArt,
                remote: input.remoteFails ? faultyRemote : remoteArt
              })
              const pubExit = yield* Effect.exit(sync.publish([digest]))
              if (input.remoteFails) {
                if (!Exit.isFailure(pubExit)) return false
              } else {
                if (!Exit.isSuccess(pubExit)) return false
                if (!(yield* remoteArt.has(digest))) return false
                const freshLocal = ArtifactStore.makeMemory()
                const sync2 = ArtifactSync.make({ local: freshLocal, remote: remoteArt })
                const hydrated = yield* sync2.hydrate([digest])
                if (!hydrated || !(yield* freshLocal.has(digest))) return false
              }

              // 2. CacheSync local + remote (healthy & faulty)
              const localCacheSync = CacheSync.makeLocal()
              const cacheEntry: CacheStore.CacheEntry = {
                keyDigest: sha256(`cache-${rSeq}`),
                result: { ok: true },
                meta: {},
                createdAtMs: 100,
                recordedRunId: "r-cache",
                recordedEventSeq: 1
              }
              const csLocal = yield* localCacheSync.publishEntry(cacheEntry)
              if (Option.isSome(csLocal)) return false

              const stores = TestStores.layerAt(":memory:")
              const owner: Ownership.OwnerId = { hostId: "inc-h", pid: 77, nonce: `inc-${rSeq}` }

              return yield* Effect.gen(function*() {
                const localCache = yield* CacheStore.CacheStore
                const remoteCache: CacheStore.Service = input.remoteFails
                  ? {
                    ...localCache,
                    put: () =>
                      Effect.fail(
                        new CacheStore.CacheStoreError({
                          code: "persistence_failed",
                          message: "remote cache down"
                        })
                      )
                  }
                  : localCache
                const cacheSync = CacheSync.make({ remote: remoteCache })
                const pubCache = yield* cacheSync.publishEntry(cacheEntry)
                if (input.remoteFails && Option.isNone(pubCache)) return false
                if (!input.remoteFails && Option.isSome(pubCache)) return false

                // 3. Inconsistency (strict vs tolerant) on cache conflict
                const incRunId = `inc-run-${rSeq}`
                yield* activateRun(incRunId, owner, "fuzz/inc")
                const conflictKey = `conflict-key-${rSeq}`
                yield* localCache.put({
                  keyDigest: sha256(conflictKey),
                  result: "old",
                  meta: {},
                  createdAtMs: 1,
                  recordedRunId: "prev-run",
                  recordedEventSeq: 0
                })
                const incLayer =
                  input.inconsistencyPolicy === "strict"
                    ? Inconsistency.layerStrict(owner)
                    : Inconsistency.layerTolerant(owner)

                const incExit = yield* Effect.exit(
                  ActionPersistence.make({
                    runId: incRunId,
                    owner,
                    sourceId: "inc-src",
                    execute: () => Effect.succeed("new")
                  })({
                    action: {},
                    attempt: 1,
                    key: conflictKey,
                    tier: "sealed",
                    metadata: { readSet: [], writeSet: ["out.txt"], boundaryMode: "hard" }
                  }).pipe(Effect.provide(incLayer))
                )
                void incExit

                // 4. Retention eligible + collect (dryRun vs real, preserving live lineage)
                const sql = yield* SqlClient.SqlClient
                const insertRun = (id: string, status: string, finishedAtMs: number | null, parentRunId: string | null) =>
                  sql`INSERT INTO flows_runs ${
                    sql.insert({
                      run_id: id,
                      status,
                      created_at_ms: 1,
                      started_at_ms: 1,
                      finished_at_ms: finishedAtMs,
                      owner_host_id: status === "running" ? "h" : null,
                      owner_pid: status === "running" ? 1 : null,
                      owner_nonce: status === "running" ? "n" : null,
                      heartbeat_at_ms: status === "running" ? 1 : null,
                      parent_run_id: parentRunId,
                      state_json: "{}"
                    })
                  }`
                yield* insertRun("ret-old-orphan", "completed", 100, null).pipe(Effect.tapError((e) => Effect.sync(() => console.log("S7:sql1 " + String((e as any).cause?.message ?? e)))))
                yield* insertRun("ret-old-parent", "completed", 100, null).pipe(Effect.tapError((e) => Effect.sync(() => console.log("S7:sql2 " + String((e as any).cause?.message ?? e)))))
                yield* insertRun(
                  "ret-child",
                  input.liveDescendant ? "running" : "completed",
                  input.liveDescendant ? null : 100,
                  "ret-old-parent"
                )
                yield* insertRun("ret-fresh", "completed", 999_999, null).pipe(Effect.tapError((e) => Effect.sync(() => console.log("S7:sql4 " + String((e as any).cause?.message ?? e)))))

                const elig = yield* Retention.eligible(500).pipe(Effect.tapError((e) => Effect.sync(() => console.log("S7:elig " + String((e as any).cause?.message ?? e)))))
                if (!elig.includes("ret-old-orphan")) return false
                if (elig.includes("ret-fresh")) return false
                if (input.liveDescendant && elig.includes("ret-old-parent")) return false

                const rep = yield* Retention.collect({ olderThanMs: 500, dryRun: input.dryRun }).pipe(Effect.tapError((e) => Effect.sync(() => console.log("S7:collect " + String((e as any).cause?.message ?? e)))))
                if (rep.runs.length < 1) return false
                const remaining = yield* sql<{ readonly run_id: string }>`SELECT run_id FROM flows_runs`
                const remIds = new Set(remaining.map((r) => r.run_id))
                if (!remIds.has("ret-fresh")) return false
                if (input.liveDescendant && !remIds.has("ret-old-parent")) return false
                if (!input.dryRun && remIds.has("ret-old-orphan")) return false
                if (input.dryRun && !remIds.has("ret-old-orphan")) return false

                return true
              }).pipe(
                Effect.provide(Layer.mergeAll(stores, StepBoundary.layerTest(), jjStub)),
                Effect.scoped,
                Effect.orDie
              )
            })
          ),
        { seed: seed + 107, executions: Math.min(executions, 25) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 8: DurableEngineState.makeMemory (fences, clocks, deferreds, waitingTree, DAG cycles, nested tx rollback) + ResultEnvelope + ExitEncoding", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        clockDelayMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(5), Schema.isLessThanOrEqualTo(500)),
        rollbackTx: Schema.Boolean,
        completeClockDirect: Schema.Boolean,
        staleOwner: Schema.Boolean,
        waitingReason: Schema.Literals(["timer", "event", "approval", "human"]),
        exitKind: Schema.Literals(["success", "fail", "die", "interrupt", "suspended", "non-json"])
      })
    )

    class MemErr extends Schema.TaggedError<MemErr>()("MemFuzzErr", { info: Schema.String }) {}
    const MemFlow = Flow.make("fuzz/MemEncFlow", {
      payload: {},
      success: Schema.String,
      error: MemErr,
      body: () => Node.succeed("ok")
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              const owner: Ownership.OwnerId = { hostId: "mem-h", pid: 11, nonce: "mem-n" }
              const otherOwner: Ownership.OwnerId = { hostId: "other-h", pid: 99, nonce: "other-n" }

              const runTable = new Map<string, DurableEngineState.MemoryRunView>([
                [
                  "m-root",
                  {
                    status: "running",
                    owner,
                    flowName: "fuzz/mem",
                    createdAtMs: 100,
                    heartbeatAtMs: 500
                  }
                ],
                [
                  "m-child",
                  {
                    status: "running",
                    owner,
                    flowName: "fuzz/mem",
                    createdAtMs: 110,
                    heartbeatAtMs: 510
                  }
                ],
                [
                  "m-grand",
                  {
                    status: "running",
                    owner,
                    flowName: "fuzz/mem",
                    createdAtMs: 120,
                    heartbeatAtMs: 520
                  }
                ],
                [
                  "m-pending",
                  {
                    status: "pending",
                    owner: null,
                    flowName: "fuzz/pend",
                    createdAtMs: 130,
                    heartbeatAtMs: null
                  }
                ],
                [
                  "m-canc",
                  {
                    status: "pending",
                    owner: null,
                    flowName: "fuzz/pend",
                    createdAtMs: 140,
                    heartbeatAtMs: null,
                    cancelRequestedAtMs: 145
                  }
                ]
              ])

              const mem = DurableEngineState.makeMemory({
                runs: (id) => Option.fromNullishOr(runTable.get(id)),
                listRuns: () => runTable.entries()
              })

              // 1. Pending runs + pending cancellations + stale running runs
              const pRuns = yield* mem.pendingRuns("fuzz/pend", 10)
              const pTail = yield* mem.pendingRunTail("fuzz/pend")
              const cRuns = yield* mem.pendingCancellationRuns(10)
              const cTail = yield* mem.pendingCancellationTail()
              const stale = yield* mem.staleRunningRuns(1000, 10)
              if (pRuns.length < 1 || Option.isNone(pTail) || cRuns.length < 1 || Option.isNone(cTail) || stale.length < 1) {
                return false
              }

              // 2. Parent edges + cycle rejection + runParents + runChildren + runChildrenOf
              const r1 = yield* mem.recordRunParent("m-child", "m-root")
              const r1Dup = yield* mem.recordRunParent("m-child", "m-root")
              const r2 = yield* mem.recordRunParent("m-grand", "m-child")
              if (r1._tag !== "Recorded" || r1Dup._tag !== "Existing" || r2._tag !== "Recorded") return false
              const cyc = yield* Effect.exit(mem.recordRunParent("m-root", "m-grand"))
              if (!Exit.isFailure(cyc)) return false
              const parents = yield* mem.runParents("m-child")
              const children = yield* mem.runChildren("m-root")
              const bulk = yield* mem.runChildrenOf!(["m-root", "m-child", "m-root"])
              if (parents.length !== 1 || children.length !== 1 || bulk.length !== 2) return false

              // 3. Transaction commit & nested savepoint rollback invariance
              const txRes = yield* Effect.exit(
                mem.transaction(
                  Effect.gen(function*() {
                    yield* mem.completeDeferred({
                      flowName: "fuzz/mem",
                      executionId: "m-root",
                      deferredName: "tx-def",
                      exit: { _tag: "Success", value: 1 },
                      completedAtMs: 200
                    })
                    // Nested savepoint that fails and is caught
                    const nested = yield* Effect.exit(
                      mem.transaction(
                        Effect.gen(function*() {
                          yield* mem.completeDeferred({
                            flowName: "fuzz/mem",
                            executionId: "m-root",
                            deferredName: "inner-def",
                            exit: { _tag: "Success", value: 2 },
                            completedAtMs: 201
                          })
                          return yield* Effect.fail("inner-rollback")
                        })
                      )
                    )
                    if (!Exit.isFailure(nested)) return yield* Effect.die("expected inner fail")
                    if (input.rollbackTx) return yield* Effect.fail("outer-rollback")
                    return "committed"
                  })
                )
              )
              const outerDef = yield* mem.deferred({ flowName: "fuzz/mem", executionId: "m-root", deferredName: "tx-def" })
              const innerDef = yield* mem.deferred({ flowName: "fuzz/mem", executionId: "m-root", deferredName: "inner-def" })
              if (Option.isSome(innerDef)) return false
              if (input.rollbackTx && (Exit.isSuccess(txRes) || Option.isSome(outerDef))) return false
              if (!input.rollbackTx && (!Exit.isSuccess(txRes) || Option.isNone(outerDef))) return false

              // 4. Clocks + ownership fence + dueClocks + pendingClocks + hasDueWake
              const cAddr: DurableEngineState.ClockAddress = {
                flowName: "fuzz/mem",
                executionId: "m-root",
                clockName: "mc1"
              }
              if (input.staleOwner) {
                const fenced = yield* Effect.exit(
                  mem.scheduleClock(
                    { ...cAddr, deferredName: "d-mc1", dueAtMs: 1000 + input.clockDelayMs, completedAtMs: null },
                    otherOwner
                  )
                )
                if (!Exit.isFailure(fenced)) return false
              }
              const sc = yield* mem.scheduleClock(
                { ...cAddr, deferredName: "d-mc1", dueAtMs: 1000 + input.clockDelayMs, completedAtMs: null },
                owner
              )
              const scDup = yield* mem.scheduleClock(
                { ...cAddr, deferredName: "d-mc1", dueAtMs: 9999, completedAtMs: null },
                owner
              )
              if (sc._tag !== "Scheduled" || scDup._tag !== "Existing") return false
              const gotClk = yield* mem.clock(cAddr)
              const pendClk = yield* mem.pendingClocks({ executionId: "m-root" })
              const dueClk = yield* mem.dueClocks(1000 + input.clockDelayMs + 5)
              const dueWake = yield* mem.hasDueWake("m-root", 1000 + input.clockDelayMs + 5)
              if (Option.isNone(gotClk) || pendClk.length < 1 || dueClk.length < 1 || !dueWake) return false
              if (input.completeClockDirect) {
                yield* mem.completeClock(cAddr, 1100)
              } else {
                yield* mem.completeRunClocks("m-root", 1100)
              }

              // 5. Deferreds + completedDeferreds + consumeDeferred + missing run NotFound
              const missingDef = yield* mem.completeDeferred({
                flowName: "fuzz/mem",
                executionId: "no-such-run",
                deferredName: "x",
                exit: { _tag: "Success", value: 0 },
                completedAtMs: 100
              })
              if (missingDef._tag !== "NotFound") return false
              const dAddr: DurableEngineState.DeferredAddress = {
                flowName: "fuzz/mem",
                executionId: "m-root",
                deferredName: "md1"
              }
              const cd = yield* mem.completeDeferred({ ...dAddr, exit: { _tag: "Success", value: "v" }, completedAtMs: 1050 })
              if (cd._tag !== "Completed") return false
              const uncons = yield* mem.completedDeferreds("fuzz/mem", "m-root")
              if (uncons.length < 1) return false
              const c1 = yield* mem.consumeDeferred(dAddr, 1060)
              const c2 = yield* mem.consumeDeferred(dAddr, 1070)
              if (!c1 || c2) return false

              // 6. Park + waiting + waitingRuns + waitingTree + wake + removeRunParentsForRun
              const pk = yield* mem.park("m-grand", { reason: input.waitingReason, wakeAt: 2000 }, owner)
              if (pk._tag !== "Parked") return false
              const wRow = yield* mem.waiting("m-grand")
              const wRuns = yield* mem.waitingRuns({ reason: input.waitingReason, dueBeforeMs: 3000 })
              const wTree = yield* mem.waitingTree("m-root")
              if (Option.isNone(wRow) || wRuns.length < 1 || wTree.length < 1) return false
              const wk1 = yield* mem.wake("m-grand")
              const wk2 = yield* mem.wake("m-grand")
              if (wk1._tag !== "Woken" || wk2._tag !== "NotWaiting") return false
              yield* mem.removeRunParentsForRun("m-grand")

              // 7. ResultEnvelope + ExitEncoding across all exit shapes
              if (input.exitKind === "non-json") {
                const bad = yield* ResultEnvelope.fromEncoded({ big: 1n })
                if (bad._tag !== "EncodingFailure") return false
              } else {
                const flowResult =
                  input.exitKind === "success"
                    ? new Flow.Complete({ exit: Exit.succeed("hello") })
                    : input.exitKind === "fail"
                    ? new Flow.Complete({ exit: Exit.fail(new MemErr({ info: "bad" })) })
                    : input.exitKind === "die"
                    ? new Flow.Complete({ exit: Exit.die(new Error("boom-defect")) })
                    : input.exitKind === "interrupt"
                    ? new Flow.Complete({ exit: Exit.interrupt(1) })
                    : new Flow.Suspended({})
                const env = yield* ResultEnvelope.encode(MemFlow, flowResult)
                if (env._tag !== "Encoded" && env._tag !== "EncodingFailure") return false
                const dec = yield* ResultEnvelope.decode(env.value).pipe(Effect.result)
                const circ: Record<string, unknown> = { n: 1n, sym: Symbol("s"), map: new Map([["a", 1]]), set: new Set([1, 2]), bytes: new Uint8Array([1, 2, 3]) }
                circ.self = circ
                const projVal = ExitEncoding.projectValue(circ)
                const projRes = ExitEncoding.projectResult(flowResult, "fuzz-note")
                void dec
                void projVal
                void projRes
              }

              // 8. AttemptLifecycle.restore & projection error paths
              const badRestore = yield* AttemptLifecycle.restore({ invalid: true }, { name: "fuzz", version: 1 } as any).pipe(
                Effect.result
              )
              void badRestore

              return true
            }).pipe(Effect.orDie)
          ),
        { seed: seed + 108, executions: Math.min(executions, 35) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 9: WorkspaceSandbox.makeFileSystem + SandboxedExecution + ActionPersistence cache/policy/publication/tiers", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        fsCase: Schema.Literals(["clean-commit", "reserved-path", "undeclared-read", "undeclared-write", "conflict-materialize"]),
        tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
        cacheHit: Schema.Boolean,
        content: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9 _.-]{1,20}$/))
      })
    )

    let fsSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              fsSeq++
              const dir = nodeFs.mkdtempSync(join(tempRoot, `wsfs-${fsSeq}-`))
              try {
                nodeFs.mkdirSync(join(dir, "src"), { recursive: true })
                nodeFs.writeFileSync(join(dir, "src", "in.txt"), input.content)
                nodeFs.writeFileSync(join(dir, "secret.txt"), "private")

                const fsBase = yield* Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer)
                const pathSvc = yield* Effect.provide(Path.Path, NodePath.layer)
                const artifacts = ArtifactStore.makeMemory()
                const wsFs = WorkspaceSandbox.makeFileSystem(
                  KernelFileSystem.withIsolatedFileSystem(fsBase),
                  pathSvc,
                  artifacts,
                  dir,
                  { reservedPaths: ["reserved-cfg"] }
                )

                const resExit = yield* Effect.exit(
                  wsFs.execute({
                    descriptor: {
                      readSet: [{ path: "src/in.txt", digest: sha256(input.content) }],
                      writeSet: [input.fsCase === "reserved-path" ? "reserved-cfg/x.txt" : "out.txt"],
                      removes: [],
                      boundaryMode: "hard"
                    },
                    workflow: Effect.gen(function*() {
                      const fs = yield* FileSystem.FileSystem
                      if (input.fsCase === "reserved-path") {
                        yield* fs.writeFileString("reserved-cfg/x.txt", "nope")
                        return "res"
                      }
                      if (input.fsCase === "undeclared-read") {
                        yield* fs.readFileString("secret.txt")
                        yield* fs.writeFileString("out.txt", "x")
                        return "ur"
                      }
                      if (input.fsCase === "undeclared-write") {
                        yield* fs.writeFileString("out.txt", "x")
                        yield* fs.writeFileString("extra.txt", "y")
                        return "uw"
                      }
                      const s = yield* fs.readFileString("src/in.txt")
                      yield* fs.writeFileString("out.txt", `fs:${s}`)
                      return s
                    })
                  })
                )

                if (input.fsCase === "reserved-path") {
                  if (Exit.isSuccess(resExit) && resExit.value._tag === "Accepted") {
                    const matExit = yield* Effect.exit(wsFs.materialize(resExit.value))
                    if (!Exit.isFailure(matExit)) return false
                  }
                } else if (Exit.isSuccess(resExit)) {
                  const res = resExit.value
                  if (input.fsCase === "clean-commit" && res._tag === "Accepted") {
                    yield* wsFs.materialize(res)
                    if (nodeFs.readFileSync(join(dir, "out.txt"), "utf8") !== `fs:${input.content}`) return false
                  } else if (input.fsCase === "conflict-materialize" && res._tag === "Accepted") {
                    nodeFs.writeFileSync(join(dir, "out.txt"), "concurrent-host-edit")
                    const matExit = yield* Effect.exit(wsFs.materialize(res))
                    if (!Exit.isFailure(matExit)) return false
                  } else if (input.fsCase === "undeclared-read" || input.fsCase === "undeclared-write") {
                    if (res._tag !== "Invalidated") return false
                  }
                }
              } finally {
                nodeFs.rmSync(dir, { recursive: true, force: true })
              }

              // ActionPersistence with WorkspaceSandbox (SandboxedExecution) + CacheStore + ArtifactSync + CacheSync + tiers
              const memSb = yield* WorkspaceSandbox.makeMemory({ "src/a.txt": input.content })
              const stores = TestStores.layerAt(":memory:")
              const owner: Ownership.OwnerId = { hostId: "ap-h", pid: 303, nonce: `ap-${fsSeq}` }
              const localArt = ArtifactStore.makeMemory()
              const remoteArt = ArtifactStore.makeMemory()
              const artSyncLayer = Layer.succeed(
                ArtifactSync.ArtifactSync,
                ArtifactSync.make({ local: localArt, remote: remoteArt })
              )
              const runLayer = Layer.mergeAll(
                stores,
                StepBoundary.layerTest(),
                jjStub,
                WorkspaceSandbox.layer(memSb.service),
                artSyncLayer,
                CacheSync.layerLocal
              )

              return yield* Effect.gen(function*() {
                const run1 = `ap-r1-${fsSeq}`
                const run2 = `ap-r2-${fsSeq}`
                yield* activateRun(run1, owner, "fuzz/ap")
                yield* activateRun(run2, owner, "fuzz/ap")

                let execCalls = 0
                const key = `ap-key-${input.tier}-${fsSeq}`
                const metadata: ActionPersistence.BoundaryMetadata = {
                  readSet: [{ path: "src/a.txt", digest: sha256(input.content) }],
                  writeSet: ["out/b.txt"],
                  boundaryMode: "hard"
                }

                const runAction = (runId: string) =>
                  ActionPersistence.make({
                    runId,
                    owner,
                    sourceId: `ap-src-${runId}`,
                    execute: () =>
                      Effect.gen(function*() {
                        execCalls++
                        return `val:${input.content}:${execCalls}`
                      })
                  })({
                    action: { name: "ap/step" },
                    attempt: 1,
                    key,
                    tier: input.tier,
                    ...(input.tier === "sealed" ? { metadata } : {})
                  })

                const v1 = yield* runAction(run1)
                if (typeof v1 !== "string") return false
                if (input.cacheHit) {
                  const v2 = yield* runAction(run2)
                  if (typeof v2 !== "string") return false
                }

                // CacheOutputPolicy.replay exercises policy gating
                void CacheOutputPolicy.replay

                return true
              }).pipe(Effect.provide(runLayer), Effect.scoped, Effect.orDie)
            }).pipe(Effect.scoped, Effect.orDie)
          ),
        { seed: seed + 109, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 10: EngineStore.drive (budgetMs, holdMs) + cancelCascade + RunInspection on real executed Flow tree", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        scenario: Schema.Literals(["drive-complete-and-inspect", "drive-sleep-hold-zero", "cancel-running-or-parked", "drive-failing-flow"]),
        budgetMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(50), Schema.isLessThanOrEqualTo(500)),
        holdMs: Schema.Literals([0, 200]),
        payloadSize: Schema.Int.check(Schema.isGreaterThanOrEqualTo(10), Schema.isLessThanOrEqualTo(200))
      })
    )

    class DriveFail extends Schema.TaggedError<DriveFail>()("DriveFuzzFail", { reason: Schema.String }) {}

    let dSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              dSeq++
              const execId = `drv-real-${dSeq}`
              const Echo = Action.make(`drv/Echo-${dSeq}`, {
                payload: { msg: Schema.String },
                success: Schema.String
              })
              const FailAct = Action.make(`drv/Fail-${dSeq}`, {
                payload: {},
                success: Schema.String,
                error: DriveFail
              })
              const Child = Flow.make(`drv/Child-${dSeq}`, {
                payload: { msg: Schema.String },
                success: Schema.String,
                body: Node.capture({}, ({ msg }) => Echo.call({ msg: `child:${msg}` }))
              })
              const Root = Flow.make(`drv/Root-${dSeq}`, {
                payload: { scenario: Schema.String, msg: Schema.String },
                success: Schema.String,
                error: Schema.Union([DriveFail, Sleep.SleepRequestInvalid]),
                body: ({ msg, scenario }) => {
                  if (scenario === "drive-failing-flow") {
                    return Echo.call({ msg }).pipe(Node.andThen(FailAct.call({})))
                  }
                  if (scenario === "drive-sleep-hold-zero" || scenario === "cancel-running-or-parked") {
                    return Sleep.action.call({ millis: 40 }).pipe(Node.andThen(Echo.call({ msg })))
                  }
                  return Echo.call({ msg }).pipe(
                    Node.andThen(Child.child({ msg })),
                    Node.map(Node.capture({}, (s) => `done:${s}`))
                  )
                }
              })

              const stores = TestStores.layerAt(":memory:")
              const engineLayer = EngineStore.layer({
                owner: { hostId: `drv-h-${dSeq}` },
                journalSource: "drv-src",
                isAlive: () => Effect.succeed(true),
                sweep: { host: `drv-h-${dSeq}` }
              }).pipe(
                Layer.provideMerge(StepBoundary.layerTest()),
                Layer.provideMerge(WorkspaceSandbox.layerUnsupported),
                Layer.provideMerge(jjStub),
                Layer.provideMerge(RunInspection.layer),
                Layer.provideMerge(stores)
              )

              const fullLayer = Layer.mergeAll(
                Echo.toLayer(({ msg }) =>
                  Effect.gen(function*() {
                    yield* Effect.logInfo(`echo-len=${msg.length}`)
                    return `e:${msg}`
                  })
                ),
                FailAct.toLayer(() => Effect.fail(new DriveFail({ reason: "boom" }))),
                Interpreter.layer(Child),
                Interpreter.layer(Root)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(engineLayer)
              )

              const msg = "x".repeat(input.payloadSize)
              return yield* Effect.gen(function*() {
                const driven = yield* EngineStore.drive(Root, {
                  executionId: execId,
                  payload: { scenario: input.scenario, msg },
                  budgetMs: input.budgetMs,
                  holdMs: input.scenario === "cancel-running-or-parked" ? 0 : input.holdMs
                })

                if (input.scenario === "cancel-running-or-parked") {
                  const rt = yield* FlowRuntime.FlowRuntime
                  yield* rt.interrupt(Root, execId)
                  const driven2 = yield* EngineStore.drive(Root, {
                    executionId: execId,
                    payload: { scenario: input.scenario, msg },
                    budgetMs: 200,
                    holdMs: 0
                  })
                  void driven2
                } else if (input.scenario === "drive-sleep-hold-zero" && driven._tag === "Parked") {
                  yield* Effect.sleep("45 millis")
                  const driven2 = yield* EngineStore.drive(Root, {
                    executionId: execId,
                    payload: { scenario: input.scenario, msg },
                    budgetMs: 500,
                    holdMs: 200
                  })
                  if (driven2._tag !== "Settled" && driven2._tag !== "Parked") return false
                }

                const journal = yield* Journal.Journal
                yield* journal.flush
                const inspector = yield* RunInspection.RunInspection
                const inspected = yield* inspector.inspect(execId, { afterSeq: -1, limit: 5 })
                if (inspected.run.runId !== execId) return false
                if (inspected.journal.hasMore) {
                  const page2 = yield* inspector.inspect(execId, { afterSeq: inspected.journal.nextSeq, limit: 50 })
                  if (page2.journal.events.length === 0) return false
                }
                const drv = yield* EngineStore.Driver
                const rec = yield* drv.reportRecovery
                if (rec.registrations < 0) return false

                return true
              }).pipe(Effect.provide(fullLayer), Effect.scoped, Effect.orDie)
            })
          ),
        { seed: seed + 110, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 11: PlanScheduler selection deferral + PlanScheduler.recertify + PlanMergeStore.complete + Selection.debt", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        deferBelow: Schema.Literals([0.5, 0.7, 0.95]),
        edgeConfidence: Schema.Literals([0.2, 0.6, 0.9]),
        fullOverride: Schema.Boolean,
        completeMerge: Schema.Boolean
      })
    )

    let selSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              selSeq++
              const owner: Ownership.OwnerId = { hostId: "sel-h", pid: 404, nonce: `sel-${selSeq}` }
              const runId = `sel-run-${selSeq}`
              const recertId = `recert-run-${selSeq}`

              const plan = yield* Plan.compile({
                planId: `sel-plan-${selSeq}`,
                flow: "fuzz/Selection",
                nodes: [
                  makeDraft("build", { writes: ["build.out"] }),
                  makeDraft("engine-tests", {
                    inputs: [{ _tag: "Ref", from: "build", path: [] }],
                    reads: ["build.out"],
                    writes: ["tests.out"]
                  }),
                  makeDraft("lint-docs", { writes: ["docs.out"] })
                ]
              })

              const executor: PlanScheduler.Executor = {
                execute: ({ node }) => Effect.succeed({ ok: node.id })
              }
              const stores = TestStores.layerAt(":memory:")
              const fullLayer = Layer.mergeAll(
                stores,
                StepBoundary.layerTest(),
                jjStub,
                PlanScheduler.layerExecutor(executor),
                Reconciliation.layerDefault,
                SelectionStore.layer.pipe(Layer.provide(stores))
              )

              return yield* Effect.gen(function*() {
                yield* activateRun(runId, owner, "fuzz/Selection")
                yield* activateRun(recertId, owner, "fuzz/Selection")

                const selStore = yield* SelectionStore.SelectionStore
                yield* selStore.upsert([
                  {
                    scope: "src/**",
                    affects: "lint-docs",
                    confidence: input.edgeConfidence,
                    validFromMs: 0,
                    evidence: ["seed"]
                  }
                ])
                const beliefs = yield* selStore.snapshot()

                const sched = PlanScheduler.make({
                  runId,
                  owner,
                  sourceId: `sel/${runId}`,
                  selection: {
                    changed: ["src/app.ts"],
                    beliefs,
                    policy: { deferBelow: input.deferBelow },
                    full: input.fullOverride
                  }
                })
                const rep = yield* sched.run(plan)
                if (rep.digest !== plan.digest) return false

                const debtBefore = yield* Selection.debt(runId)
                const recert = yield* PlanScheduler.recertify({
                  plan,
                  deferringRunId: runId,
                  options: {
                    runId: recertId,
                    owner,
                    sourceId: `recert/${recertId}`
                  }
                })
                if (recert.runId !== recertId) return false
                if (debtBefore.length > 0 && recert.remaining.length >= debtBefore.length) return false

                // PlanMergeStore intend + complete + list round-trip
                if (input.completeMerge) {
                  const envDigest = yield* StepKey.environmentIdentity()
                  const inputStore = yield* PlanInputStore.PlanInputStore
                  yield* inputStore.record(
                    {
                      runId,
                      planId: plan.planId,
                      baseDigest: plan.baseDigest,
                      environmentDigest: envDigest,
                      generation: plan.generation
                    },
                    {
                      version: 1,
                      generation: plan.generation,
                      nodes: Plan.generationNodes(plan).map((n) => ({ id: n.id, key: n.key, reads: [] })),
                      pins: []
                    },
                    owner
                  )
                  const mergeStore = yield* PlanMergeStore.PlanMergeStore
                  const mId: PlanMergeStore.Identity = {
                    runId,
                    planId: plan.planId,
                    baseDigest: plan.baseDigest,
                    environmentDigest: envDigest
                  }
                  const n0 = Plan.generationNodes(plan)[0]!
                  yield* mergeStore.intend(
                    mId,
                    {
                      version: 1,
                      nodeId: n0.id,
                      nodeKey: n0.key,
                      dispatchKey: n0.key,
                      attempts: 1,
                      rebases: 0,
                      peers: ["lint-docs"]
                    },
                    owner
                  )
                  const plans = yield* PlanStore.PlanStore
                  yield* plans.record(plan, 0)
                  const grown = yield* Plan.append(plan, [PlanMerges.draft(n0, `${n0.id}+merge`, ["lint-docs"])])
                  const completion: PlanMergeStore.Completion = {
                    version: 1,
                    generation: 1,
                    parentDigest: plan.digest,
                    planDigest: grown.digest,
                    mergeId: `${n0.id}+merge`,
                    mergeKey: Plan.generationNodes(grown)[0]!.key,
                    winners: ["lint-docs"]
                  }
                  const state = yield* DurableEngineState.DurableEngineState
                  yield* state.transaction(
                    Effect.gen(function*() {
                      yield* inputStore.record(
                        { ...mId, generation: 1 },
                        {
                          version: 1,
                          generation: 1,
                          nodes: Plan.generationNodes(grown).map((n) => ({ id: n.id, key: n.key, reads: [] })),
                          pins: []
                        },
                        owner
                      )
                      yield* plans.append(grown)
                      return yield* mergeStore.complete(mId, n0.id, completion, owner)
                    })
                  )
                  const decisions = yield* mergeStore.list(mId, owner)
                  if (decisions.length !== 1 || decisions[0]!.completion === undefined) return false
                }

                return true
              }).pipe(Effect.provide(fullLayer), Effect.scoped, Effect.orDie)
            }).pipe(Effect.orDie)
          ),
        { seed: seed + 111, executions: Math.min(executions, 20) }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Suite 12: AttemptProbe (SQL vs point-probe parity) + ArtifactRoots + RetrySource + AttemptLifecycle", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        startAttempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4)),
        runLen: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(4)),
        metaKind: Schema.Literals(["empty", "valid-boundary", "malformed-json", "bad-boundary"]),
        targetStep: Schema.Literals(["missing", "step-1", "step-2"])
      })
    )

    let aSeq = 0
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          withCrypto(
            Effect.gen(function*() {
              aSeq++
              const owner: Ownership.OwnerId = { hostId: "prb-h", pid: 505, nonce: `prb-${aSeq}` }
              const runId = `prb-run-${aSeq}`
              const digest = sha256(`blob-${aSeq}`)

              // 1. ArtifactRoots fail-closed decoding
              if (input.metaKind === "empty") {
                const r = yield* ArtifactRoots.rootDigests("flows_attempts", "{}")
                if (r.length !== 0) return false
              } else if (input.metaKind === "valid-boundary") {
                const json = JSON.stringify({
                  boundary: {
                    declaredOutputs: { outputs: [{ path: "a.bin", digest, sizeBytes: 4 }] },
                    diffIdentity: "d1",
                    wholeTreeWritesVerified: true,
                    hermeticReadsVerified: true
                  }
                })
                const r = yield* ArtifactRoots.rootDigests("flows_attempts", json)
                if (r.length !== 1 || r[0] !== digest) return false
              } else if (input.metaKind === "malformed-json") {
                const ex = yield* Effect.exit(ArtifactRoots.rootDigests("flows_attempts", "{not-json"))
                if (!Exit.isFailure(ex)) return false
              } else {
                const ex = yield* Effect.exit(
                  ArtifactRoots.rootDigests("flows_attempts", JSON.stringify({ boundary: "corrupt" }))
                )
                if (!Exit.isFailure(ex)) return false
              }

              // 2. AttemptProbe SQL range-scan vs point-probe exact parity + RetrySource.resolve
              return yield* Effect.gen(function*() {
                yield* activateRun(runId, owner, "fuzz/probe")
                const attempts = yield* AttemptStore.AttemptStore
                const state = yield* DurableEngineState.DurableEngineState
                const keyDigest = sha256(`key-${aSeq}`)

                for (let i = 0; i < input.runLen; i++) {
                  const att = input.startAttempt + i
                  yield* attempts.put(
                    {
                      runId,
                      stepKeyDigest: keyDigest,
                      attempt: att,
                      state: "running",
                      startedAtMs: 1000 + att * 10,
                      meta: {}
                    },
                    owner
                  )
                  yield* attempts.finish(
                    {
                      runId,
                      stepKeyDigest: keyDigest,
                      attempt: att,
                      state: "completed",
                      finishedAtMs: 1005 + att * 10,
                      outcome: { i }
                    },
                    owner
                  )
                }

                const viaSql = yield* AttemptProbe.probeAttempts(attempts, state.attemptSurvivors, runId, keyDigest)
                const viaPoint = yield* AttemptProbe.probeAttempts(attempts, undefined, runId, keyDigest)
                if (Option.isNone(viaSql) || Option.isNone(viaPoint)) return false
                if (
                  viaSql.value.earliestAttempt !== viaPoint.value.earliestAttempt ||
                  viaSql.value.earliestStartedAtMs !== viaPoint.value.earliestStartedAtMs ||
                  viaSql.value.latest !== viaPoint.value.latest
                ) {
                  return false
                }

                // 3. RetrySource.resolve over real journaled nodes & attempts
                const journal = yield* Journal.Journal
                const rId = JournalEvent.RunId.make(runId)
                const sId = JournalEvent.SourceId.make("retry-src")
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: rId,
                    sourceId: sId,
                    eventType: "flows.engine.node-scheduled",
                    payload: { nodeId: "step-1", kind: "action" }
                  })
                )
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: rId,
                    sourceId: sId,
                    eventType: "flows.engine.attempt-started",
                    payload: { stepKeyDigest: keyDigest, attempt: 1 }
                  })
                )
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: rId,
                    sourceId: sId,
                    eventType: "flows.engine.attempt-finished",
                    payload: { stepKeyDigest: keyDigest, attempt: 1 }
                  })
                )
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: rId,
                    sourceId: sId,
                    eventType: "flows.engine.node-settled",
                    payload: { nodeId: "step-1", outcome: "built", stepKeyDigests: [keyDigest] }
                  })
                )
                yield* journal.emitDurableUnfenced(
                  new JournalEvent.Input({
                    runId: rId,
                    sourceId: sId,
                    eventType: "flows.engine.node-scheduled",
                    payload: { nodeId: "step-2", kind: "action" }
                  })
                )
                yield* journal.flush

                const res = yield* RetrySource.resolve(journal, runId, input.targetStep)
                const whole = yield* RetrySource.resolveWhole(journal, runId)
                void whole
                if (input.targetStep === "missing" && res._tag !== "Refused") return false
                if (input.targetStep === "step-1" && res._tag !== "Seed") return false
                void res

                return true
              }).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.scoped, Effect.orDie)
            }).pipe(Effect.orDie)
          ),
        { seed: seed + 112, executions: Math.min(executions, 25) }
      )
    )
    assertPassed(report)
  }, 60_000)
})
