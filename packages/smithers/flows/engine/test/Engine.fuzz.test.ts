import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Node, Placement } from "@smthrs/plan"
import { Arbitrary, Effect, Exit, Layer, Logger, Option, Result, Schema } from "effect"
import * as RpcTest from "effect/rpc/RpcTest"
import { describe, expect, it } from "vitest"
import { FlowEngine, FlowProxy, FlowProxyServer, Hosts, PlacedAction, StepTrace } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "400" : "60"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/engine comprehensive durable execution, proxy, trampoline & placement fuzz invariants", () => {
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

  it("FlowProxy & FlowProxyServer.layerRpcHandlers dispatch execute/discard/resume/interrupt & detect collisions", async () => {
    const EchoAction = Action.make("FuzzProxy/echo-act", {
      payload: { value: Schema.Number, fail: Schema.Boolean },
      success: Schema.Number,
      error: Schema.String
    })
    const EchoFlow = Flow.make("FuzzProxy/Echo", {
      payload: { value: Schema.Number, fail: Schema.Boolean },
      success: Schema.Number,
      error: Schema.String,
      body: (p) => EchoAction.call(p)
    })
    const flows = [EchoFlow] as const
    const rpcGroup = FlowProxy.toRpcGroup(flows)

    const arb = Arbitrary.schema(
      Schema.Struct({
        value: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        fail: Schema.Boolean,
        mode: Schema.Literals(["execute", "discard_resume", "interrupt", "collision"]),
        prefix: Schema.Literals(["", "api/"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ value, fail, mode, prefix }) =>
          Effect.gen(function*() {
            const addrs = FlowProxy.operationAddresses("FuzzProxy/Echo", prefix)
            if (!addrs.execute.startsWith(prefix)) return false
            if (mode === "collision") {
              const dupRes = yield* Effect.result(
                Effect.try(() => FlowProxy.assertNoCollisions([EchoFlow, EchoFlow], prefix))
              )
              return Result.isFailure(dupRes)
            }

            let calls = 0
            const baseLayer = Layer.mergeAll(
              EchoAction.toLayer((p) =>
                Effect.suspend(() => {
                  calls++
                  return p.fail ? Effect.fail(`bad:${p.value}`) : Effect.succeed(p.value * 3)
                })
              ),
              Interpreter.layer(EchoFlow)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer),
              Layer.provideMerge(Logger.layer([]))
            )
            const rpcLayer = FlowProxyServer.layerRpcHandlers(flows).pipe(Layer.provide(baseLayer))

            return yield* Effect.gen(function*() {
              const client = yield* RpcTest.makeClient(rpcGroup)
              const execId = `rpc-${mode}-${value}-${fail}`
              if (mode === "execute") {
                const res = yield* Effect.result(
                  client["FuzzProxy/Echo"]({ payload: { value, fail }, executionId: execId })
                )
                if (fail) {
                  return Result.isFailure(res) && calls === 1
                }
                return Result.isSuccess(res) && res.success === value * 3 && calls === 1
              }
              if (mode === "discard_resume") {
                yield* client["FuzzProxy/EchoDiscard"]({ payload: { value, fail }, executionId: execId })
                const res = yield* Effect.result(client["FuzzProxy/EchoResume"]({ executionId: execId }))
                return Result.isSuccess(res)
              }
              yield* client["FuzzProxy/EchoDiscard"]({ payload: { value, fail }, executionId: execId })
              yield* client["FuzzProxy/EchoInterrupt"]({ executionId: execId })
              return true
            }).pipe(Effect.scoped, Effect.provide(rpcLayer))
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Round & Trampoline handoffs reach target or enforce maxRounds deterministically", async () => {
    const IncAction = Action.make("FuzzTramp/inc", {
      payload: { value: Schema.Number },
      success: Schema.Number
    })
    type CFlow = Flow.Flow<
      string,
      Schema.Struct<{ value: typeof Schema.Number; target: typeof Schema.Number }>,
      typeof Schema.Number,
      typeof Schema.Never,
      Action.Requirement<"FuzzTramp/inc">
    >
    const registry = new Map<string, CFlow>()
    const makeCounter = (tag: string, maxRounds: number): CFlow => {
      const f: CFlow = Flow.make(tag, {
        payload: { value: Schema.Number, target: Schema.Number },
        success: Schema.Number,
        maxRounds,
        body: ({ target, value }: { readonly value: number; readonly target: number }) =>
          IncAction.call({ value }).pipe(
            Node.branch({
              if: (next) => next >= target,
              then: (next) => Flow.done(next),
              else: (next) => registry.get(tag)!.to({ value: next, target })
            })
          )
      })
      registry.set(tag, f)
      return f
    }

    const arb = Arbitrary.schema(
      Schema.Struct({
        start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
        steps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
        maxRounds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 })),
        rootId: Schema.Literals(["root-a", "root-b", "exec-42"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ start, steps, maxRounds, rootId }) =>
          Effect.gen(function*() {
            const r0 = FlowEngine.Round.initial(rootId)
            const id0 = yield* FlowEngine.Round.executionId(r0)
            if (id0 !== rootId) return false
            const advanced = yield* FlowEngine.Round.next(r0, { flowName: "FuzzTramp", maxRounds: 5 })
            if (advanced.executionId === id0 || advanced.round.ordinal !== 1) return false

            const tag = `FuzzTramp/Counter-${maxRounds}`
            const flow = makeCounter(tag, maxRounds)
            const layer = Layer.mergeAll(
              IncAction.toLayer((p) => Effect.succeed(p.value + 1)),
              Interpreter.layer(flow)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer),
              Layer.provideMerge(Logger.layer([]))
            )
            const exit = yield* Effect.exit(
              flow.execute(
                { value: start, target: start + steps },
                { executionId: `tramp-${start}-${steps}-${maxRounds}` }
              ).pipe(Effect.provide(layer))
            )
            if (steps <= maxRounds) {
              return Exit.isSuccess(exit) && exit.value === start + steps
            }
            return Exit.isFailure(exit)
          }).pipe(Effect.provide(NodeCrypto.layer)),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("DurableDeferred suspension/resume, child flows, StepTrace & PlacedAction (Here + Proxy) obey durability invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 })),
        deferredOutcome: Schema.Literals(["succeed", "fail"]),
        placementMode: Schema.Literals(["here", "proxy"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ n, deferredOutcome, placementMode }) =>
          Effect.gen(function*() {
            const Signal = DurableDeferred.make("FuzzEngine/Signal", {
              success: Schema.Number,
              error: Schema.String
            })
            const pollUntil = <A, E, R>(
              poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, unknown, R>,
              tag: "Suspended" | "Complete"
            ) =>
              Effect.gen(function*() {
                let res = yield* poll
                for (let i = 0; i < 40 && (Option.isNone(res) || res.value._tag !== tag); i++) {
                  yield* Effect.sleep("2 millis")
                  res = yield* poll
                }
                return res
              })
            const WaitAction = Action.make("FuzzEngine/wait-act", {
              payload: { c: Schema.Number },
              success: Schema.Number,
              error: Schema.String
            })
            const ChildAction = Action.make("FuzzEngine/child-act", {
              payload: { x: Schema.Number },
              success: Schema.Number
            })
            const ChildFlow = Flow.make("FuzzEngine/Child", {
              payload: { x: Schema.Number },
              success: Schema.Number,
              body: (p) => ChildAction.call(p)
            })
            const ParentFlow = Flow.make("FuzzEngine/Parent", {
              payload: { x: Schema.Number },
              success: Schema.Number,
              error: Schema.String,
              body: (p) =>
                ChildFlow.child({ x: p.x }).pipe(
                  Node.bindPlanned((c) => WaitAction.call({ c }))
                )
            })

            const traceEvents: Array<StepTrace.Event> = []
            const traceLayer = Layer.succeed(StepTrace.Sink)({
              emit: (event) =>
                Effect.sync(() => {
                  traceEvents.push(event)
                })
            })

            const remotePlacement = Placement.remote({ target: "worker-1" })
            const RemoteAct = Action.make("FuzzEngine/remote-act", {
              payload: { v: Schema.Number },
              success: Schema.Number
            })
            const RemoteFlow = Flow.make("FuzzEngine/RemoteFlow", {
              payload: { v: Schema.Number },
              success: Schema.Number,
              body: (p) => RemoteAct.call(p)
            })

            const servedRemote = PlacedAction.served(RemoteAct)
            const remoteWorkerEngine = Layer.mergeAll(
              RemoteAct.toLayer((p) => Effect.succeed(p.v + 7)),
              Interpreter.layer(servedRemote)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(NodeCrypto.layer),
              Layer.provideMerge(Logger.layer([]))
            )
            const remoteServices = yield* Layer.build(
              remoteWorkerEngine.pipe(Layer.provideMerge(Hosts.layer({})))
            )
            const ops = FlowProxy.operationAddresses(servedRemote._tag)
            const workerBinding: Hosts.Binding = placementMode === "here"
              ? { _tag: "Here" }
              : {
                _tag: "Proxy",
                connect: () =>
                  Effect.succeed({
                    [ops.execute]: (req: { readonly payload: { readonly v: number }; readonly executionId: string }) =>
                      servedRemote.execute(req.payload, { executionId: req.executionId }).pipe(
                        Effect.provide(remoteServices)
                      ),
                    [ops.discard]: (req: { readonly payload: { readonly v: number }; readonly executionId: string }) =>
                      servedRemote.execute(req.payload, { executionId: req.executionId, discard: true }).pipe(
                        Effect.provide(remoteServices)
                      ),
                    [ops.resume]: (req: { readonly executionId: string }) =>
                      servedRemote.resume(req.executionId).pipe(Effect.provide(remoteServices)),
                    [ops.interrupt]: (req: { readonly executionId: string }) =>
                      servedRemote.interrupt(req.executionId).pipe(Effect.provide(remoteServices))
                  })
              }

            const layer = Layer.mergeAll(
              ChildAction.toLayer((p) => Effect.succeed(p.x * 2)),
              WaitAction.toLayer((p) =>
                Effect.gen(function*() {
                  const sig = yield* DurableDeferred.await(Signal)
                  return p.c + sig
                })
              ),
              PlacedAction.layer(RemoteAct, remotePlacement, (p) => Effect.succeed(p.v + 7)),
              Interpreter.layer(ChildFlow),
              Interpreter.layer(ParentFlow),
              Interpreter.layer(RemoteFlow)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(FlowEngine.layerMemory),
              Layer.provideMerge(Hosts.layer({ "worker-1": workerBinding })),
              Layer.provideMerge(traceLayer),
              Layer.provideMerge(NodeCrypto.layer),
              Layer.provideMerge(Logger.layer([]))
            )

            return yield* Effect.gen(function*() {
              const rOut = yield* RemoteFlow.execute({ v: n }, { executionId: `rem-${n}-${placementMode}` })
              if (rOut !== n + 7) return false

              const execId = `def-${n}-${deferredOutcome}`
              yield* ParentFlow.execute({ x: n }, { executionId: execId, discard: true })
              const parked = yield* pollUntil(ParentFlow.poll(execId), "Suspended")
              if (Option.isNone(parked) || parked.value._tag !== "Suspended") return false

              const tok = DurableDeferred.tokenFromExecutionId(Signal, { flow: ParentFlow, executionId: execId })
              if (deferredOutcome === "succeed") {
                yield* DurableDeferred.succeed(Signal, { token: tok, value: 10 })
              } else {
                yield* DurableDeferred.fail(Signal, { token: tok, error: "rejected" })
              }

              const completed = yield* pollUntil(ParentFlow.poll(execId), "Complete")
              if (Option.isNone(completed) || completed.value._tag !== "Complete") return false
              if (deferredOutcome === "succeed") {
                if (!Exit.isSuccess(completed.value.exit) || completed.value.exit.value !== n * 2 + 10) return false
              } else {
                if (!Exit.isFailure(completed.value.exit)) return false
              }
              return traceEvents.length > 0
            }).pipe(Effect.provide(layer))
          }).pipe(Effect.scoped),
        { seed: seed + 3, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
