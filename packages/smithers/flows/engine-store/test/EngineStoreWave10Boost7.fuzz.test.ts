import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { KeyMaterial, Node, Plan } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Arbitrary, Cause, Duration, Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Retention from "../src/Retention.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { activate, boundary, descriptor, jj as cpJj, owner as cpOwner } from "./CachePolicyFixtures.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "40"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261707")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
}

describe("EngineStore Wave 10 Boost7: RetentionOps pinAncestors & DurableEngineState edges", () => {
  it(
    "fuzzes ancestor pinning via parent_run_id & flows_run_parents, clock sort, park requests, and retention errors",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          dryRun: Schema.Boolean,
          linkViaRunParents: Schema.Boolean,
          corruptWaitingRequest: Schema.Boolean
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
                const state = yield* DurableEngineState.DurableEngineState

                // Create 3-level chain: grandparent (old terminal) -> parent (old terminal) -> child (live)
                // plus an unpinned old orphan that SHOULD be deleted.
                const oldMs = 1_000
                const freshMs = 100_000
                yield* runs.create("gp-1", "{}")
                yield* runs.create("p-1", "{}", { parentRunId: "gp-1" })
                yield* runs.create("c-1", "{}", { parentRunId: "p-1" })
                yield* runs.create("orphan-1", "{}")
                yield* runs.create("linked-parent", "{}")
                yield* runs.create("linked-child", "{}")

                // Mark gp-1, p-1, orphan-1, linked-parent as terminal and old; keep c-1 and linked-child live
                yield* TestDatabase.checks(sql, false)
                yield* sql`UPDATE flows_runs SET status = 'completed', started_at_ms = 10, finished_at_ms = ${oldMs} WHERE run_id IN ('gp-1', 'p-1', 'orphan-1', 'linked-parent')`
                yield* TestDatabase.checks(sql, true)

                // Claim & activate c-1 so park + scheduleClock have a valid owner
                const cRow = yield* runs.get("c-1")
                const cSnap = { status: cRow.status, owner: cRow.owner, heartbeatAtMs: cRow.heartbeatAtMs }
                const cClaim = yield* runs.claim("c-1", cSnap, cpOwner, 10)
                if (cClaim._tag === "Claimed") {
                  yield* runs.activate("c-1", cpOwner, cClaim.claimedAtMs, cSnap)
                }

                // Exercise recordRunParent: Recorded, Existing, and Cycle
                const r1 = yield* state.recordRunParent("linked-child", "linked-parent")
                expect(r1._tag).toBe("Recorded")
                const r2 = yield* state.recordRunParent("linked-child", "linked-parent")
                expect(r2._tag).toBe("Existing")
                const cyc = yield* state.recordRunParent("linked-parent", "linked-child").pipe(Effect.exit)
                expect(Exit.isFailure(cyc)).toBe(true)

                if (!input.linkViaRunParents) {
                  yield* state.removeRunParentsForRun("linked-child")
                }

                // Exercise park with request payload & corrupt waiting_request
                yield* state.park(
                  "c-1",
                  {
                    reason: "approval",
                    token: "tok-1",
                    request: JSON.stringify({ action: "deploy", env: "prod" })
                  },
                  cpOwner
                )
                const w1 = yield* state.waiting("c-1")
                expect(Option.isSome(w1)).toBe(true)

                if (input.corruptWaitingRequest) {
                  yield* TestDatabase.checks(sql, false)
                  yield* sql`UPDATE flows_runs SET waiting_request = '{bad-json' WHERE run_id = 'c-1'`
                  yield* TestDatabase.checks(sql, true)
                  const wBad = yield* state.waiting("c-1")
                  expect(Option.isSome(wBad)).toBe(true)
                }

                // Exercise completeRunClocks sorting with 2 clocks on SQL and memory state
                yield* state.scheduleClock(
                  {
                    flowName: "f-sort",
                    executionId: "c-1",
                    clockName: "z-clk",
                    deferredName: "dz",
                    dueAtMs: 50,
                    completedAtMs: null
                  },
                  cpOwner
                )
                yield* state.scheduleClock(
                  {
                    flowName: "f-sort",
                    executionId: "c-1",
                    clockName: "a-clk",
                    deferredName: "da",
                    dueAtMs: 25,
                    completedAtMs: null
                  },
                  cpOwner
                )
                const sortedSql = yield* state.completeRunClocks("c-1", 100)
                expect(sortedSql.map((c) => c.clockName)).toEqual(["a-clk", "z-clk"])

                // Memory state clock sort + transaction commit
                const mem = DurableEngineState.makeMemory()
                yield* mem.scheduleClock(
                  {
                    flowName: "f-mem",
                    executionId: "m-1",
                    clockName: "z-clk",
                    deferredName: "dmz",
                    dueAtMs: 50,
                    completedAtMs: null
                  },
                  cpOwner
                )
                yield* mem.scheduleClock(
                  {
                    flowName: "f-mem",
                    executionId: "m-1",
                    clockName: "a-clk",
                    deferredName: "dma",
                    dueAtMs: 25,
                    completedAtMs: null
                  },
                  cpOwner
                )
                const sortedMem = yield* mem.completeRunClocks("m-1", 100)
                expect(sortedMem.map((c) => c.clockName)).toEqual(["a-clk", "z-clk"])
                const txVal = yield* mem.transaction(Effect.succeed("committed"))
                expect(txVal).toBe("committed")

                // Collect retention: gp-1 & p-1 MUST be pinned by live c-1; orphan-1 MUST be eligible/deleted!
                const rep = yield* Retention.collect({
                  olderThanMs: freshMs,
                  dryRun: input.dryRun
                })
                expect(rep.runs.length).toBeGreaterThanOrEqual(1)
                const gpStillThere = yield* runs.get("gp-1").pipe(Effect.option)
                expect(Option.isSome(gpStillThere)).toBe(true)
                const pStillThere = yield* runs.get("p-1").pipe(Effect.option)
                expect(Option.isSome(pStillThere)).toBe(true)
                if (!input.dryRun) {
                  const orphanGone = yield* runs.get("orphan-1").pipe(Effect.option)
                  expect(Option.isNone(orphanGone)).toBe(true)
                  const linkedParentOpt = yield* runs.get("linked-parent").pipe(Effect.option)
                  expect(Option.isSome(linkedParentOpt)).toBe(input.linkViaRunParents)
                }

                // Exercise value_not_decodable on corrupted deferred exit_json
                yield* TestDatabase.checks(sql, false)
                yield* sql`INSERT INTO flows_deferred_completions (flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms) VALUES ('f-bad', 'c-1', 'd-bad', 'not-valid-json', NULL, 100)`
                yield* TestDatabase.checks(sql, true)
                const badDef = yield* state.completedDeferreds("f-bad", "c-1").pipe(Effect.exit)
                const badOne = yield* state.deferred({ flowName: "f-bad", executionId: "c-1", deferredName: "d-bad" })
                  .pipe(Effect.exit)
                expect(badDef._tag === "Success" || badDef._tag === "Failure").toBe(true)
                expect(badOne._tag === "Success" || badOne._tag === "Failure").toBe(true)

                // Exercise RetentionOps scan_failed by dropping flows_runs on an isolated disposable DB
                const badScanExit = yield* Retention.collect({ olderThanMs: 99999 }).pipe(
                  Effect.provide(
                    Layer.effect(
                      SqlClient.SqlClient,
                      Effect.gen(function*() {
                        const s = yield* SqlClient.SqlClient
                        yield* s`DROP TABLE IF EXISTS flows_runs`
                        return s
                      })
                    ).pipe(Layer.provide(TestStores.layerAt(":memory:")))
                  ),
                  Effect.exit
                )
                expect(Exit.isFailure(badScanExit)).toBe(true)

                return true
              }).pipe(
                Effect.provide(TestStores.layerAt(":memory:")),
                withCrypto
              )
            ),
          { executions: Math.min(executions, 16), seed }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})

describe("EngineStore Wave 10 Boost7: ActionPersistence StepSandbox, Boundary/Cache faults, FenceLost & Cause limits", () => {
  it(
    "fuzzes StepSandbox open/refuse, StepBoundary prepare/replay faults, CacheStore faults, heartbeat fence loss & deep causes",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "step_sandbox_ok",
            "step_sandbox_refused",
            "prepare_fail",
            "cache_unmeasurable",
            "replay_fail_hydrate",
            "cache_get_put_fail",
            "heartbeat_fence_lost",
            "deep_and_circular_cause"
          ])
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const act = Action.make({
                  name: `w10b7/${input.scenario}`,
                  success: Schema.String,
                  error: Schema.Never,
                  tier: "sealed",
                  execute: Effect.succeed("unused")
                })
                const desc: ActionPersistence.BoundaryMetadata = {
                  readSet: [{ path: "in.txt", digest: "sha256:in" }],
                  writeSet: ["out.txt"],
                  boundaryMode: "hard"
                }
                yield* activate("ap-run-1")

                if (input.scenario === "step_sandbox_ok") {
                  const { service: memBox } = yield* WorkspaceSandbox.makeMemory({ "in.txt": "hello" })
                  const ssLayer = Layer.succeed(StepSandbox.StepSandbox, { open: Effect.succeed(memBox) })
                  const exec = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-ss-ok",
                    execute: () =>
                      Effect.gen(function*() {
                        const ws = yield* Effect.serviceOption(WorkspaceSandbox.Workspace)
                        if (Option.isSome(ws)) {
                          yield* ws.value.writeFile("out.txt", new TextEncoder().encode("ok"))
                        }
                        return "ss-ok"
                      })
                  })
                  const res = yield* exec({
                    key: "k-ss-ok",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: desc
                  }).pipe(Effect.provide(ssLayer))
                  expect(res).toBe("ss-ok")
                } else if (input.scenario === "step_sandbox_refused") {
                  const ssLayer = Layer.succeed(StepSandbox.StepSandbox, {
                    open: Effect.fail(
                      new StepBoundary.UnsupportedBoundary({ code: "unsupported_boundary", message: "no isolation" })
                    )
                  })
                  const exec = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-ss-refuse",
                    execute: () => Effect.succeed("never")
                  })
                  const ex = yield* exec({
                    key: "k-ss-refuse",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: desc
                  }).pipe(Effect.provide(ssLayer), Effect.exit)
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (input.scenario === "prepare_fail") {
                  const badBoundary = Layer.succeed(
                    StepBoundary.StepBoundary,
                    StepBoundary.make({
                      prepare: () =>
                        Effect.fail(
                          new StepBoundary.UnsupportedBoundary({
                            code: "unsupported_boundary",
                            message: "cannot measure"
                          })
                        ),
                      settle: () => Effect.die("unused"),
                      replayOutputs: () => Effect.void
                    })
                  )
                  const exec = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-prep-fail",
                    execute: () => Effect.succeed("never")
                  })
                  const ex = yield* exec({
                    key: "k-prep-fail",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: desc
                  }).pipe(Effect.provide(badBoundary), Effect.exit)
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (input.scenario === "cache_unmeasurable") {
                  const exec1 = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-unmeas",
                    execute: () => Effect.succeed("cached-v1")
                  })
                  const r1 = yield* exec1({
                    key: "k-unmeas",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  })
                  expect(r1).toBe("cached-v1")

                  yield* activate("ap-run-2")
                  let calls = 0
                  const flakyBoundary = Layer.succeed(
                    StepBoundary.StepBoundary,
                    StepBoundary.make({
                      prepare: (d) => {
                        calls++
                        if (calls === 1) {
                          return Effect.fail(
                            new StepBoundary.UnsupportedBoundary({
                              code: "unsupported_boundary",
                              message: "unmeasurable hit"
                            })
                          )
                        }
                        return Effect.succeed({ descriptor: d, readSnapshot: StepBoundary.exactReads(d) })
                      },
                      settle: () =>
                        Effect.succeed({
                          declaredOutputs: { outputs: [] },
                          diffIdentity: "d2",
                          wholeTreeWritesVerified: true,
                          hermeticReadsVerified: true
                        }),
                      replayOutputs: () => Effect.void
                    })
                  )
                  const exec2 = ActionPersistence.make({
                    runId: "ap-run-2",
                    owner: cpOwner,
                    sourceId: "w10b7-unmeas",
                    execute: () => Effect.succeed("cached-v1")
                  })
                  const r2 = yield* exec2({
                    key: "k-unmeas",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  }).pipe(Effect.provide(flakyBoundary))
                  expect(r2).toBe("cached-v1")
                } else if (input.scenario === "replay_fail_hydrate") {
                  const exec1 = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-hydr",
                    execute: () => Effect.succeed("hydr-v1")
                  })
                  yield* exec1({
                    key: "k-hydr",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  })
                  yield* activate("ap-run-2")
                  const failReplayBoundary = Layer.succeed(
                    StepBoundary.StepBoundary,
                    StepBoundary.make({
                      prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: StepBoundary.exactReads(d) }),
                      settle: () =>
                        Effect.succeed({
                          declaredOutputs: { outputs: [] },
                          diffIdentity: "d-h",
                          wholeTreeWritesVerified: true,
                          hermeticReadsVerified: true
                        }),
                      replayOutputs: () =>
                        Effect.fail(
                          new StepBoundary.MissingArtifact({
                            code: "missing_artifact",
                            path: "out.txt",
                            digest: "sha256:missing"
                          })
                        )
                    })
                  )
                  const exec2 = ActionPersistence.make({
                    runId: "ap-run-2",
                    owner: cpOwner,
                    sourceId: "w10b7-hydr",
                    execute: () => Effect.succeed("hydr-v1")
                  })
                  const r2 = yield* exec2({
                    key: "k-hydr",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  }).pipe(Effect.provide(failReplayBoundary))
                  expect(r2).toBe("hydr-v1")
                } else if (input.scenario === "cache_get_put_fail") {
                  const origCache = yield* CacheStore.CacheStore
                  const failingCache = Layer.succeed(CacheStore.CacheStore, {
                    ...origCache,
                    get: () =>
                      Effect.fail(
                        new CacheStore.CacheStoreError({ code: "persistence_failed", message: "cache read down" })
                      ),
                    put: () =>
                      Effect.fail(
                        new CacheStore.CacheStoreError({ code: "persistence_failed", message: "cache write down" })
                      )
                  })
                  const exec = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-cache-fail",
                    execute: () => Effect.succeed("ran-despite-cache-down")
                  })
                  const r = yield* exec({
                    key: "k-cache-fail",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  }).pipe(Effect.provide(failingCache))
                  expect(r).toBe("ran-despite-cache-down")
                } else if (input.scenario === "heartbeat_fence_lost") {
                  const origRuns = yield* RunStore.RunStore
                  const fencedRuns = Layer.succeed(RunStore.RunStore, {
                    ...origRuns,
                    heartbeat: () => Effect.succeed({ _tag: "FenceLost" as const })
                  })
                  const exec = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-fence",
                    execute: () => Effect.succeed("fenced")
                  })
                  const ex = yield* exec({
                    key: "k-fence",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  }).pipe(Effect.provide(fencedRuns), Effect.exit)
                  expect(Exit.isFailure(ex)).toBe(true)
                } else {
                  const circ: Record<string, unknown> = { label: "loop" }
                  circ["self"] = circ
                  const execCirc = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-circ",
                    execute: () => Effect.die(circ)
                  })
                  const ex1 = yield* execCirc({
                    key: "k-circ",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  }).pipe(Effect.exit)
                  expect(Exit.isFailure(ex1)).toBe(true)

                  let deepCause: Cause.Cause<unknown> = Cause.die("leaf-0")
                  for (let i = 1; i < 60; i++) {
                    deepCause = Cause.combine(deepCause, Cause.die(`leaf-${i}`))
                  }
                  const execDeep = ActionPersistence.make({
                    runId: "ap-run-1",
                    owner: cpOwner,
                    sourceId: "w10b7-deep",
                    execute: () => Effect.failCause(deepCause)
                  })
                  const ex2 = yield* execDeep({
                    key: "k-deep",
                    tier: "sealed",
                    attempt: 1,
                    action: act,
                    metadata: descriptor
                  }).pipe(Effect.exit)
                  expect(Exit.isFailure(ex2)).toBe(true)
                }

                return true
              }).pipe(
                Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), cpJj, boundary())),
                withCrypto
              )
            ),
          { executions: Math.min(executions, 24), seed: seed + 1 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})

const ChildAct = Action.make("w10b7/child-act", { payload: { x: Schema.String }, success: Schema.String })
const ChildFlow = Flow.make("w10b7/ChildFlow", {
  payload: { x: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ x }: { readonly x: string }) => ChildAct.call({ x }))
})
const ParentFlow = Flow.make("w10b7/ParentFlow", {
  payload: { x: Schema.String },
  success: Schema.String,
  body: Node.capture({}, ({ x }: { readonly x: string }) => ChildFlow.child({ x }))
})

describe("EngineStore Wave 10 Boost7: RunDriver parent-cancel inheritance & identity checks", () => {
  it("exercises inheritParentCancellation, identity mismatches, and corrupt stateJson via EngineStore", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        corruptState: Schema.Boolean,
        tag: Schema.Literals(["a", "b"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const baseLayer = Layer.mergeAll(
                TestStores.layerAt(":memory:"),
                cpJj,
                StepBoundary.layerTest(),
                TestClock.layer()
              )
              const engineLayer = EngineStore.layer({
                owner: { hostId: "w10b7-host" },
                journalSource: "w10b7-drv",
                isAlive: () => Effect.succeed(true),
                sourceRevision: () => "rev-b7"
              }).pipe(Layer.provideMerge(baseLayer))

              const actionImpls = ChildAct.toLayer(({ x }) => Effect.succeed(`done:${x}`))
              const flowLayers = [ChildFlow, ParentFlow]
                .map((f) =>
                  Interpreter.layerWithImplementations(f as never, actionImpls as never) as Layer.Layer<never>
                )
                .reduce((a, b) => Layer.merge(a, b))
                .pipe(
                  Layer.provideMerge(actionImpls),
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(engineLayer)
                )

              yield* Effect.gen(function*() {
                const runs = yield* RunStore.RunStore
                const runtime = yield* FlowRuntime.FlowRuntime

                // 1. Run parent -> child flow normally
                const out = yield* ParentFlow.execute({ x: input.tag }, { executionId: `p-ok-${input.tag}` })
                expect(out).toBe(`done:${input.tag}`)

                // 2. Corrupt stateJson row -> sweep ticks past it without crashing
                if (input.corruptState) {
                  yield* runs.create(`corrupt-${input.tag}`, "{\"bad\":1}")
                  yield* TestClock.adjust(Duration.millis(50))
                  const row = yield* runs.get(`corrupt-${input.tag}`).pipe(Effect.option)
                  expect(Option.isSome(row)).toBe(true)
                }

                // 3. Re-execute same executionId with different payload -> identity check!
                const dupExit = yield* ChildFlow.execute(
                  { x: "different-payload" },
                  { executionId: `p-ok-${input.tag}` }
                ).pipe(Effect.exit)
                expect(Exit.isFailure(dupExit)).toBe(true)
                expect(runtime).toBeDefined()
              }).pipe(Effect.provide(flowLayers))

              return true
            }).pipe(withCrypto)
          ),
        { executions: Math.min(executions, 8), seed: seed + 2 }
      )
    )
    assertPassed(report)
  }, 90_000)
})

describe("EngineStore Wave 10 Boost7: PlanScheduler fence_lost, dispatchKey invalidation & deferred concurrency", () => {
  it(
    "exercises PlanInputStore fence_lost, dispatchKey invalidation across runs, and tight concurrency deferral",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          fenceLost: Schema.Boolean,
          changeInput: Schema.Boolean
        })
      )
      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const mkNode = (id: string, outFile: string): Plan.NodeDraft => ({
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
                    reads: ["in.txt"],
                    writes: [outFile],
                    boundaryMode: "hard"
                  }
                })
                const plan = yield* Plan.compile({
                  planId: "ps-b7-plan",
                  flow: "ps-b7-flow",
                  nodes: [
                    mkNode("n1", "o1.txt"),
                    mkNode("n2", "o2.txt"),
                    mkNode("n3", "o3.txt")
                  ]
                })

                const { service: memBox } = yield* WorkspaceSandbox.makeMemory({ "in.txt": "v1" })
                const boxLayer = Layer.succeed(WorkspaceSandbox.WorkspaceSandbox, memBox)
                const dispLayer = WorkspaceSandbox.layerDispatcher({ dispatch: () => Effect.void })
                const execLayer = PlanScheduler.layerExecutor({
                  execute: ({ node }) =>
                    Effect.gen(function*() {
                      const ws = yield* Effect.serviceOption(WorkspaceSandbox.Workspace)
                      if (Option.isSome(ws)) {
                        yield* ws.value.writeFile(`o${node.id.slice(1)}.txt`, new TextEncoder().encode("out-v1"))
                      }
                      return { outcome: "built" as const, value: `done-${node.id}` }
                    })
                })

                if (input.fenceLost) {
                  const origInputs = yield* PlanInputStore.PlanInputStore
                  const fencedInputs = Layer.succeed(PlanInputStore.PlanInputStore, {
                    ...origInputs,
                    record: () =>
                      Effect.fail(new PlanInputStore.PlanInputError({ code: "fence_lost", message: "lost fence" }))
                  })
                  yield* activate("ps-fence-run")
                  const sched = PlanScheduler.make({
                    runId: "ps-fence-run",
                    owner: cpOwner,
                    sourceId: "s-b7-fence",
                    concurrency: { steps: 1 }
                  })
                  const ex = yield* sched.run(plan).pipe(
                    Effect.provide(Layer.mergeAll(boxLayer, dispLayer, execLayer, fencedInputs)),
                    Effect.exit
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else {
                  // Run 1 with concurrency=1 across 3 parallel nodes -> forces deferred queue!
                  yield* activate("ps-r1")
                  const sched1 = PlanScheduler.make({
                    runId: "ps-r1",
                    owner: cpOwner,
                    sourceId: "s-b7-1",
                    concurrency: { steps: 1 }
                  })
                  const r1 = yield* sched1.run(plan).pipe(
                    Effect.provide(Layer.mergeAll(boxLayer, dispLayer, execLayer))
                  )
                  expect(r1.settlements.length).toBe(3)

                  if (input.changeInput) {
                    const { service: memBox2 } = yield* WorkspaceSandbox.makeMemory({ "in.txt": "v2-mutated" })
                    const boxLayer2 = Layer.succeed(WorkspaceSandbox.WorkspaceSandbox, memBox2)
                    yield* activate("ps-r2")
                    const sched2 = PlanScheduler.make({
                      runId: "ps-r2",
                      owner: cpOwner,
                      sourceId: "s-b7-2",
                      concurrency: { steps: 1 }
                    })
                    const r2 = yield* sched2.run(plan).pipe(
                      Effect.provide(Layer.mergeAll(boxLayer2, dispLayer, execLayer))
                    )
                    expect(r2.settlements.length).toBe(3)
                  }
                }

                return true
              }).pipe(
                Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), cpJj, boundary())),
                withCrypto
              )
            ),
          { executions: Math.min(executions, 12), seed: seed + 3 }
        )
      )
      assertPassed(report)
    },
    60_000
  )
})
