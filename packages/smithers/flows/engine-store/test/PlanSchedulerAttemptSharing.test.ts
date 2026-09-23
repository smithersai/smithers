import { describe, expect, it } from "@effect/vitest"
import { KeyMaterial, Plan } from "@smthrs/plan"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as PlanScheduler from "../src/PlanScheduler.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, boundary, jj, owner } from "./CachePolicyFixtures.ts"
import { withCrypto } from "./Sha256.ts"

describe("plan scheduler shares attempt ownership", () => {
  it.effect("joins concurrently scheduled sealed nodes with one content key", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* Plan.compile({
          planId: "shared-attempt",
          flow: "shared-attempt",
          nodes: ["first", "second"].map((id) => ({
            id,
            material: {
              version: KeyMaterial.version,
              kind: "sealed" as const,
              body: { operation: "same" },
              inputs: [],
              layers: [],
              capabilities: []
            },
            effects: { reads: [], writes: [], boundaryMode: "hard" as const }
          }))
        })
        expect(plan.nodes[0]!.key).toBe(plan.nodes[1]!.key)
        yield* activate("shared-attempt")
        const started = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        let calls = 0
        const execution = PlanScheduler.make({ runId: "shared-attempt", owner, sourceId: "shared-attempt" }).run(plan)
          .pipe(Effect.provide(PlanScheduler.layerExecutor({
            execute: () =>
              Effect.gen(function*() {
                calls++
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(finish)
                return "shared-result"
              })
          })))
        const running = yield* Effect.forkScoped(execution)
        yield* Deferred.await(started)
        for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
        yield* Deferred.succeed(finish, undefined)
        const exit = yield* Fiber.await(running)
        expect(calls).toBe(1)
        const report = yield* exit
        expect(report.results).toEqual({ first: "shared-result", second: "shared-result" })
        expect(report.settlements.map((settlement) => settlement.outcome).sort()).toEqual(["built", "clean"])
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), boundary(), jj)), Effect.scoped)
    ))
})
