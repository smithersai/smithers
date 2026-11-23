import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Jj from "@smthrs/jj/Jj"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { afterAll, describe, test } from "vitest"
import { Action, EngineStore, Flow, Interpreter, Plan, Runtime } from "../src/index.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const runtimeOptions: Runtime.Options = {
  owner: { hostId: "bench-host" },
  isAlive: () => Effect.succeed(false)
}

const Compute = Action.make("bench/flows/compute", {
  payload: { n: Schema.Number },
  success: Schema.Number
})

const SingleDurableFlow = Flow.make("bench/flows/single", {
  payload: { n: Schema.Number },
  success: Schema.Number,
  body: ({ n }) => Compute.call({ n })
})

const FanOutDurableFlow = Flow.make("bench/flows/fanout", {
  payload: { values: Schema.Array(Schema.Number) },
  success: Schema.Number,
  body: ({ values }) =>
    Plan.Node.all(
      Object.fromEntries(values.map((n, index) => [`v${index}`, Compute.call({ n })]))
    ).pipe(
      Plan.Node.map((xs) => Object.values(xs).reduce((a, b) => a + b, 0))
    )
})

const hostLayer = Layer.mergeAll(
  NodeDatabase.layer({ filename: ":memory:" }),
  NodeCrypto.layer,
  Jj.layerNoop({}),
  Action.layerImplementations,
  EngineStore.OwnerIdentity.layerWithoutPid.pipe(Layer.provide(NodeCrypto.layer))
)

const registration = Layer.mergeAll(
  Compute.toLayer(({ n }) => Effect.succeed(n * 3)),
  Interpreter.layer(SingleDurableFlow),
  Interpreter.layer(FanOutDurableFlow)
)

const fullRuntime = Runtime.layer(
  runtimeOptions,
  EngineStore.StepBoundary.layerUnsupported,
  EngineStore.WorkspaceSandbox.layerUnsupported,
  registration
).pipe(Layer.provideMerge(hostLayer))

const context = await Effect.runPromise(Layer.buildWithScope(fullRuntime, scope))

// Pre-execute one durable run to benchmark settled-run idempotent replay.
await Effect.runPromise(
  SingleDurableFlow.execute({ n: 7 }, { executionId: "bench-settled-1" }).pipe(Effect.provide(context))
)

let runCounter = 0
const executeColdSingle = Effect.suspend(() =>
  SingleDurableFlow.execute({ n: 7 }, { executionId: `cold-single-${runCounter++}` })
).pipe(Effect.provide(context))

const executeColdFanOut4 = Effect.suspend(() =>
  FanOutDurableFlow.execute({ values: [1, 2, 3, 4] }, { executionId: `cold-fanout-${runCounter++}` })
).pipe(Effect.provide(context))

const executeSettledHit = SingleDurableFlow.execute({ n: 7 }, { executionId: "bench-settled-1" }).pipe(
  Effect.provide(context)
)

const runPromise = Effect.runPromise
const validateFn = Runtime.validate
const fastOpts = { time: 120, warmupTime: 30 }
const slowOpts = { iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 }

describe("@smthrs/flows", () => {
  test("Runtime.validate configuration options", async ({ bench }) => {
    await bench("Runtime.validate", () => {
      validateFn(runtimeOptions)
    }).run(fastOpts)
  })

  test("Durable Runtime execute cold single-step flow (SQLite)", async ({ bench }) => {
    await bench("durable execute (1 step, cold)", () => runPromise(executeColdSingle)).run(slowOpts)
  })

  test("Durable Runtime execute cold 4-way parallel flow (SQLite)", async ({ bench }) => {
    await bench("durable execute (4 parallel steps)", () => runPromise(executeColdFanOut4)).run(slowOpts)
  })

  test("Durable Runtime settled execution idempotent replay (SQLite)", async ({ bench }) => {
    await bench("durable execute (settled hit)", () => runPromise(executeSettledHit)).run(fastOpts)
  })
})
