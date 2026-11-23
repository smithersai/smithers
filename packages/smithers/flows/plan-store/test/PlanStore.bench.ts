import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as Option from "effect/Option"
import { afterAll, beforeAll, describe, test } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"

const storesLayer = Layer.provideMerge(
  PlanStore.layer,
  Layer.mergeAll(
    NodeCrypto.layer,
    Layer.provideMerge(Migrations.layer, TestDatabase.layer)
  )
)

const makePlan = (planId: string, nodeCount: number) =>
  withCrypto(
    compile(
      Array.from({ length: nodeCount }, (_, index) =>
        draft(`node-${index}`, {
          writes: [`out/${planId}-${index}.txt`],
          inputs: index === 0
            ? [{ _tag: "Literal", value: { planId, index } }]
            : [{ _tag: "Ref", from: `node-${index - 1}`, path: [] }]
        })),
      planId
    )
  )

let runtime: ManagedRuntime.ManagedRuntime<PlanStore.PlanStore, unknown>
let basePlan: Plan.Plan
let recordPlans: Array<Plan.Plan> = []
let appendBases: Array<Plan.Plan> = []
let appendGrown: Array<Plan.Plan> = []
let recordCursor = 0
let appendCursor = 0

beforeAll(async () => {
  runtime = ManagedRuntime.make(storesLayer)
  basePlan = await Effect.runPromise(makePlan("bench-get-plan", 10))
  await runtime.runPromise(
    Effect.flatMap(PlanStore.PlanStore, (store) => store.record(basePlan, 1_000))
  )
  recordPlans = await Promise.all(
    Array.from({ length: 64 }, (_, index) => Effect.runPromise(makePlan(`bench-record-${index}`, 10)))
  )
  appendBases = await Promise.all(
    Array.from({ length: 32 }, (_, index) => Effect.runPromise(makePlan(`bench-append-${index}`, 6)))
  )
  appendGrown = await Promise.all(
    appendBases.map((base, index) =>
      Effect.runPromise(
        withCrypto(
          Plan.append(base, [
            draft(`late-a-${index}`, { inputs: [{ _tag: "Pending", from: "node-5" }] }),
            draft(`late-b-${index}`, { inputs: [{ _tag: "Ref", from: `late-a-${index}`, path: [] }] })
          ])
        )
      )
    )
  )
  await runtime.runPromise(
    Effect.flatMap(
      PlanStore.PlanStore,
      (store) => Effect.forEach(appendBases, (plan, index) => store.record(plan, 2_000 + index), { discard: true })
    )
  )
})

afterAll(async () => {
  await runtime.dispose()
})

describe("PlanStore", () => {
  test("PlanStore.get (verified 10-node plan read from SQLite)", async ({ bench }) => {
    const program = Effect.flatMap(PlanStore.PlanStore, (store) => store.get(basePlan.planId))
    await bench("PlanStore.get 10-node plan", async () => {
      const found = await runtime.runPromise(program)
      if (Option.isNone(found)) throw new Error("expected plan")
    }).run({ time: 150, warmupTime: 30 })
  })

  test("PlanStore.record (10-node plan insert + verify)", async ({ bench }) => {
    await bench("PlanStore.record 10-node plan", async () => {
      const plan = recordPlans[recordCursor++ % recordPlans.length]!
      await runtime.runPromise(
        Effect.flatMap(PlanStore.PlanStore, (store) => store.record(plan, 10_000 + recordCursor))
      )
    }).run({ iterations: 20, warmupIterations: 3, time: 0, warmupTime: 0 })
  })

  test("PlanStore.append (2-node subgraph generation)", async ({ bench }) => {
    await bench("PlanStore.append 2-node subgraph", async () => {
      const index = appendCursor++
      if (index >= appendGrown.length) return
      const grown = appendGrown[index]!
      await runtime.runPromise(
        Effect.flatMap(PlanStore.PlanStore, (store) => store.append(grown))
      )
    }).run({ iterations: 20, warmupIterations: 3, time: 0, warmupTime: 0 })
  })
})
