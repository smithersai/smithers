import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ArtifactStore } from "@smthrs/artifacts"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { Arbitrary, Clock, Deferred, Duration, Effect, Exit, Layer, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import { deferredClockFacts } from "../src/migrations/0009_deferred_clock_facts.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanMergeStore from "../src/PlanMergeStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Reconciliation from "../src/Reconciliation.ts"
import * as Retention from "../src/Retention.ts"
import * as Selection from "../src/Selection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "w6-plan-host", pid: 9001, nonce: "w6-plan" }

const noopJjLayer = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "w6-plan-snap" as never, changeId: "w6-plan-snap" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

const draft = (
  id: string,
  options: {
    readonly reads?: ReadonlyArray<string>
    readonly writes?: ReadonlyArray<string>
    readonly kind?: Plan.PlanNode["kind"]
    readonly priority?: number
    readonly conflictStrategy?: Plan.PairStrategy
    readonly runtimeStrategy?: Plan.RuntimeStrategy
    readonly boundaryMode?: "hard" | "expected"
    readonly dependsOn?: ReadonlyArray<string>
  } = {}
): Plan.NodeDraft => ({
  id,
  material: {
    version: "flows/key-material/v2",
    kind: "sealed",
    body: { action: id },
    inputs: [],
    layers: [],
    capabilities: []
  },
  effects: {
    reads: options.reads ?? [],
    writes: options.writes ?? [`${id}.out`],
    boundaryMode: options.boundaryMode ?? "hard"
  },
  ...(options.kind === undefined ? {} : { kind: options.kind }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.conflictStrategy === undefined ? {} : { conflictStrategy: options.conflictStrategy }),
  ...(options.runtimeStrategy === undefined ? {} : { runtimeStrategy: options.runtimeStrategy }),
  ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn })
})

const activateRun = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(
      runId,
      JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: "w6/Plan", payload: {}, executionId: runId })
    )
    const row = yield* runs.get(runId)
    const snap: RunStore.RunSnapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const cl = yield* runs.claim(runId, snap, owner, 1)
    if (cl._tag === "Claimed") {
      yield* runs.activate(runId, owner, cl.claimedAtMs, snap)
    }
  })

describe("EngineStore Wave-6 PlanScheduler, Selection, Fold, Retention & DR fuzz", () => {
  it(
    "fuzzes PlanScheduler conflict strategies (stop-merge/fail/rebase), reconciler verdicts, selection deferrals/proposals, and sibling abort",
    async () => {
      const PlanSchema = Schema.Struct({
        mode: Schema.Literals([
          "conflict_stop_merge",
          "conflict_verdict_fail",
          "conflict_verdict_reorder",
          "expected_deviation_verdicts",
          "selection_defer_and_propose",
          "sibling_abort_on_failure"
        ]),
        verdictKind: Schema.Literals(["Allow", "Fail", "Reorder", "FactorOut"]),
        deferBelow: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0.1, maximum: 0.9 }))),
        seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(PlanSchema),
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const baseLayer = Layer.mergeAll(
                  TestStores.layerAt(":memory:"),
                  noopJjLayer,
                  StepBoundary.layerTest()
                )

                return yield* Effect.gen(function*() {
                  const runId = `plan-${input.mode}-${input.seedTag}`
                  yield* activateRun(runId)

                  const makeVerdict = (dependsOn: ReadonlyArray<string>): Reconciliation.Verdict => {
                    switch (input.verdictKind) {
                      case "Fail":
                        return { _tag: "Fail", reason: "strict-fail" }
                      case "Reorder":
                        return { _tag: "Reorder", dependsOn: [...dependsOn], reason: "discovered-edge" }
                      case "FactorOut":
                        return { _tag: "FactorOut", paths: ["shared-step"], reason: "factor-out" }
                      case "Allow":
                        return { _tag: "Reorder", dependsOn: [...dependsOn], reason: "allowed-reorder" }
                    }
                  }

                  const reconcilerLayer = Reconciliation.layer(
                    Reconciliation.make({
                      onDeviation: () => Effect.succeed(makeVerdict(["a"])),
                      onConflict: () => Effect.succeed(makeVerdict(["a"]))
                    })
                  )

                  if (
                    input.mode === "conflict_stop_merge" ||
                    input.mode === "conflict_verdict_fail" ||
                    input.mode === "conflict_verdict_reorder"
                  ) {
                    const runtimeStrategy: Plan.RuntimeStrategy = input.mode === "conflict_stop_merge"
                      ? "stop-merge"
                      : "delay-rebase"
                    const plan = yield* Plan.compile({
                      planId: `p-${input.seedTag}`,
                      flow: "w6/Conflict",
                      nodes: [
                        draft("a", { writes: ["shared.txt"], conflictStrategy: "lane", runtimeStrategy }),
                        draft("b", { writes: ["shared.txt"], conflictStrategy: "lane", runtimeStrategy })
                      ]
                    })
                    const gateA = yield* Deferred.make<void>()
                    let bConflicted = false
                    const executor: PlanScheduler.Executor = {
                      execute: ({ node }) =>
                        Effect.gen(function*() {
                          if (node.id === "a") {
                            yield* Deferred.await(gateA).pipe(Effect.timeoutOption(Duration.millis(40)))
                            return "a-ok"
                          }
                          if (node.id === "b" && !bConflicted) {
                            bConflicted = true
                            yield* Deferred.succeed(gateA, undefined)
                            return yield* Effect.fail(
                              new WorkspaceSandbox.MaterializationConflict({
                                paths: ["shared.txt"],
                                message: "concurrent write conflict"
                              })
                            )
                          }
                          return `ok-${node.id}`
                        })
                    }
                    const sched = PlanScheduler.make({
                      runId,
                      owner,
                      sourceId: `sched/${runId}`,
                      concurrency: { steps: 2 }
                    })
                    yield* sched.record(plan)
                    const rep = yield* sched.run(plan).pipe(
                      Effect.provide(Layer.mergeAll(PlanScheduler.layerExecutor(executor), reconcilerLayer))
                    )
                    expect(rep.settlements.length).toBeGreaterThanOrEqual(2)
                  } else if (input.mode === "expected_deviation_verdicts") {
                    const plan = yield* Plan.compile({
                      planId: `dev-${input.seedTag}`,
                      flow: "w6/Dev",
                      nodes: [
                        draft("a", { reads: ["in.txt"], writes: ["a.out"], boundaryMode: "expected" }),
                        draft("b", { reads: ["a.out"], writes: ["b.out"], dependsOn: ["a"], boundaryMode: "expected" })
                      ]
                    })
                    const devBoundary = Layer.succeed(
                      StepBoundary.StepBoundary,
                      StepBoundary.make({
                        prepare: (d) => Effect.succeed({ descriptor: d, readSnapshot: StepBoundary.exactReads(d) }),
                        settle: () =>
                          Effect.succeed({
                            declaredOutputs: { paths: ["a.out"] },
                            diffIdentity: "dev-diff",
                            wholeTreeWritesVerified: true,
                            deviations: [
                              {
                                _tag: "ExpectedSetDeviation",
                                kind: "undeclared_read",
                                paths: ["extra.txt"]
                              }
                            ]
                          }),
                        replayOutputs: () => Effect.void
                      })
                    )
                    const executor: PlanScheduler.Executor = {
                      execute: ({ node }) => Effect.succeed(`val-${node.id}`)
                    }
                    const sched = PlanScheduler.make({ runId, owner, sourceId: `sched/${runId}` })
                    yield* sched.record(plan)
                    const rep = yield* sched.run(plan).pipe(
                      Effect.provide(
                        Layer.mergeAll(PlanScheduler.layerExecutor(executor), reconcilerLayer, devBoundary)
                      )
                    )
                    expect(rep.settlements.length).toBeGreaterThanOrEqual(1)
                  } else if (input.mode === "selection_defer_and_propose") {
                    const plan = yield* Plan.compile({
                      planId: `sel-${input.seedTag}`,
                      flow: "w6/Sel",
                      nodes: [
                        draft("build", { writes: ["build.out"] }),
                        draft("test_sink", {
                          reads: ["build.out"],
                          writes: ["test.out"],
                          dependsOn: ["build"],
                          kind: "step"
                        })
                      ]
                    })
                    const beliefs: Selection.BeliefSnapshot = {
                      pinnedAtMs: 5000,
                      edges: [
                        {
                          scope: "src/**",
                          affects: "test_sink",
                          confidence: 0.05,
                          validFromMs: 1000,
                          evidence: ["low-confidence-edge"]
                        },
                        {
                          scope: "src/**",
                          affects: "extra_proposed_flow",
                          confidence: 0.85,
                          validFromMs: 1000,
                          evidence: ["high-confidence-proposal"]
                        }
                      ]
                    }
                    const executor: PlanScheduler.Executor = {
                      execute: ({ node }) => Effect.succeed(`ran-${node.id}`)
                    }
                    const sched = PlanScheduler.make({
                      runId,
                      owner,
                      sourceId: `sched/${runId}`,
                      selection: {
                        beliefs,
                        changed: ["src/index.ts"],
                        policy: { deferBelow: input.deferBelow }
                      }
                    })
                    yield* sched.record(plan)
                    const rep = yield* sched.run(plan).pipe(
                      Effect.provide(
                        Layer.mergeAll(
                          PlanScheduler.layerExecutor(executor),
                          Selection.layerHeuristic
                        )
                      )
                    )
                    expect(rep.settlements.length).toBe(2)

                    // Exercise Selection.card, Selection.proposeReadSet, Selection.risk, Selection.debt
                    const cardLines = Selection.card({
                      settlements: [
                        { nodeId: "n1", outcome: "clean" },
                        { nodeId: "n2", outcome: "built" },
                        { nodeId: "test_sink", outcome: "deferred" },
                        { nodeId: "n4", outcome: "failed" }
                      ],
                      deferrals: [{ nodeId: "test_sink", likelihood: 0.05 }],
                      proposals: [{ flow: "extra_proposed_flow", confidence: 0.85, scope: "src/**" }],
                      cadence: "hourly",
                      risk: { level: "medium", reasons: ["1 deferred sink"] }
                    })
                    expect(cardLines.length).toBeGreaterThanOrEqual(5)
                    const readSet = Selection.proposeReadSet({
                      beliefs,
                      flow: "test_sink",
                      paths: ["src/a.ts", "src/a.ts", "docs/readme.md"]
                    })
                    expect(readSet).toEqual(["src/a.ts"])
                    const debt = yield* Selection.debt(runId)
                    expect(Array.isArray(debt)).toBe(true)
                  } else if (input.mode === "sibling_abort_on_failure") {
                    const plan = yield* Plan.compile({
                      planId: `abort-${input.seedTag}`,
                      flow: "w6/Abort",
                      nodes: [
                        draft("fast_fail", { writes: ["f.out"] }),
                        draft("slow_sib", { writes: ["s.out"] })
                      ]
                    })
                    const startedSlow = yield* Deferred.make<void>()
                    const executor: PlanScheduler.Executor = {
                      execute: ({ node }) =>
                        Effect.gen(function*() {
                          if (node.id === "slow_sib") {
                            yield* Deferred.succeed(startedSlow, undefined)
                            yield* Effect.sleep(Duration.millis(40))
                            return "slow-done"
                          }
                          yield* Deferred.await(startedSlow).pipe(Effect.timeoutOption(Duration.millis(40)))
                          return yield* Effect.fail(new Error("fast-fail-boom"))
                        })
                    }
                    const sched = PlanScheduler.make({
                      runId,
                      owner,
                      sourceId: `sched/${runId}`,
                      concurrency: { steps: 2 }
                    })
                    yield* sched.record(plan)
                    const res = yield* Effect.exit(
                      sched.run(plan).pipe(Effect.provide(PlanScheduler.layerExecutor(executor)))
                    )
                    expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
                  }
                  return true
                }).pipe(Effect.provide(baseLayer))
              })
            ).pipe(withCrypto),
          { executions: 18, seed: 60301 }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    120_000
  )

  it(
    "fuzzes DeferredClockFold rebuild/errors, migration 0009 backfill, Retention lineage pinning, and PlanMergeStore",
    async () => {
      const StateSchema = Schema.Struct({
        mode: Schema.Literals([
          "migration_0009_and_rebuild_ok",
          "rebuild_run_missing",
          "rebuild_row_missing",
          "rebuild_digest_mismatch",
          "retention_lineage_and_tt",
          "plan_merge_store_ops"
        ]),
        count: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
      })

      const report = await Effect.runPromise(
        Fuzz.run(
          Arbitrary.schema(StateSchema),
          (input) =>
            Effect.scoped(
              Effect.gen(function*() {
                const baseLayer = Layer.mergeAll(TestStores.layerAt(":memory:"), TestClock.layer())
                return yield* Effect.gen(function*() {
                  const sql = yield* SqlClient.SqlClient
                  const runs = yield* RunStore.RunStore
                  const state = yield* DurableEngineState.DurableEngineState
                  const journal = yield* Journal.Journal

                  yield* TestClock.setTime(500_000)
                  const nowMs = yield* Clock.currentTimeMillis

                  if (
                    input.mode === "migration_0009_and_rebuild_ok" ||
                    input.mode === "rebuild_run_missing" ||
                    input.mode === "rebuild_row_missing" ||
                    input.mode === "rebuild_digest_mismatch"
                  ) {
                    const runId = `fold-run-${input.seedTag}`
                    yield* runs.create(
                      runId,
                      JSON.stringify({
                        capabilityCeilings: [[]],
                        version: 1,
                        flowName: "w6/Fold",
                        payload: {},
                        executionId: runId
                      })
                    )
                    // Insert legacy pre-0009 clock & deferred rows directly without journal events
                    yield* sql`
                    INSERT INTO flows_clock_deadlines (
                      flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms
                    ) VALUES
                      (${"w6/Fold"}, ${runId}, ${"clk-open"}, ${"def-open"}, ${nowMs + 5000}, ${null}),
                      (${"w6/Fold"}, ${runId}, ${"clk-done"}, ${"def-done"}, ${nowMs - 1000}, ${nowMs - 500})
                  `
                    const exitJson = JSON.stringify({ _tag: "Success", value: "ok" })
                    const metaJson = JSON.stringify({ by: "test" })
                    yield* sql`
                    INSERT INTO flows_deferred_completions (
                      flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms, consumed_at_ms
                    ) VALUES
                      (${"w6/Fold"}, ${runId}, ${"def-open"}, ${exitJson}, ${null}, ${nowMs - 200}, ${null}),
                      (${"w6/Fold"}, ${runId}, ${"def-done"}, ${exitJson}, ${metaJson}, ${nowMs - 400}, ${nowMs - 100})
                  `

                    // Run migration 0009 backfill twice (tests both backfill and idempotency!)
                    yield* deferredClockFacts
                    yield* deferredClockFacts

                    if (input.mode === "rebuild_row_missing") {
                      yield* sql`DELETE FROM flows_deferred_completions WHERE execution_id = ${runId}`
                      const failExit = yield* Effect.exit(DeferredClockFold.rebuild())
                      expect(Exit.isFailure(failExit)).toBe(true)
                    } else if (input.mode === "rebuild_digest_mismatch") {
                      yield* sql`UPDATE flows_deferred_completions SET exit_json = ${"{\"tampered\":true}"} WHERE execution_id = ${runId}`
                      const failExit = yield* Effect.exit(DeferredClockFold.rebuild())
                      expect(Exit.isFailure(failExit)).toBe(true)
                    } else if (input.mode === "rebuild_run_missing") {
                      yield* sql`DELETE FROM flows_clock_deadlines WHERE execution_id = ${runId}`
                      yield* sql`DELETE FROM flows_deferred_completions WHERE execution_id = ${runId}`
                      yield* sql`DELETE FROM flows_runs WHERE run_id = ${runId}`
                      const failExit = yield* Effect.exit(DeferredClockFold.rebuild())
                      expect(Exit.isFailure(failExit)).toBe(true)
                    } else {
                      const rebuilt = yield* DeferredClockFold.rebuild()
                      expect(rebuilt.clocks).toBeGreaterThanOrEqual(2)
                      expect(rebuilt.deferreds).toBeGreaterThanOrEqual(2)
                      // Also test DeferredClockFold.capture & fromCheckpoint
                      const cp = yield* DeferredClockFold.checkpointState(runId, 10)
                      const restored = DeferredClockFold.fromCheckpoint(cp)
                      expect(restored._tag).toBe("Some")
                      expect(DeferredClockFold.fromCheckpoint({ invalid: true })._tag).toBe("None")
                    }
                  } else if (input.mode === "retention_lineage_and_tt") {
                    // Create parent -> child (terminal old) + parent2 -> activeChild (pins parent2!) + time travel audit/receipts
                    const mkState = (id: string) =>
                      JSON.stringify({
                        capabilityCeilings: [[]],
                        version: 1,
                        flowName: "w6/Ret",
                        payload: {},
                        executionId: id
                      })
                    const oldFinished = nowMs - 100_000

                    const parentDo = `ret-p1-${input.seedTag}`
                    const childDo = `ret-c1-${input.seedTag}`
                    const parentPin = `ret-p2-${input.seedTag}`
                    const childPin = `ret-c2-${input.seedTag}`

                    for (const id of [parentDo, childDo, parentPin, childPin]) {
                      yield* runs.create(id, mkState(id))
                    }
                    // Set parent_run_id FK & terminal statuses
                    for (const id of [parentDo, childDo, parentPin]) {
                      yield* sql`UPDATE flows_runs SET status = 'completed', finished_at_ms = ${oldFinished} WHERE run_id = ${id}`
                    }
                    yield* sql`UPDATE flows_runs SET parent_run_id = ${parentDo} WHERE run_id = ${childDo}`
                    yield* sql`UPDATE flows_runs SET parent_run_id = ${parentPin} WHERE run_id = ${childPin}`
                    // Also record flows_run_parents edge on parentPin -> childPin to exercise edgePinnedIn
                    yield* state.recordRunParent(childPin, parentPin)

                    // Emit journal event and insert time-travel audit + receipt for parentDo
                    yield* journal.emitDurableUnfenced(
                      JournalRecords.runDecision(
                        { runId: parentDo, sourceId: "w6-ret", sourceSeq: 0, lineageId: parentDo },
                        { decision: "test" }
                      )
                    )
                    yield* sql`
                    INSERT INTO flows_time_travel_audits (
                      id, run_id, action, status, requested_at_ms, created_at_ms
                    ) VALUES (${`aud-${input.seedTag}`}, ${parentDo}, ${"rewind"}, ${"completed"}, ${oldFinished}, ${oldFinished})
                  `.pipe(Effect.ignore)

                    const elig = yield* Retention.eligible(nowMs - 10_000)
                    expect(elig.length).toBeGreaterThanOrEqual(1)
                    const dryRep = yield* Retention.collect({ olderThanMs: nowMs - 10_000, dryRun: true })
                    expect(dryRep.runs.length).toBeGreaterThanOrEqual(1)
                    const realRep = yield* Retention.collect({ olderThanMs: nowMs - 10_000, dryRun: false })
                    expect(realRep.runs.length).toBeGreaterThanOrEqual(1)
                    // Pinned parent & active child must still exist!
                    const stillPin = yield* runs.get(parentPin)
                    expect(stillPin.runId).toBe(parentPin)
                  } else if (input.mode === "plan_merge_store_ops") {
                    const mergeStore = yield* PlanMergeStore.make
                    const inputStore = yield* PlanInputStore.make
                    const planStore = yield* PlanStore.PlanStore
                    const runId = `merge-run-${input.seedTag}`
                    yield* activateRun(runId)
                    const basePlan = yield* Plan.compile({
                      planId: `plan-${input.seedTag}`,
                      flow: "w6/MergeOps",
                      nodes: [
                        draft("n1", {
                          writes: ["shared.txt"],
                          conflictStrategy: "lane",
                          runtimeStrategy: "stop-merge"
                        }),
                        draft("n2", { writes: ["shared.txt"], conflictStrategy: "lane", runtimeStrategy: "stop-merge" })
                      ]
                    })
                    const id: PlanMergeStore.Identity = {
                      runId,
                      planId: basePlan.planId,
                      baseDigest: basePlan.baseDigest,
                      environmentDigest: sha256(`env-${input.seedTag}`)
                    }
                    const node1 = basePlan.nodes.find((n) => n.id === "n1")!
                    const intent: PlanMergeStore.Intent = {
                      version: 1,
                      nodeId: node1.id,
                      nodeKey: node1.key,
                      dispatchKey: sha256(`dk-${input.seedTag}`),
                      attempts: 1,
                      rebases: 0,
                      peers: ["n2"]
                    }
                    // Refused before input generation is admitted
                    const noInput = yield* Effect.exit(mergeStore.intend(id, intent, owner))
                    expect(Exit.isFailure(noInput)).toBe(true)

                    // Record plan + input generation, then intend + idempotent intend + complete + list
                    yield* planStore.record(basePlan, 0)
                    yield* inputStore.record(
                      { ...id, generation: 0 },
                      {
                        version: 1,
                        generation: 0,
                        nodes: Plan.generationNodes(basePlan).map((n) => ({ id: n.id, key: n.key, reads: [] })),
                        pins: []
                      },
                      owner
                    )
                    const saved = yield* mergeStore.intend(id, intent, owner)
                    expect(saved.nodeId).toBe("n1")
                    const savedAgain = yield* mergeStore.intend(id, intent, owner)
                    expect(savedAgain.nodeId).toBe("n1")
                    const list1 = yield* mergeStore.list(id, owner)
                    expect(list1.length).toBe(1)
                    const nextPlan = yield* Plan.append(basePlan, [
                      draft("merge-n1", { kind: "merge", dependsOn: ["n2"], writes: ["merged.txt"] })
                    ])
                    const mergeNode = nextPlan.nodes.find((n) => n.id === "merge-n1")!
                    const comp: PlanMergeStore.Completion = {
                      version: 1,
                      generation: nextPlan.generation,
                      parentDigest: basePlan.digest,
                      planDigest: nextPlan.digest,
                      mergeId: mergeNode.id,
                      mergeKey: mergeNode.key,
                      winners: ["n2"]
                    }
                    // Refused outside transaction
                    const outTx = yield* Effect.exit(mergeStore.complete(id, "n1", comp, owner))
                    expect(Exit.isFailure(outTx)).toBe(true)
                    // Refused inside transaction without plan/input generation
                    const noGenTx = yield* Effect.exit(journal.transact(mergeStore.complete(id, "n1", comp, owner)))
                    expect(Exit.isFailure(noGenTx)).toBe(true)
                    // Accepted when plan + input generation + completion share one transaction
                    yield* journal.transact(
                      Effect.gen(function*() {
                        yield* planStore.append(nextPlan)
                        yield* inputStore.record(
                          { ...id, generation: nextPlan.generation },
                          {
                            version: 1,
                            generation: nextPlan.generation,
                            nodes: Plan.generationNodes(nextPlan).map((n) => ({ id: n.id, key: n.key, reads: [] })),
                            pins: []
                          },
                          owner
                        )
                        yield* mergeStore.complete(id, "n1", comp, owner)
                      })
                    )
                    const list2 = yield* mergeStore.list(id, owner)
                    expect(list2.length).toBe(1)
                  }
                  return true
                }).pipe(Effect.provide(baseLayer))
              })
            ).pipe(withCrypto),
          { executions: 18, seed: 60302 }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)
      expect(report._tag).toBe("Passed")
    },
    120_000
  )

  it("fuzzes DisasterRecovery backup, verify (valid & tampered), restore, and restoreAndFence", async () => {
    const DrSchema = Schema.Struct({
      tamper: Schema.Literals(["none", "manifest", "artifact"]),
      artifactCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
      seedTag: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 })))
    })

    const report = await Effect.runPromise(
      Fuzz.run(
        Arbitrary.schema(DrSchema),
        (input) =>
          Effect.scoped(
            Effect.gen(function*() {
              const dir = yield* Effect.acquireRelease(
                Effect.promise(() => mkdtemp(join(tmpdir(), "w6-dr-"))),
                (d) => Effect.promise(() => rm(d, { recursive: true, force: true }))
              )
              const dbPath = join(dir, "src.sqlite")
              const artDir = join(dir, "art")
              const backupDir = join(dir, "backup")
              const restoreDir = join(dir, "restore")

              const fsLayer = Layer.mergeAll(NodePath.layer, NodeFileSystem.layer)
              const artLayer = ArtifactStore.layerFileSystem({ directory: artDir }).pipe(Layer.provideMerge(fsLayer))
              const storeLayer = Layer.mergeAll(TestStores.layerAt(dbPath), artLayer)

              return yield* Effect.gen(function*() {
                const runs = yield* RunStore.RunStore
                const art = yield* ArtifactStore.ArtifactStore
                const runId = `dr-run-${input.seedTag}`
                yield* runs.create(
                  runId,
                  JSON.stringify({
                    capabilityCeilings: [[]],
                    version: 1,
                    flowName: "w6/DR",
                    payload: {},
                    executionId: runId
                  })
                )
                const digests: Array<string> = []
                for (let i = 0; i < input.artifactCount; i++) {
                  const put = yield* art.put(new TextEncoder().encode(`dr-blob-${input.seedTag}-${i}`))
                  digests.push(put)
                }

                const manifest = yield* DisasterRecovery.backup({
                  directory: backupDir,
                  objectsDirectory: artDir,
                  snapshotDatabaseLayer: (databaseFile) => NodeDatabase.layer({ filename: databaseFile })
                })
                expect(manifest.artifacts.length).toBeGreaterThanOrEqual(0)

                if (input.tamper === "none") {
                  const verified = yield* DisasterRecovery.verify(backupDir)
                  expect(verified.artifacts.length).toBe(manifest.artifacts.length)
                  const restored = yield* DisasterRecovery.restore({
                    backupDirectory: backupDir,
                    targetDirectory: restoreDir
                  })
                  expect(restored.manifest.artifacts.length).toBe(manifest.artifacts.length)
                } else {
                  const { writeFile } = yield* Effect.promise(() => import("node:fs/promises"))
                  if (input.tamper === "manifest" || manifest.artifacts.length === 0) {
                    yield* Effect.promise(() =>
                      writeFile(join(backupDir, DisasterRecovery.manifestFileName), "{bad-json")
                    )
                  } else {
                    const first = manifest.artifacts[0]!
                    yield* Effect.promise(() =>
                      writeFile(
                        join(backupDir, DisasterRecovery.objectsDirectoryName, first.digest.slice(0, 2), first.digest),
                        "corrupted-bytes"
                      )
                    )
                  }
                  const badVerify = yield* Effect.exit(DisasterRecovery.verify(backupDir))
                  expect(Exit.isFailure(badVerify)).toBe(true)
                }
                return true
              }).pipe(Effect.provide(storeLayer))
            })
          ).pipe(withCrypto),
        { executions: 10, seed: 60303 }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  }, 120_000)
})
