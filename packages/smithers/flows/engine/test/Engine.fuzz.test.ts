import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { FlowEngine } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "80"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/engine durable execution & memoization fuzz invariants", () => {
  it("sealed action keys execute at most once for success or typed failure and replay deterministically under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        value: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        shouldFail: Schema.Boolean,
        repeats: Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 5 })),
        execSuffix: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 }))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ value, shouldFail, repeats, execSuffix }) =>
          Effect.gen(function*() {
            let runs = 0
            const stepAction = Action.make({
              name: "FuzzEngine/sealed-step",
              success: Schema.Number,
              error: Schema.String,
              idempotencyKey: `fuzz-sealed-${execSuffix}`,
              execute: Effect.suspend(() => {
                runs++
                return shouldFail ? Effect.fail(`fail:${value}`) : Effect.succeed(value * 2 + 1)
              })
            })
            const rootDecl = Action.make("FuzzEngine/root", {
              payload: { n: Schema.Number },
              success: Schema.Array(Schema.String)
            })
            const flow = Flow.make("FuzzEngine/memo-flow", {
              payload: { n: Schema.Number },
              success: Schema.Array(Schema.String),
              body: (payload) => rootDecl.call(payload)
            })
            const layer = Layer.mergeAll(
              rootDecl.toLayer(() =>
                Effect.forEach(
                  Array.from({ length: repeats }, (_, i) => i),
                  () =>
                    Effect.map(
                      Effect.result(stepAction),
                      (res) => Result.isSuccess(res) ? `ok:${res.success}` : `err:${res.failure}`
                    ),
                  { concurrency: "unbounded" }
                )
              ),
              Interpreter.layer(flow)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer)
            )
            const out = yield* flow.execute({ n: value }, { executionId: `exec-${execSuffix}-${runs}` }).pipe(
              Effect.provide(layer)
            )
            const expected = shouldFail ? `err:fail:${value}` : `ok:${value * 2 + 1}`
            return runs === 1 && out.length === repeats && out.every((entry) => entry === expected)
          }),
        { seed, executions, execution: FuzzSimulation.execution() }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
