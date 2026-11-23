import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { afterAll, describe, test } from "vitest"
import { FlowEngine, FlowProxy } from "../src/index.ts"

const scope = Effect.runSync(Scope.make())
afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))

const Double = Action.make("bench/engine/double", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const SingleStepFlow = Flow.make("bench/engine/single", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Double.call({ value })
})

const FanOutFlow = Flow.make("bench/engine/fanout", {
  payload: { values: Schema.Array(Schema.Number) },
  success: Schema.Number,
  body: ({ values }) =>
    Node.all(
      Object.fromEntries(values.map((value, index) => [`v${index}`, Double.call({ value })]))
    ).pipe(
      Node.map((results) => Object.values(results).reduce((sum, n) => sum + n, 0))
    )
})

const ChildFlow = Flow.make("bench/engine/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Double.call({ value })
})

const ParentFlow = Flow.make("bench/engine/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) =>
    ChildFlow.call({ value }).pipe(
      Node.bindPlanned((doubled) => Double.call({ value: doubled }))
    )
})

const runtimeLayer = Layer.mergeAll(
  Double.toLayer(({ value }) => Effect.succeed(value * 2)),
  Interpreter.layer(SingleStepFlow),
  Interpreter.layer(FanOutFlow),
  Interpreter.layer(ChildFlow),
  Interpreter.layer(ParentFlow)
).pipe(
  Layer.provideMerge(Action.layerImplementations),
  Layer.provideMerge(FlowEngine.layerMemory),
  Layer.provideMerge(NodeCrypto.layer)
)

const context = await Effect.runPromise(Layer.buildWithScope(runtimeLayer, scope))

const makeProxyFlow = (index: number) =>
  Flow.make(`bench/proxy/flow-${index}`, {
    payload: { id: Schema.String, count: Schema.Number },
    success: Schema.Struct({ ok: Schema.Boolean, total: Schema.Number }),
    body: () => Node.succeed({ ok: true, total: index })
  })

const proxyFlows = [
  makeProxyFlow(0),
  makeProxyFlow(1),
  makeProxyFlow(2),
  makeProxyFlow(3),
  makeProxyFlow(4),
  makeProxyFlow(5),
  makeProxyFlow(6),
  makeProxyFlow(7)
] as const

let execCounter = 0
const runSingle = Effect.suspend(() =>
  SingleStepFlow.execute({ value: 21 }, { executionId: `single-${execCounter++}` })
).pipe(Effect.provide(context))

const runFanOut8 = Effect.suspend(() =>
  FanOutFlow.execute({ values: [1, 2, 3, 4, 5, 6, 7, 8] }, { executionId: `fanout-${execCounter++}` })
).pipe(Effect.provide(context))

const runNested = Effect.suspend(() => ParentFlow.execute({ value: 10 }, { executionId: `nested-${execCounter++}` }))
  .pipe(Effect.provide(context))

const runPromise = Effect.runPromise
const toRpcGroupFn = FlowProxy.toRpcGroup
const toHttpApiGroupFn = FlowProxy.toHttpApiGroup
const opts = { time: 120, warmupTime: 30 }
const slowOpts = { iterations: 20, warmupIterations: 3, time: 0, warmupTime: 0 }

describe("@smthrs/engine", () => {
  test("FlowEngine.layerMemory single-action flow execute", async ({ bench }) => {
    await bench("memory execute (1 action)", () => runPromise(runSingle)).run(slowOpts)
  })

  test("FlowEngine.layerMemory 8-way parallel fan-out flow execute", async ({ bench }) => {
    await bench("memory execute (8 parallel actions)", () => runPromise(runFanOut8)).run(slowOpts)
  })

  test("FlowEngine.layerMemory parent -> child nested flow execute", async ({ bench }) => {
    await bench("memory execute (parent -> child)", () => runPromise(runNested)).run(slowOpts)
  })

  test("FlowProxy.toRpcGroup and toHttpApiGroup (8 flows)", async ({ bench }) => {
    await bench("FlowProxy.toRpcGroup (8 flows)", () => {
      toRpcGroupFn(proxyFlows)
    }).run(opts)

    await bench("FlowProxy.toHttpApiGroup (8 flows)", () => {
      toHttpApiGroupFn("bench", proxyFlows)
    }).run(opts)
  })
})
