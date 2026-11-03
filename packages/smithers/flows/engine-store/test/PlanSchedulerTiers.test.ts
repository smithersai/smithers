import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { Sha256 } from "@smthrs/crypto"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Jj } from "@smthrs/kernel"
import { KeyMaterial, Plan } from "@smthrs/plan"
import { PlanStore } from "@smthrs/plan-store"
import { AttemptStore, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Clock, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { join } from "node:path"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "tier-test", pid: 1, nonce: "tier-test" }

const activate = (runId: string) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    const claim = yield* runs.claimAndOwn(
      runId,
      { status: "pending", owner: null, heartbeatAtMs: null },
      owner,
      yield* Clock.currentTimeMillis
    )
    expect(claim._tag).toBe("Activated")
  })

const draft = (id: string, tier: "compensable" | "irreversible"): Plan.NodeDraft => ({
  id,
  material: {
    version: KeyMaterial.version,
    kind: tier,
    body: { operation: "same" },
    inputs: [],
    layers: [],
    capabilities: []
  },
  effects: { reads: [], writes: [], boundaryMode: "hard" }
})

const schedulerFor = (runId: string) => PlanScheduler.make({ runId, owner, sourceId: `tier-test/${runId}` })

const jjLayer = (events: Array<string>) =>
  Layer.succeed(
    Jj.Jj,
    Jj.make({
      snapshot: () =>
        Effect.sync(() => {
          events.push("snapshot")
          return { commitId: "tier-snapshot" as never, changeId: "tier-snapshot" as never }
        }),
      restore: (id) =>
        Effect.sync(() => {
          events.push(`restore:${id}`)
        }),
      diff: () => Effect.succeed(""),
      workspaceAdd: () => Effect.void,
      workspaceForget: () => Effect.void,
      status: () => Effect.succeed("")
    })
  )

describe("authored tiers through compilation and durable scheduling", () => {
  for (const tier of ["compensable", "irreversible"] as const) {
    it.effect(`${tier} executes once per run, replays within that run, and never publishes shared cache`, () =>
      Effect.gen(function*() {
        const Operation = Action.make(`tier-test/${tier}`, { payload: {}, success: Schema.String, tier })
        const Workflow = Flow.make(`tier-test/flow/${tier}`, {
          payload: {},
          success: Schema.String,
          body: () => Operation.call({})
        })
        const plan = yield* Plan.compile({
          planId: `tier-${tier}`,
          flow: Workflow._tag,
          nodes: Graph.drafts(Graph.build(Workflow, {}))
        })
        const runs = yield* RunStore.RunStore
        const attempts = yield* AttemptStore.AttemptStore
        const cache = yield* CacheStore.CacheStore
        let calls = 0
        let snapshots = 0
        const jj = Jj.make({
          snapshot: () =>
            Effect.sync(() => {
              snapshots++
              return { commitId: "tier-snapshot" as never, changeId: "tier-snapshot" as never }
            }),
          restore: () => Effect.void,
          diff: () => Effect.succeed(""),
          workspaceAdd: () => Effect.void,
          workspaceForget: () => Effect.void,
          status: () => Effect.succeed("")
        })
        const services = Layer.mergeAll(
          StepBoundary.layerTest(),
          Layer.succeed(Jj.Jj, jj),
          PlanScheduler.layerExecutor({
            execute: ({ inputs, node }) =>
              Effect.sync(() => {
                if (node.material.kind === "sealed") return inputs[0]?.value
                calls++
                return `result-${calls}`
              })
          })
        )
        const keys: Array<string> = []
        for (const runId of ["one", "two"]) {
          yield* runs.create(runId, "{}")
          yield* runs.claimAndOwn(
            runId,
            { status: "pending", owner: null, heartbeatAtMs: null },
            owner,
            yield* Clock.currentTimeMillis
          )
          const scheduler = PlanScheduler.make({ runId, owner, sourceId: `tier-test/${runId}` })
          const first = yield* scheduler.run(plan).pipe(Effect.provide(services))
          const again = yield* scheduler.run(plan).pipe(Effect.provide(services))
          expect(first.results).toEqual(again.results)
          expect(first.settlements[0]!.outcome).toBe("built")
          expect(again.settlements[0]!.outcome).toBe("clean")
          const key = first.settlements[0]!.dispatchKey
          keys.push(key)
          const digest = yield* Schema.decodeUnknownEffect(Sha256)(key)
          expect(Option.isNone(yield* cache.get(digest))).toBe(true)
          const row = Option.getOrThrow(yield* attempts.get({ runId, stepKeyDigest: digest, attempt: 1 }))
          expect(row.state).toBe("succeeded")
          expect(row.meta).toMatchObject({ tier })
        }
        expect(calls).toBe(2)
        expect(keys[0]).not.toBe(keys[1])
        expect(snapshots).toBe(tier === "compensable" ? 2 : 0)
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

    it.effect(`${tier} does not collapse two identical declarations in one run`, () =>
      Effect.gen(function*() {
        const plan = yield* Plan.compile({
          planId: "twins",
          flow: "twins",
          nodes: [draft("a", tier), draft("b", tier)]
        })
        expect(plan.nodes[0]!.key).toBe(plan.nodes[1]!.key)
        yield* activate("twins")
        const called: Array<string> = []
        const report = yield* schedulerFor("twins").run(plan).pipe(Effect.provide(Layer.mergeAll(
          StepBoundary.layerTest(),
          jjLayer([]),
          PlanScheduler.layerExecutor({
            execute: ({ node }) =>
              Effect.sync(() => {
                called.push(node.id)
                return node.id
              })
          })
        )))
        expect(called.sort()).toEqual(["a", "b"])
        expect(report.results).toEqual({ a: "a", b: "b" })
        expect(new Set(report.settlements.map((row) => row.dispatchKey)).size).toBe(2)
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

    it.effect(`${tier} keeps its recovery contract when a dispatch reports a conflict`, () =>
      Effect.gen(function*() {
        const plan = yield* Plan.compile({ planId: "retry", flow: "retry", nodes: [draft("effect", tier)] })
        yield* activate("retry")
        const events: Array<string> = []
        const report = yield* schedulerFor("retry").run(plan).pipe(Effect.provide(Layer.mergeAll(
          StepBoundary.layerTest(),
          jjLayer(events),
          PlanScheduler.layerExecutor({
            execute: ({ attempt }) =>
              Effect.gen(function*() {
                events.push(`execute:${attempt}`)
                if (attempt === 1) {
                  return yield* Effect.fail(
                    new WorkspaceSandbox.MaterializationConflict({ paths: ["out"], message: "raced" })
                  )
                }
                return "recovered"
              })
          })
        )))
        expect(report.settlements[0]).toMatchObject({
          outcome: tier === "compensable" ? "built" : "failed",
          attempts: tier === "compensable" ? 2 : 1,
          rebases: tier === "compensable" ? 1 : 0
        })
        expect(events).toEqual(
          tier === "compensable"
            ? ["snapshot", "execute:1", "restore:tier-snapshot", "snapshot", "execute:2"]
            : ["execute:1"]
        )
        const cache = yield* CacheStore.CacheStore
        const digest = yield* Schema.decodeUnknownEffect(Sha256)(report.settlements[0]!.dispatchKey)
        expect(Option.isNone(yield* cache.get(digest))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

    it.effect(`${tier} conflict handling cannot bypass its tier through merge elaboration`, () =>
      Effect.gen(function*() {
        const nodes = [draft("a", tier), draft("b", tier)].map((node) => ({
          ...node,
          effects: { ...node.effects, writes: ["shared.out"] },
          conflictStrategy: "lane" as const,
          runtimeStrategy: "stop-merge" as const
        }))
        const plan = yield* Plan.compile({ planId: "merge", flow: "merge", nodes })
        yield* activate("merge")
        const scheduler = schedulerFor("merge")
        yield* scheduler.record(plan)
        const report = yield* scheduler.run(plan).pipe(Effect.provide(Layer.mergeAll(
          StepBoundary.layerTest(),
          jjLayer([]),
          PlanScheduler.layerExecutor({
            execute: ({ node }) =>
              node.id === "b"
                ? Effect.fail(new WorkspaceSandbox.MaterializationConflict({ paths: ["shared.out"], message: "raced" }))
                : Effect.succeed(node.id)
          })
        )))
        if (tier === "irreversible") {
          expect(report.appended).toEqual([])
          expect(report.settlements.find((node) => node.nodeId === "b")).toMatchObject({
            outcome: "failed",
            attempts: 1
          })
          return
        }
        expect(report.appended).toEqual(["b+merge"])
        const store = yield* PlanStore.PlanStore
        const persisted = Option.getOrThrow(yield* store.get("merge"))
        expect(persisted.nodes.at(-1)!.material.kind).toBe(tier)
        const settlement = report.settlements.find((node) => node.nodeId === "b+merge")!
        expect(settlement.outcome).toBe("built")
        const cache = yield* CacheStore.CacheStore
        expect(Option.isNone(yield* cache.get(yield* Schema.decodeUnknownEffect(Sha256)(settlement.dispatchKey)))).toBe(
          true
        )
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

    it.live(`${tier} replays persisted execution after all database services are reopened`, () =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-plan-tier-" })
        const filename = join(directory, "state.sqlite")
        let calls = 0
        const services = Layer.mergeAll(
          StepBoundary.layerTest(),
          jjLayer([]),
          PlanScheduler.layerExecutor({
            execute: () =>
              Effect.sync(() => {
                calls++
                return "recorded"
              })
          })
        )
        const first = yield* Effect.gen(function*() {
          const plan = yield* Plan.compile({ planId: "reopen", flow: "reopen", nodes: [draft("effect", tier)] })
          yield* activate("reopen")
          const scheduler = schedulerFor("reopen")
          yield* scheduler.record(plan)
          return yield* scheduler.run(plan)
        }).pipe(Effect.provide(services), Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
        const replay = yield* Effect.gen(function*() {
          const store = yield* PlanStore.PlanStore
          const plan = Option.getOrThrow(yield* store.get("reopen"))
          expect(plan.nodes[0]!.material.kind).toBe(tier)
          return yield* schedulerFor("reopen").run(plan)
        }).pipe(Effect.provide(services), Effect.provide(TestStores.layerAt(filename)), Effect.scoped)
        expect(calls).toBe(1)
        expect(replay.results).toEqual(first.results)
        expect(replay.settlements[0]).toMatchObject({
          dispatchKey: first.settlements[0]!.dispatchKey,
          outcome: "clean"
        })
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), withCrypto))
  }
})
