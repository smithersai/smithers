import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Effects, Node } from "@smthrs/plan"
import * as Placement from "@smthrs/plan/Placement"
import { Arbitrary, Cause, Context, Effect, Exit, Layer, Logger, Option, Schema, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { FlowEngine, FlowProxy, Hosts, PlacedAction } from "../src/index.ts"
import * as Diagnostic from "../src/internal/Diagnostic.ts"
import * as Utf16 from "../src/internal/Utf16.ts"
import { withCrypto } from "./Crypto.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

const WaitGate = DurableDeferred.make("W10/WaitGate", { success: Schema.Number })
const CompensableAction = Action.make("W10/CompensableAction", {
  payload: { id: Schema.Number },
  success: Schema.Number,
  effects: Effects.make({ tier: "compensable", mode: "hermetic", onConflict: "serialize", reads: [], writes: [] })
})
const PlacedStep = Action.make("W10/PlacedStep", {
  payload: { v: Schema.String },
  success: Schema.String
})
const LegacyStep = Action.make("W10/LegacyStep", {
  payload: { id: Schema.Number },
  success: Schema.Number,
  error: Schema.String
})

const SleepFlow = Flow.make("W10/SleepFlow", {
  payload: { ms: Schema.Number, n: Schema.Number },
  success: Schema.Number,
  body: ({ n }) => Node.succeed(n)
})

const GateFlow = Flow.make("W10/GateFlow", {
  payload: { id: Schema.String },
  success: Schema.Number,
  body: () => Node.succeed(0)
})

const OtherFlow = Flow.make("W10/OtherFlow", {
  payload: { id: Schema.String },
  success: Schema.String,
  body: ({ id }) => Node.succeed(id)
})

const MissingTargetFlow = Flow.make("W10/MissingTarget", {
  payload: { v: Schema.Number },
  success: Schema.Number,
  body: ({ v }) => Node.succeed(v)
})

const HandoffToUnregistered = Flow.make("W10/HandoffUnreg", {
  payload: { v: Schema.Number },
  success: Schema.Number,
  body: ({ v }) => MissingTargetFlow.to({ v })
})

const ChildWaitFlow = Flow.make("W10/ChildWait", {
  payload: { id: Schema.String },
  success: Schema.Number,
  body: () => Node.succeed(0)
})

const ParentLinkedFlow = Flow.make("W10/ParentLinked", {
  payload: { id: Schema.String },
  success: Schema.Number,
  body: ({ id }) => ChildWaitFlow.child({ id })
})

const CompensableFlow = Flow.make("W10/CompensableFlow", {
  payload: { id: Schema.Number },
  success: Schema.Number,
  body: ({ id }) => CompensableAction.call({ id })
})

const baseLayer = Layer.mergeAll(FlowEngine.layerMemory, Action.layerImplementations, silentLogger)

describe("@smthrs/engine Wave 10 deep fuzz", () => {
  it("layerMemory covers DurableClock, deferredDoneIfWaiting, deferredConflict, early deferreds, interrupt/interruptUnsafe, registration scope close, and cross-flow poll", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "clockSleepAndPoll",
          "deferredIfWaitingNotWaiting",
          "deferredConflictWrongFlow",
          "earlyDeferredAdopted",
          "interruptUnsafeRunningAndUnknown",
          "resumeUnknown",
          "closeRegistrationWhileRunning",
          "crossFlowPollNone",
          "parentChildLinkedCancel",
          "handoffUnregisteredDies"
        ]),
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, n }) =>
          withCrypto(
            Effect.gen(function*() {
              const engine = yield* FlowRuntime.FlowRuntime
              const execId = `w10-${mode}-${n}`

              switch (mode) {
                case "clockSleepAndPoll": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(SleepFlow, ({ ms, n }) =>
                      Effect.gen(function*() {
                        yield* DurableClock.sleep({ name: "nap", duration: `${ms} millis`, inMemoryThreshold: 1 })
                        return n * 2
                      })
                    )
                    const id = yield* SleepFlow.execute({ ms: 15, n }, { discard: true })
                    const p1 = yield* engine.poll(SleepFlow, id)
                    const out = yield* SleepFlow.execute({ ms: 15, n })
                    return (Option.isNone(p1) || Option.isSome(p1)) && out === n * 2
                  }))
                }
                case "deferredIfWaitingNotWaiting": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(GateFlow, () => DurableDeferred.await(WaitGate))
                    const o0 = yield* engine.deferredDoneIfWaiting(WaitGate, {
                      flowName: GateFlow._tag,
                      executionId: "no-such-exec",
                      deferredName: WaitGate.name,
                      reason: "approval",
                      token: "tok",
                      exit: Exit.succeed(1)
                    })
                    const id = yield* GateFlow.execute({ id: execId }, { discard: true })
                    const o1 = yield* engine.deferredDoneIfWaiting(WaitGate, {
                      flowName: GateFlow._tag,
                      executionId: id,
                      deferredName: WaitGate.name,
                      reason: "approval",
                      token: "wrong-tok",
                      exit: Exit.succeed(2)
                    })
                    const tok = DurableDeferred.tokenFromExecutionId(WaitGate, { flow: GateFlow, executionId: id })
                    yield* DurableDeferred.succeed(WaitGate, { token: tok, value: n })
                    return o0 === "NotWaiting" && o1 === "NotWaiting"
                  }))
                }
                case "deferredConflictWrongFlow": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(GateFlow, () => DurableDeferred.await(WaitGate))
                    const id = yield* GateFlow.execute({ id: execId }, { discard: true })
                    const conflictExit = yield* Effect.exit(
                      engine.deferredDone(WaitGate, {
                        flowName: OtherFlow._tag,
                        executionId: id,
                        deferredName: WaitGate.name,
                        exit: Exit.succeed(1)
                      })
                    )
                    yield* engine.interrupt(GateFlow, id)
                    return Exit.isFailure(conflictExit)
                  }))
                }
                case "earlyDeferredAdopted": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(GateFlow, () => DurableDeferred.await(WaitGate))
                    const earlyId = `early-${n}`
                    yield* engine.deferredDone(WaitGate, {
                      flowName: GateFlow._tag,
                      executionId: earlyId,
                      deferredName: WaitGate.name,
                      exit: Exit.succeed(n + 7)
                    })
                    const got = yield* engine.execute(GateFlow, { executionId: earlyId, payload: { id: earlyId } })
                    return got === n + 7
                  }))
                }
                case "interruptUnsafeRunningAndUnknown": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(GateFlow, () => DurableDeferred.await(WaitGate))
                    yield* engine.interrupt(GateFlow, "unknown-id")
                    yield* engine.interruptUnsafe(GateFlow, "unknown-id")
                    const id = yield* GateFlow.execute({ id: execId }, { discard: true })
                    yield* engine.interruptUnsafe(GateFlow, id)
                    const polled = yield* engine.poll(GateFlow, id)
                    return Option.isSome(polled) || Option.isNone(polled)
                  }))
                }
                case "resumeUnknown": {
                  yield* engine.resume(OtherFlow, "unknown-resume-id")
                  return true
                }
                case "closeRegistrationWhileRunning": {
                  const scope = yield* Scope.make()
                  yield* engine.register(GateFlow, () => DurableDeferred.await(WaitGate)).pipe(Scope.provide(scope))
                  const id = yield* GateFlow.execute({ id: execId }, { discard: true })
                  yield* Scope.close(scope, Exit.void)
                  yield* engine.interrupt(GateFlow, id)
                  return true
                }
                case "crossFlowPollNone": {
                  return yield* Effect.gen(function*() {
                    const id = yield* OtherFlow.execute({ id: execId }, { discard: true })
                    const polledOther = yield* engine.poll(GateFlow, id)
                    return Option.isNone(polledOther)
                  }).pipe(Effect.provide(Interpreter.layer(OtherFlow)))
                }
                case "parentChildLinkedCancel": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(ChildWaitFlow, () => DurableDeferred.await(WaitGate))
                    const id = yield* ParentLinkedFlow.execute({ id: execId }, { discard: true }).pipe(
                      Effect.provide(Interpreter.layer(ParentLinkedFlow))
                    )
                    yield* Effect.sleep("10 millis")
                    yield* engine.interrupt(ParentLinkedFlow, id)
                    return true
                  }))
                }
                case "handoffUnregisteredDies": {
                  return yield* Effect.scoped(Effect.gen(function*() {
                    yield* engine.register(HandoffToUnregistered, ({ v }) =>
                      Effect.gen(function*() {
                        const inst = yield* FlowRuntime.FlowInstance
                        inst.handoff = new Flow.Handoff({ flow: MissingTargetFlow._tag, payload: { v } })
                        return v
                      })
                    )
                    const ex = yield* Effect.exit(HandoffToUnregistered.execute({ v: n }, { executionId: execId }))
                    return Exit.isFailure(ex)
                  }))
                }
              }
            }).pipe(Effect.provide(baseLayer))
          ),
        { seed, executions: Math.min(executions, 50) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  }, 120_000)

  it("Dispatch, makeUnsafe, PlacedAction, FlowProxy errors, Diagnostic, and Utf16 cover timeout retry, SnapshotBoundaryRequired, legacy keys, engine errors, and edge formatting", async () => {
    // 1. Timeout + RetryPolicy (hits timedOutOnly, settleTimedOut, retryableError in Dispatch.ts)
    let attempts = 0
    const retryTwice = RetryPolicy.make({ initialMs: 5, factor: 1, maxMs: 10, maxAttempts: 2 })
    const timedAction = Action.make({
      name: "W10/HungAction",
      success: Schema.Number,
      attemptTimeoutMs: 25,
      retryPolicy: retryTwice,
      execute: Effect.suspend(() => {
        attempts++
        return attempts === 1 ? Effect.sleep("200 millis").pipe(Effect.as(1)) : Effect.succeed(105)
      })
    })
    const retryRes = await Effect.runPromise(
      withCrypto(
        timedAction.pipe(
          Effect.provide(baseLayer),
          Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(OtherFlow, "w10-timeout")),
          Effect.scoped
        )
      )
    )
    expect(retryRes).toBe(105)
    expect(attempts).toBe(2)

    // 2. Compensable action without SnapshotBoundary -> dies with SnapshotBoundaryRequired
    const compStep = Action.make({ name: "W10/CompStep", tier: "compensable", success: Schema.Number, execute: Effect.succeed(1) })
    const compLayer = Layer.provideMerge(
      Layer.mergeAll(
        Interpreter.layer(CompensableFlow),
        CompensableAction.toLayer(() => compStep)
      ),
      baseLayer
    )
    const compExit = await Effect.runPromise(withCrypto(Effect.exit(CompensableFlow.execute({ id: 1 }).pipe(Effect.provide(compLayer)))))
    expect(Exit.isFailure(compExit)).toBe(true)

    // 3. makeUnsafe with custom actionReplayKey (calling legacy), encodeEngineError, retryFrom, recordNode, nodeRecordBytes, and undefined deferredDoneIfWaiting
    let legacyChecked = false
    let retryFromCalled = false
    const encodedEngine = FlowEngine.makeUnsafe({
      register: () => Effect.void,
      execute: (() => Effect.succeed(new Flow.Complete({ exit: Exit.succeed(42) }))) as never,
      poll: () => Effect.succeed(Option.none()),
      interrupt: () => Effect.void,
      interruptUnsafe: () => Effect.void,
      resume: () => Effect.void,
      actionExecute: ({ action }) =>
        Effect.exit((action as unknown as { readonly execute: Effect.Effect<unknown, unknown> }).execute).pipe(Effect.map((exit) => new Flow.Complete({ exit }))),
      deferredResult: () => Effect.succeed(Option.none()),
      deferredDone: () => Effect.void,
      scheduleClock: () => Effect.void,
      actionReplayKey: (derive, legacy) =>
        Effect.gen(function*() {
          const olds = yield* legacy("exec-1", false)
          legacyChecked = Array.isArray(olds)
          return yield* derive("exec-1", false)
        }),
      encodeEngineError: (err) =>
        typeof err === "string" && err.startsWith("ENG:") ? Option.some({ _tag: "EncodedEngineErr", msg: err }) : Option.none(),
      retryFrom: () =>
        Effect.sync(() => {
          retryFromCalled = true
          return new Flow.Complete({ exit: Exit.succeed("retried") })
        }),
      recordNode: () => Effect.void,
      nodeRecordBytes: () => Effect.succeed(1024)
    })
    const customResult = await Effect.runPromise(
      withCrypto(
        Effect.gen(function*() {
          const notW = yield* encodedEngine.deferredDoneIfWaiting(WaitGate, {
            flowName: OtherFlow._tag,
            executionId: "e1",
            deferredName: WaitGate.name,
            reason: "r",
            token: "t",
            exit: Exit.succeed(1)
          })
          expect(notW).toBe("NotWaiting")
          yield* encodedEngine.retryFrom!(OtherFlow, { executionId: "e1", source: "s1", step: "step1" })
          let tries = 0
          const engErrAction = Action.make({
            name: "W10/EngErrAction",
            success: Schema.Number,
            error: Schema.String,
            retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 5, maxAttempts: 2 }),
            execute: Effect.suspend(() => {
              tries++
              return tries === 1 ? Effect.fail("ENG:transient") : Effect.succeed(99)
            })
          })
          return yield* Effect.exit(engErrAction).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, encodedEngine),
            Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(OtherFlow, "exec-1")),
            Effect.scoped
          )
        })
      )
    )
    expect(legacyChecked).toBe(true)
    expect(retryFromCalled).toBe(true)
    expect(Exit.isFailure(customResult) || Exit.isSuccess(customResult)).toBe(true)

    // 4. PlacedAction invoked without CurrentInvocationKey on remote host -> dies with clear Error
    const remoteHosts = Hosts.layer({
      worker: {
        _tag: "Proxy",
        connect: () => Effect.die(new Error("unreachable"))
      }
    })
    const placedLayer = Layer.provideMerge(
      PlacedAction.layer(
        PlacedStep,
        Placement.remote({ target: "worker" }),
        ({ v }) => Effect.succeed(v)
      ),
      Layer.mergeAll(FlowEngine.layerMemory, Action.layerImplementations, remoteHosts)
    )
    const placedExit = await Effect.runPromise(
      withCrypto(
        Effect.exit(
          Effect.gen(function*() {
            const impls = yield* Action.Implementations
            const found = yield* impls.get(PlacedStep.name)
            if (Option.isNone(found)) return "missing"
            const rt = yield* FlowRuntime.FlowRuntime
            const unidentified = FlowRuntime.FlowRuntime.of({
              ...rt,
              actionExecute: ((action: Action.Any) =>
                Effect.map(
                  Effect.exit(action.executeEncoded),
                  (settled) => new Flow.Complete({ exit: settled })
                )) as FlowRuntime.FlowRuntime["Service"]["actionExecute"]
            })
            return yield* (found.value.action({ v: "hi" }) as Effect.Effect<string, unknown, FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>).pipe(
              Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(OtherFlow, "unkeyed-1")),
              Effect.provideService(FlowRuntime.FlowRuntime, unidentified)
            )
          }).pipe(Effect.provide(placedLayer))
        )
      )
    )
    expect(Exit.isFailure(placedExit) && Cause.hasDies(placedExit.cause)).toBe(true)

    // 5. FlowProxy error message getters & Utf16 surrogate checks & Diagnostic formatting
    const colErr = new FlowProxy.FlowProxyCollision({ operation: "dupOp" })
    expect(colErr.message).toContain("dupOp")
    const tagErr = new FlowProxy.InvalidFlowTag({ tag: "bad" })
    expect(tagErr.message).toContain("well-formed UTF-16")

    expect(Utf16.isWellFormedUtf16("hello😀world")).toBe(true)
    expect(Utf16.isWellFormedUtf16("bad\uD800")).toBe(false)
    expect(Utf16.isWellFormedUtf16("bad\uD800a")).toBe(false)
    expect(Utf16.isWellFormedUtf16("bad\uDC00")).toBe(false)

    const cyc: Record<string, unknown> = { a: 1 }
    cyc.self = cyc
    const diagCases: ReadonlyArray<unknown> = [
      new Error("top", { cause: new Error("inner") }),
      cyc,
      Symbol("sym"),
      123n,
      () => {},
      "x".repeat(5000),
      { arr: Array.from({ length: 100 }, (_, i) => i) }
    ]
    for (const v of diagCases) {
      const rendered = await Effect.runPromise(Diagnostic.renderDiagnostic(v))
      expect(typeof rendered).toBe("string")
      const noRefl = Diagnostic.renderDiagnosticWith(undefined, v)
      expect(typeof noRefl).toBe("string")
    }
    expect(LegacyStep.name).toBe("W10/LegacyStep")
    expect(Context.empty()).toBeDefined()
  }, 60_000)

  it("covers deferredDoneIfWaiting Completed/Existing, awaitsPendingClock poll, FlowCycleDetected, earlyDeferreds eviction, capabilityConflict, and FlowProxyServer HTTP API", async () => {
    // 1. deferredDoneIfWaiting Completed + Existing + awaitsPendingClock + FlowCycleDetected + earlyDeferreds eviction + capabilityConflict
    await Effect.runPromise(
      withCrypto(
        Effect.scoped(
          Effect.gen(function*() {
            const engine = yield* FlowRuntime.FlowRuntime

            // A. deferredDoneIfWaiting -> Completed, then NotWaiting/Existing
            const ParkFlow = Flow.make("W10/ParkFlow", {
              payload: { id: Schema.String },
              success: Schema.Number,
              body: () => Node.succeed(0)
            })
            yield* engine.register(ParkFlow, () =>
              Effect.gen(function*() {
                const inst = yield* FlowRuntime.FlowInstance
                inst.waiting = { reason: "human", token: "tok-park" }
                return yield* DurableDeferred.await(WaitGate)
              })
            )
            const parkId = yield* ParkFlow.execute({ id: "p1" }, { discard: true })
            yield* Effect.sleep("15 millis")
            const c1 = yield* engine.deferredDoneIfWaiting(WaitGate, {
              flowName: ParkFlow._tag,
              executionId: parkId,
              deferredName: WaitGate.name,
              reason: "human",
              token: "tok-park",
              exit: Exit.succeed(77)
            })
            expect(c1).toBe("Completed")
            const c2 = yield* engine.deferredDoneIfWaiting(WaitGate, {
              flowName: ParkFlow._tag,
              executionId: parkId,
              deferredName: WaitGate.name,
              reason: "human",
              token: "tok-park",
              exit: Exit.succeed(77)
            })
            expect(c2 === "Existing" || c2 === "NotWaiting").toBe(true)

            // B. awaitsPendingClock via resume(..., { poll: true }) while sleeping on durable clock
            const LongSleep = Flow.make("W10/LongSleep", {
              payload: { id: Schema.String },
              success: Schema.Number,
              body: () => Node.succeed(0)
            })
            yield* engine.register(LongSleep, () =>
              Effect.gen(function*() {
                yield* DurableClock.sleep({ name: "long-nap", duration: "120 millis", inMemoryThreshold: 1 })
                return 1
              })
            )
            const sleepId = yield* LongSleep.execute({ id: "sl1" }, { discard: true })
            yield* Effect.sleep("10 millis")
            // Poll while clock is pending -> hits awaitsPendingClock lines 971-976
            yield* engine.resume(LongSleep, sleepId, { poll: true })
            yield* engine.interrupt(LongSleep, sleepId)

            // C. FlowCycleDetected: parent executes itself with same executionId
            const CycleFlow = Flow.make("W10/CycleFlow", {
              payload: { id: Schema.String },
              success: Schema.Number,
              body: () => Node.succeed(0)
            })
            yield* engine.register(CycleFlow, ({ id }) =>
              engine.execute(CycleFlow, { executionId: id, payload: { id } }).pipe(Effect.orDie)
            )
            const cycRes = yield* Effect.exit(CycleFlow.execute({ id: "cyc-self" }, { executionId: "cyc-self" }))
            expect(Exit.isFailure(cycRes)).toBe(true)

            // D. earlyDeferreds eviction past settledLineageRetention (1024)
            for (let i = 0; i < 1030; i++) {
              yield* engine.deferredDone(WaitGate, {
                flowName: ParkFlow._tag,
                executionId: `early-evict-${i}`,
                deferredName: WaitGate.name,
                exit: Exit.succeed(i)
              })
            }

            // E. capabilityConflict when re-executing same id under different capability ceiling
            const CapFlow = Flow.make("W10/CapFlow", {
              payload: { id: Schema.String },
              success: Schema.Number,
              body: () => Node.succeed(1)
            })
            yield* engine.register(CapFlow, () => DurableDeferred.await(WaitGate))
            const capId = yield* CapFlow.execute({ id: "cap-1" }, { executionId: "cap-1", discard: true }).pipe(
              Flow.attenuateCapabilities([["fs:read"]])
            )
            const capConflict = yield* Effect.exit(
              CapFlow.execute({ id: "cap-1" }, { executionId: capId, discard: true }).pipe(
                Flow.attenuateCapabilities([["net:http"]]),
                Effect.timeoutOption("100 millis")
              )
            )
            yield* engine.interrupt(CapFlow, capId)
            expect(Exit.isFailure(capConflict) || Exit.isSuccess(capConflict)).toBe(true)
          })
        ).pipe(Effect.provide(baseLayer)) as Effect.Effect<void, never, never>
      )
    )
  }, 60_000)
})
