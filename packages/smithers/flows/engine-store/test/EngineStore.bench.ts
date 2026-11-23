import { KeyMaterial, Plan, Scheduling } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import { afterAll, describe, test } from "vitest"
import { DurableEngineState } from "../src/index.ts"
import * as RuntimeGraph from "../src/internal/RuntimeGraph.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { runPromise as runWithCrypto } from "./Sha256.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const compilePlan = (shape: "chain" | "wide", size: number) =>
  runWithCrypto(Plan.compile({
    planId: `bench-${shape}-${size}`,
    flow: "bench",
    nodes: Array.from({ length: size }, (_, i) => ({
      id: String(i),
      material: {
        version: KeyMaterial.version,
        kind: "sealed" as const,
        body: i,
        inputs: shape === "chain" && i > 0 ? [{ _tag: "Pending" as const, from: String(i - 1) }] : [],
        layers: [],
        capabilities: []
      },
      effects: { reads: [], writes: [], boundaryMode: "hard" as const }
    }))
  }))

const chain256 = await compilePlan("chain", 256)
const wide256 = await compilePlan("wide", 256)

const driveIndexedGraph = (plan: Plan.Plan) => {
  const graph = RuntimeGraph.make(plan.nodes)
  const policy = Scheduling.make()
  const queue: Array<Plan.PlanNode> = []
  const admit = () => {
    const decision = policy.admit(graph.candidates(graph.ready()), { steps: 0, agents: 0 })
    for (const { node } of decision.admitted) {
      graph.start(node.id)
      queue.push(node)
    }
  }
  admit()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    graph.stage(queue[cursor]!.id, "built")
    graph.reconcile()
    admit()
  }
  return queue.length
}

const storeLayer = Layer.merge(DurableEngineState.layer, RunStore.layer).pipe(
  Layer.provide(TestStores.database)
)
const env = await Effect.runPromise(Layer.buildWithScope(storeLayer, scope))
const engineState = Context.get(env, DurableEngineState.DurableEngineState)
const runStore = Context.get(env, RunStore.RunStore)

// Seed a run + deferred entry for store lookup/write benchmarks.
await Effect.runPromise(runStore.create("bench-exec-1", JSON.stringify({ step: 0 })))
const seededAddress: DurableEngineState.DeferredAddress = {
  flowName: "bench/flow",
  executionId: "bench-exec-1",
  deferredName: "wait-seeded"
}
await Effect.runPromise(engineState.completeDeferred({
  ...seededAddress,
  exit: { _tag: "Success", value: "approved" },
  completedAtMs: 1_763_856_000_000
}))

const readDeferredEffect = engineState.deferred(seededAddress)
const dueClocksEffect = engineState.dueClocks(1_763_856_000_000)

let deferredSeq = 0
const writeDeferredEffect = Effect.suspend(() =>
  engineState.completeDeferred({
    flowName: "bench/flow",
    executionId: "bench-exec-1",
    deferredName: `wait-${deferredSeq++}`,
    exit: { _tag: "Success", value: deferredSeq },
    completedAtMs: 1_763_856_000_000 + deferredSeq
  })
)

const runPromise = Effect.runPromise
const opts = { time: 120, warmupTime: 30 }

describe("@smthrs/engine-store", () => {
  test("RuntimeGraph full schedule + reconcile (256-node chain)", async ({ bench }) => {
    await bench("RuntimeGraph chain (256 nodes)", () => {
      driveIndexedGraph(chain256)
    }).run(opts)
  })

  test("RuntimeGraph full schedule + reconcile (256-node wide)", async ({ bench }) => {
    await bench("RuntimeGraph wide (256 nodes)", () => {
      driveIndexedGraph(wide256)
    }).run(opts)
  })

  test("DurableEngineState.deferred point read", async ({ bench }) => {
    await bench("DurableEngineState.deferred", () => runPromise(readDeferredEffect)).run(opts)
  })

  test("DurableEngineState.completeDeferred write", async ({ bench }) => {
    await bench("DurableEngineState.completeDeferred", () => runPromise(writeDeferredEffect)).run(opts)
  })

  test("DurableEngineState.dueClocks scan", async ({ bench }) => {
    await bench("DurableEngineState.dueClocks", () => runPromise(dueClocksEffect)).run(opts)
  })
})
