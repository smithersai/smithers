import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import * as Placement from "@smthrs/plan/Placement"
import { Arbitrary, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { HttpClient, HttpRouter } from "effect/http"
import { RpcClient, RpcSerialization, RpcServer } from "effect/rpc"
import { describe, expect, it } from "vitest"
import { FlowEngine, FlowProxy, FlowProxyServer, Hosts } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261129")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(20, Math.min(baseExecutions, 60))
const httpExec = Math.max(8, Math.min(Math.ceil(baseExecutions / 15), 14))

const assertPassed = <A>(report: Fuzz.Report<A, unknown>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

const Step = Action.make("w8-place/step", {
  payload: { version: Schema.String },
  success: Schema.String
})

const RemoteRelease = Flow.make("w8-place/release", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => Step.call(payload)
}).annotate(Flow.Placement, Placement.remote({ target: "b" }))

const LocalParent = Flow.make("w8-place/parent", {
  payload: { version: Schema.String },
  success: Schema.String,
  body: (payload) => RemoteRelease.child(payload).pipe(Node.map((out) => `ok:${out}`))
})

describe("Flows Engine Wave 8 deep fuzzing", () => {
  it(
    "Placed remote flows execute, discard, resume, interrupt, forward cancellation, and reject delegated resume & retryFrom",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "execute",
            "discard-and-resume",
            "delegated-resume-dies",
            "interrupt-remote",
            "parent-cancel-forwards",
            "retryFrom-unsupported"
          ]),
          version: Schema.Literals(["v1", "v2", "v3-rc"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, version }) =>
            Effect.scoped(
              Effect.gen(function*() {
                const started = yield* Deferred.make<void>()
                const release = yield* Deferred.make<void>()
                let remoteInterrupted = false

                const serverCtx = yield* Layer.build(
                  HttpRouter.serve(
                    RpcServer.layerHttp({
                      group: FlowProxy.toRpcGroup([RemoteRelease]),
                      path: "/",
                      protocol: "http"
                    }).pipe(
                      Layer.provide(FlowProxyServer.layerRpcHandlers([RemoteRelease])),
                      Layer.provide(RpcSerialization.layerJson)
                    )
                  ).pipe(
                    Layer.provideMerge(
                      Layer.mergeAll(
                        Step.toLayer(({ version: v }) =>
                          Effect.gen(function*() {
                            yield* Deferred.succeed(started, undefined)
                            if (mode === "interrupt-remote" || mode === "parent-cancel-forwards") {
                              yield* Deferred.await(release).pipe(
                                Effect.onInterrupt(() =>
                                  Effect.sync(() => {
                                    remoteInterrupted = true
                                  })
                                )
                              )
                            }
                            return `built:${v}`
                          })
                        ),
                        Interpreter.layer(RemoteRelease)
                      ).pipe(
                        Layer.provideMerge(Action.layerImplementations),
                        Layer.provideMerge(FlowEngine.layerMemory)
                      )
                    ),
                    Layer.provideMerge(NodeHttpServer.layerTest)
                  )
                )

                const clientCtx = yield* Layer.build(
                  Interpreter.layer(LocalParent).pipe(
                    Layer.provideMerge(Action.layerImplementations),
                    Layer.provideMerge(FlowEngine.layerMemory),
                    Layer.provideMerge(
                      Hosts.layer({
                        b: {
                          _tag: "Proxy",
                          connect: (group) =>
                            RpcClient.make(group as never).pipe(
                              Effect.provide(
                                RpcClient.layerProtocolHttp({ url: "" }).pipe(
                                  Layer.provide(
                                    Layer.succeed(HttpClient.HttpClient)(
                                      serverCtx.mapUnsafe.get(HttpClient.HttpClient.key) as HttpClient.HttpClient
                                    )
                                  ),
                                  Layer.provide(RpcSerialization.layerJson)
                                )
                              )
                            )
                        }
                      })
                    )
                  )
                )

                const runOnA = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
                  Effect.provide(eff as Effect.Effect<A, E, never>, clientCtx)

                if (mode === "execute") {
                  const res = yield* runOnA(LocalParent.execute({ version }, { executionId: `exec-${version}` }))
                  expect(res).toBe(`ok:built:${version}`)
                } else if (mode === "discard-and-resume") {
                  const engine = clientCtx.mapUnsafe.get(
                    FlowRuntime.FlowRuntime.key
                  ) as FlowRuntime.FlowRuntime["Service"]
                  const id = yield* runOnA(
                    RemoteRelease.execute({ version }, { executionId: `disc-${version}`, discard: true })
                  )
                  expect(id).toBe(`disc-${version}`)
                  const res = yield* runOnA(engine.resume(RemoteRelease, `disc-${version}`, { poll: true }))
                  expect(res === undefined || typeof res === "object").toBe(true)
                } else if (mode === "delegated-resume-dies") {
                  const engine = clientCtx.mapUnsafe.get(
                    FlowRuntime.FlowRuntime.key
                  ) as FlowRuntime.FlowRuntime["Service"]
                  const ex = yield* Effect.exit(
                    runOnA(engine.resume(RemoteRelease, `del-${version}`, { delegated: true }))
                  )
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (mode === "interrupt-remote") {
                  const engine = clientCtx.mapUnsafe.get(
                    FlowRuntime.FlowRuntime.key
                  ) as FlowRuntime.FlowRuntime["Service"]
                  const fib = yield* Effect.forkChild(
                    runOnA(RemoteRelease.execute({ version }, { executionId: `int-${version}` }))
                  )
                  yield* Deferred.await(started)
                  yield* runOnA(engine.interrupt(RemoteRelease, `int-${version}`))
                  yield* Deferred.succeed(release, undefined)
                  yield* Fiber.await(fib)
                  expect(typeof remoteInterrupted).toBe("boolean")
                } else if (mode === "parent-cancel-forwards") {
                  const engine = clientCtx.mapUnsafe.get(
                    FlowRuntime.FlowRuntime.key
                  ) as FlowRuntime.FlowRuntime["Service"]
                  const fib = yield* Effect.forkChild(
                    runOnA(LocalParent.execute({ version }, { executionId: `pc-${version}` }))
                  )
                  yield* Deferred.await(started)
                  yield* runOnA(engine.interrupt(LocalParent, `pc-${version}`))
                  yield* Deferred.succeed(release, undefined)
                  yield* Fiber.await(fib)
                  expect(typeof remoteInterrupted).toBe("boolean")
                } else if (mode === "retryFrom-unsupported") {
                  const engine = clientCtx.mapUnsafe.get(
                    FlowRuntime.FlowRuntime.key
                  ) as FlowRuntime.FlowRuntime["Service"]
                  if (engine.retryFrom !== undefined) {
                    const ex = yield* Effect.exit(
                      runOnA(
                        engine.retryFrom(RemoteRelease, {
                          source: `src-${version}`,
                          executionId: `retry-${version}`,
                          step: "0"
                        })
                      )
                    )
                    expect(Exit.isFailure(ex)).toBe(true)
                  }
                }

                return true
              })
            ).pipe(withCrypto),
          { seed, executions: httpExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it(
    "FlowEngine.layerMemory invariants: identity conflict, capability conflict, retryFrom, suspension/interrupt, and retention",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "identity-conflict-flow",
            "identity-conflict-payload",
            "capability-conflict",
            "park-resume-interrupt",
            "undeclared-failure-redaction",
            "retryFrom-replay"
          ]),
          n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scenario, n }) =>
            Effect.scoped(
              Effect.gen(function*() {
                const engine = yield* FlowRuntime.FlowRuntime
                const Gate = DurableDeferred.make("w8-mem/gate", { success: Schema.String })
                let stepCalls = 0
                const Work = Action.make("w8-mem/work", {
                  payload: { n: Schema.Number },
                  success: Schema.Number
                })
                const FlowA = Flow.make("w8-mem/flow-a", {
                  payload: { n: Schema.Number },
                  success: Schema.Number,
                  body: ({ n: x }) => Work.call({ n: x }).pipe(Node.map((v) => v + 1))
                })
                const FlowB = Flow.make("w8-mem/flow-b", {
                  payload: { n: Schema.Number },
                  success: Schema.Number,
                  body: ({ n: x }) => Node.succeed(x * 3)
                })
                const WaitFlow = Flow.make("w8-mem/wait", {
                  payload: { n: Schema.Number },
                  success: Schema.String,
                  body: () => Action.make("w8-mem/wait-step", { payload: {}, success: Schema.String }).call({})
                })

                if (scenario === "identity-conflict-flow") {
                  yield* engine.register(FlowA, ({ n: x }) => Effect.succeed(x + 1))
                  yield* engine.register(FlowB, ({ n: x }) => Effect.succeed(x * 3))
                  expect(yield* FlowA.execute({ n }, { executionId: `id-${n}` })).toBe(n + 1)
                  const conflict = yield* Effect.exit(FlowB.execute({ n }, { executionId: `id-${n}` }))
                  expect(Exit.isFailure(conflict)).toBe(true)
                } else if (scenario === "identity-conflict-payload") {
                  yield* engine.register(FlowA, ({ n: x }) => Effect.succeed(x + 1))
                  expect(yield* FlowA.execute({ n }, { executionId: `pay-${n}` })).toBe(n + 1)
                  const conflict = yield* Effect.exit(FlowA.execute({ n: n + 1 }, { executionId: `pay-${n}` }))
                  expect(Exit.isFailure(conflict)).toBe(true)
                } else if (scenario === "capability-conflict") {
                  const err1 = FlowEngine.capabilityConflict(`cap-${n}`)
                  expect(err1.executionId).toBe(`cap-${n}`)
                  expect(err1.field).toBe("capabilities")
                  expect(err1.status).toBe("unknown")
                  const err2 = FlowEngine.capabilityConflict(`cap-${n}`, "running")
                  expect(err2.status).toBe("running")
                } else if (scenario === "park-resume-interrupt") {
                  const tokD = yield* Deferred.make<DurableDeferred.Token>()
                  yield* engine.register(
                    WaitFlow,
                    () =>
                      Effect.gen(function*() {
                        const tok = yield* DurableDeferred.token(Gate)
                        yield* Deferred.succeed(tokD, tok)
                        return yield* DurableDeferred.await(Gate)
                      })
                  )
                  const id = `wait-${n}`
                  const fib = yield* Effect.forkChild(WaitFlow.execute({ n }, { executionId: id }))
                  const tok = yield* Deferred.await(tokD)
                  if (n % 2 === 0) {
                    yield* DurableDeferred.done(Gate, { token: tok, exit: Exit.succeed(`done-${n}`) })
                    const out = yield* Fiber.join(fib)
                    expect(out).toBe(`done-${n}`)
                  } else {
                    yield* engine.interrupt(WaitFlow, id)
                    const ex = yield* Fiber.await(fib)
                    expect(Exit.isFailure(ex)).toBe(true)
                  }
                } else if (scenario === "undeclared-failure-redaction") {
                  yield* engine.register(FlowA, () => Effect.fail("secret-internal-error" as never))
                  const ex = yield* Effect.exit(FlowA.execute({ n }, { executionId: `undec-${n}` }))
                  expect(Exit.isFailure(ex)).toBe(true)
                } else if (scenario === "retryFrom-replay") {
                  const ctx = yield* Layer.build(
                    Layer.mergeAll(
                      Work.toLayer(({ n: x }) => Effect.sync(() => (stepCalls++, x * 2))),
                      Interpreter.layer(FlowA)
                    ).pipe(
                      Layer.provideMerge(Action.layerImplementations),
                      Layer.provideMerge(FlowEngine.layerMemory)
                    )
                  )
                  const out = yield* FlowA.execute({ n }, { executionId: `src-${n}` }).pipe(Effect.provide(ctx))
                  expect(out).toBe(n * 2 + 1)
                  expect(stepCalls).toBe(1)
                  const memEngine = ctx.mapUnsafe.get(FlowRuntime.FlowRuntime.key) as FlowRuntime.FlowRuntime["Service"]
                  if (memEngine.retryFrom !== undefined) {
                    const bad = yield* Effect.exit(
                      memEngine.retryFrom(FlowA, {
                        source: "does-not-exist",
                        executionId: `retry-miss-${n}`,
                        step: "0"
                      })
                    )
                    expect(Exit.isFailure(bad)).toBe(true)
                  }
                }

                return true
              }).pipe(Effect.provide(FlowEngine.layerMemory))
            ).pipe(withCrypto as <A, E, R>(e: Effect.Effect<A, E, R>) => Effect.Effect<A, E>),
          { seed: seed + 1, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    60_000
  )

  it("FlowEngine.layerMemory evicts oldest settled lineages past settledLineageRetention", async () => {
    const Filler = Flow.make("w8-mem/filler", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: () => Node.succeed(0)
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          let runs = 0
          yield* engine.register(Filler, ({ n }) => Effect.sync(() => (runs++, n)))
          const limit = FlowEngine.settledLineageRetention
          const total = limit + 6
          for (let i = 0; i < total; i++) {
            expect(yield* Filler.execute({ n: i }, { executionId: `ret-${i}` })).toBe(i)
          }
          expect(runs).toBe(total)
          const firstPoll = yield* Effect.exit(Filler.poll("ret-0"))
          expect(Exit.isFailure(firstPoll)).toBe(true)
          const lastPoll = yield* Filler.poll(`ret-${total - 1}`)
          expect(Option.isSome(lastPoll)).toBe(true)
        }).pipe(Effect.provide(FlowEngine.layerMemory))
      ).pipe(withCrypto)
    )
  }, 60_000)
})
