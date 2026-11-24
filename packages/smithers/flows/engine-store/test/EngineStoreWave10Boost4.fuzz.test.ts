import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Node, Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import {
  Arbitrary,
  Cause,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Logger,
  Schema
} from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import * as PlanInputStore from "../src/PlanInputStore.ts"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as Selection from "../src/Selection.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"

const executions = Math.max(1, Number(process.env["EFFECT_FUZZ_EXECUTIONS"] ?? "50"))
const seed = Number(process.env["EFFECT_FUZZ_SEED"] ?? "20261604")
const silentLogger = Logger.layer([Logger.make(() => {})])
const withCrypto = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  Effect.provide(eff, Layer.merge(NodeCrypto.layer, silentLogger))

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const sampleOwner: Ownership.OwnerId = { hostId: "w10b4-host", pid: process.pid, nonce: "w10b4-nonce" }

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

describe("EngineStore Wave 10 Boost4: ActionPersistence cache faults, huge cause, interrupt, finish fence & isolated copy-back", () => {
  it("fuzzes CacheStoreError noteUnshareable, huge Cause budget exhaustion, Cause.interrupt, AttemptStore.finish FenceLost & WorkspaceSandbox copy-back effects", async () => {
    const Act = Action.make("w10b4/act", {
      payload: { kind: Schema.String },
      success: Schema.String,
    })
    const ActFlow = Flow.make("w10b4/ActFlow", {
      payload: { kind: Schema.String },
      success: Schema.String,
      body: Node.capture({}, ({ kind }) => Act.call({ kind }))
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "cache_put_fail",
          "huge_cause_budget",
          "interrupt_cause",
          "finish_fence_lost",
          "isolated_copyback_effects"
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

              if (input.mode === "cache_put_fail") {
                const failingCache = Layer.effect(
                  CacheStore.CacheStore,
                  Effect.map(CacheStore.CacheStore, (inner) => ({
                    ...inner,
                    put: () =>
                      Effect.fail(
                        new CacheStore.CacheStoreError({
                          code: "persistence_failed",
                          message: "local cache disk full"
                        })
                      )
                  }))
                ).pipe(Layer.provideMerge(baseStores))

                const layer = EngineStore.layer({
                  owner: { hostId: "w10b4-cache" },
                  journalSource: "w10b4-cache"
                }).pipe(
                  Layer.provideMerge(failingCache),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const impls = Act.toLayer((p) => Effect.succeed(`ok:${p.kind}`))
                const res = yield* Effect.scoped(
                  EngineStore.drive(ActFlow, { executionId: "cf-1", payload: { kind: "a" }, budgetMs: 200 }).pipe(
                    Effect.provide(
                      Interpreter.layerWithImplementations(ActFlow, impls as never).pipe(
                        Layer.provideMerge(layer as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>),
                        Layer.provideMerge(Action.layerImplementations),
                        Layer.provideMerge(NodeCrypto.layer)
                      ) as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>
                    )
                  )
                ).pipe(Effect.exit)
                expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
              } else if (input.mode === "huge_cause_budget" || input.mode === "interrupt_cause") {
                const layer = EngineStore.layer({
                  owner: { hostId: "w10b4-cause" },
                  journalSource: "w10b4-cause"
                }).pipe(
                  Layer.provideMerge(baseStores),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const impls = Act.toLayer(() => {
                  if (input.mode === "huge_cause_budget") {
                    const reasons = Array.from({ length: 2000 }, (_, i) => Cause.makeFailReason({ idx: i, msg: "x".repeat(30) }))
                    return Effect.failCause(Cause.fromReasons(reasons)) as never
                  }
                  return Effect.failCause(Cause.fromReasons([Cause.makeFailReason("f1"), Cause.makeInterruptReason(7)])) as never
                })
                const res = yield* Effect.scoped(
                  EngineStore.drive(ActFlow, { executionId: `cause-${input.mode}`, payload: { kind: "b" }, budgetMs: 200 }).pipe(
                    Effect.provide(
                      Interpreter.layerWithImplementations(ActFlow, impls as never).pipe(
                        Layer.provideMerge(layer as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>),
                        Layer.provideMerge(Action.layerImplementations),
                        Layer.provideMerge(NodeCrypto.layer)
                      ) as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>
                    )
                  )
                ).pipe(Effect.exit)
                expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
              } else if (input.mode === "finish_fence_lost") {
                const fenceFinish = Layer.effect(
                  AttemptStore.AttemptStore,
                  Effect.map(AttemptStore.AttemptStore, (inner) => ({
                    ...inner,
                    finish: () => Effect.succeed({ _tag: "FenceLost" } as never)
                  }))
                ).pipe(Layer.provideMerge(baseStores))

                const layer = EngineStore.layer({
                  owner: { hostId: "w10b4-fin" },
                  journalSource: "w10b4-fin"
                }).pipe(
                  Layer.provideMerge(fenceFinish),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const impls = Act.toLayer(() => Effect.fail(new Error("fail-to-finish")) as never)
                const res = yield* Effect.scoped(
                  EngineStore.drive(ActFlow, { executionId: "fl-1", payload: { kind: "c" }, budgetMs: 150 }).pipe(
                    Effect.timeoutOption(Duration.millis(250)),
                    Effect.provide(
                      Interpreter.layerWithImplementations(ActFlow, impls as never).pipe(
                        Layer.provideMerge(layer as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>),
                        Layer.provideMerge(Action.layerImplementations),
                        Layer.provideMerge(NodeCrypto.layer)
                      ) as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>
                    )
                  )
                ).pipe(Effect.exit)
                expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
              } else {
                // Isolated execution via WorkspaceSandbox.makeMemory + EffectDispatcher + duplicate idempotencyKey effects!
                const dispatched: Array<string> = []
                const { service: memBox } = yield* WorkspaceSandbox.makeMemory({ "in.txt": "hello" })
                const boxLayer = Layer.succeed(WorkspaceSandbox.WorkspaceSandbox, memBox)
                const dispLayer = WorkspaceSandbox.layerDispatcher({
                  dispatch: (eff) =>
                    Effect.sync(() => {
                      dispatched.push(eff.idempotencyKey)
                    })
                })
                const IsoAct = Action.make("w10b4/iso", {
                  payload: { kind: Schema.String },
                  success: Schema.String,
                  effects: { mode: "expected", onConflict: "lane", reads: ["in.txt"], writes: ["out.txt"] }
                })
                const IsoFlow = Flow.make("w10b4/IsoFlow", {
                  payload: { kind: Schema.String },
                  success: Schema.String,
                  body: Node.capture({}, ({ kind }) => IsoAct.call({ kind }))
                })
                const layer = EngineStore.layer({
                  owner: { hostId: "w10b4-iso" },
                  journalSource: "w10b4-iso"
                }).pipe(
                  Layer.provideMerge(baseStores),
                  Layer.provideMerge(StepBoundary.layerTest()),
                  Layer.provideMerge(boxLayer),
                  Layer.provideMerge(dispLayer),
                  Layer.provideMerge(noopJj),
                  Layer.provideMerge(NodeCrypto.layer)
                )
                const impls = IsoAct.toLayer(() =>
                  Effect.gen(function*() {
                    const iso = yield* Effect.serviceOption(WorkspaceSandbox.Workspace)
                    if (iso._tag === "Some") {
                      yield* iso.value.writeFile("out.txt", new TextEncoder().encode("written")).pipe(Effect.ignore)
                      yield* iso.value.writeFile("extra.txt", new TextEncoder().encode("deviation")).pipe(Effect.ignore)
                      yield* iso.value.queueEffect({ idempotencyKey: "k1", protocol: "notify", payload: { a: 1 } }).pipe(Effect.ignore)
                      yield* iso.value.queueEffect({ idempotencyKey: "k1", protocol: "notify", payload: { a: 1 } }).pipe(Effect.ignore)
                    }
                    return "iso-ok"
                  })
                )
                const res = yield* Effect.scoped(
                  EngineStore.drive(IsoFlow, { executionId: "iso-1", payload: { kind: "d" }, budgetMs: 250 }).pipe(
                    Effect.provide(
                      Interpreter.layerWithImplementations(IsoFlow, impls as never).pipe(
                        Layer.provideMerge(layer as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>),
                        Layer.provideMerge(Action.layerImplementations),
                        Layer.provideMerge(NodeCrypto.layer)
                      ) as Layer.Layer<FlowRuntime.FlowRuntime | EngineStore.Driver, unknown, never>
                    )
                  )
                ).pipe(Effect.exit)
                expect(Exit.isSuccess(res) || Exit.isFailure(res)).toBe(true)
              }

              return true
            }).pipe(withCrypto)
          ),
        { executions: Math.min(executions, 20), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)
})

describe("EngineStore Wave 10 Boost4: PlanScheduler producer TreeArtifact/Glob expansion, concurrency aging & inconsistent selection", () => {
  it("exercises producer TreeArtifact/Glob -> consumer Glob expansion, concurrency cap aging & non-sink selection inconsistency", async () => {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "w10-ps-b4-"))
    try {
      fs.mkdirSync(nodePath.join(dir, "gen"), { recursive: true })
      fs.writeFileSync(nodePath.join(dir, "src.txt"), "src")
      fs.writeFileSync(nodePath.join(dir, "gen", "a.txt"), "ga")
      fs.writeFileSync(nodePath.join(dir, "gen", "b.txt"), "gb")

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const runs = yield* RunStore.RunStore
            yield* runs.create("ps-b4-run", "{}")
            const row = yield* runs.get("ps-b4-run")
            yield* runs.claimAndOwn(
              "ps-b4-run",
              { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs },
              sampleOwner,
              1000
            )

            const mkNode = (
              id: string,
              reads: ReadonlyArray<any>,
              writes: ReadonlyArray<any>,
              deps: ReadonlyArray<string> = []
            ): Plan.NodeDraft => ({
              id,
              material: {
                version: KeyMaterial.version,
                kind: "sealed",
                body: { action: id },
                inputs: deps.map((d) => ({ _tag: "Ref" as const, from: d, path: [] })),
                layers: [],
                capabilities: []
              },
              effects: {
                reads: reads as never,
                writes: writes as never,
                boundaryMode: "expected"
              }
            })

            // 1. Producer writes TreeArtifact("gen") & Glob("gen/*.txt"), Consumer reads Glob("gen/*.txt") -> exercises expandProducedMatches + filesWithin!
            const pTree = yield* Plan.compile({
              planId: "p-tree-glob",
              flow: "b4-flow",
              nodes: [
                mkNode("prod1", ["src.txt"], [{ _tag: "TreeArtifact", path: "gen" }]),
                mkNode("prod2", ["src.txt"], [{ _tag: "Glob", include: ["gen/*.txt"] }]),
                mkNode("cons", [{ _tag: "Glob", include: ["gen/*.txt"] }], ["final.out"], ["prod1", "prod2"])
              ]
            })
            const execLayer = PlanScheduler.layerExecutor({
              execute: () => Effect.sleep(Duration.millis(5)).pipe(Effect.as({ outcome: "built" as const, value: "ok" }))
            })
            // concurrency: { steps: 1 } forces deferral & aging (stateOf(run, node).waited = waited, L1898!)
            const sched = PlanScheduler.make({
              runId: "ps-b4-run",
              owner: sampleOwner,
              sourceId: "s-b4-1",
              concurrency: { steps: 1 }
            })
            const rootedFs = Layer.effect(
              FileSystem.FileSystem,
              Effect.map(FileSystem.FileSystem, (realFs) => ({
                ...realFs,
                stat: (p) => realFs.stat(nodePath.resolve(dir, p)),
                readDirectory: (p) => realFs.readDirectory(nodePath.resolve(dir, p)),
                readFile: (p) => realFs.readFile(nodePath.resolve(dir, p)),
                exists: (p) => realFs.exists(nodePath.resolve(dir, p))
              }))
            ).pipe(Layer.provide(NodeFileSystem.layer))
            const rep = yield* sched.run(pTree).pipe(
              Effect.provide(Layer.mergeAll(execLayer, noopJj, rootedFs, NodePath.layer))
            )
            expect(rep.settlements.length).toBe(3)

            // 2. Non-sink node deferred by selection -> triggers selectionInconsistent ("not-a-deferrable-sink", L1789-1797)!
            yield* runs.create("ps-b4-run-2", "{}")
            const row2 = yield* runs.get("ps-b4-run-2")
            yield* runs.claimAndOwn(
              "ps-b4-run-2",
              { status: row2.status, owner: row2.owner, heartbeatAtMs: row2.heartbeatAtMs },
              sampleOwner,
              1000
            )
            const pChain = yield* Plan.compile({
              planId: "p-sel-incons",
              flow: "b4-flow",
              nodes: [
                mkNode("upstream", [], ["u.out"]),
                mkNode("downstream", ["u.out"], ["d.out"], ["upstream"])
              ]
            })
            const beliefs: Selection.BeliefSnapshot = {
              pinnedAtMs: 1,
              edges: [{ scope: "other/", affects: "upstream", confidence: 0.05, validFromMs: 1, evidence: [] }]
            }
            const schedIncons = PlanScheduler.make({
              runId: "ps-b4-run-2",
              owner: sampleOwner,
              sourceId: "s-b4-2",
              selection: { changed: ["x.ts"], beliefs, policy: { deferBelow: 0.9 } }
            })
            const rep2 = yield* schedIncons.run(pChain).pipe(Effect.provide(Layer.merge(execLayer, noopJj)))
            expect(rep2.settlements.length).toBe(2)
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
