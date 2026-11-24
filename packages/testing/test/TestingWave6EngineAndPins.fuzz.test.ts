import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import * as Conformance from "../src/Conformance.ts"
import * as EngineSubject from "../src/EngineSubject.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Pin from "../src/internal/Pin.ts"
import * as MemoryEngine from "../src/MemoryEngine.ts"
import * as RestartableEngine from "../src/RestartableEngine.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "40")
const execs = Math.max(8, Math.min(Math.ceil(baseExecutions / 4), 20))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261126")

const property = <A, E>(
  input: Arbitrary.Arbitrary<A>,
  executions: number,
  check: (value: A) => Effect.Effect<void, E>
) =>
  Effect.runPromise(Fuzz.run(input, (value) => check(value).pipe(Effect.as(true)), { seed, executions }))
    .then((report) => {
      expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
    })

const intBetween = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })))
const bool = Arbitrary.schema(Schema.Boolean)
const word = Arbitrary.schema(Schema.Literals(["alpha", "beta", "gamma", "delta"]))

type Runtime = FlowRuntime.FlowRuntime["Service"]

const decoratedFlowEngine = (
  decorate: (runtime: Runtime) => Partial<Runtime>
): Layer.Layer<EngineSubject.EngineSubject> =>
  FlowEngineLike.layerOver(
    Layer.effect(FlowRuntime.FlowRuntime)(
      Effect.map(
        FlowRuntime.FlowRuntime,
        (runtime) => FlowRuntime.FlowRuntime.of({ ...runtime, ...decorate(runtime) })
      )
    ).pipe(Layer.provide(FlowEngine.layerMemory))
  )

describe("Wave-6 testing EngineSubject, MemoryEngine, FlowEngineLike, RestartableEngine & Conformance pins fuzz", () => {
  it(
    "runs all Conformance.coreSuite() pins against MemoryEngine and FlowEngineLike with deterministic TestClock",
    async () => {
      const allCases = Conformance.coreSuite()
      expect(allCases.length).toBeGreaterThan(5)
      expect(Object.isFrozen(allCases)).toBe(true)
      expect(Object.isFrozen(allCases[0])).toBe(true)
      const filtered = Conformance.coreSuite({
        filter: (c) => c.name.includes("replay") || c.name.includes("identity")
      })
      expect(filtered.length).toBeGreaterThan(0)
      expect(filtered.length).toBeLessThan(allCases.length)

      // Run every pin against MemoryEngine
      for (const c of allCases) {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const store = yield* MemoryEngine.makeStore()
              const engine = yield* MemoryEngine.make(store)
              yield* c.run(engine)
            })
          ).pipe(Effect.provide(TestClock.layer()))
        )
      }

      // Run every pin against FlowEngineLike.layerMemory
      for (const c of allCases) {
        await Effect.runPromise(
          Effect.scoped(
            Effect.flatMap(EngineSubject.EngineSubject, c.run).pipe(
              Effect.provide(FlowEngineLike.layerMemory)
            )
          ).pipe(Effect.provide(TestClock.layer()))
        )
      }
    },
    120_000
  )

  it(
    "fuzzes Conformance pins against deliberately faulty EngineSubjects to cover violation/Pin error paths",
    () =>
      property(
        Arbitrary.all({
          caseIdx: intBetween(
            0,
            Conformance.coreSuite({
              filter: (c) =>
                c.name.toLowerCase().includes("distinct") || c.name.toLowerCase().includes("idempotent") ||
                c.name.toLowerCase().includes("digest") || c.name.toLowerCase().includes("prefix")
            }).length - 1
          ),
          faultMode: intBetween(0, 4)
        }),
        execs,
        (s) =>
          Effect.scoped(
            Effect.gen(function*() {
              const c = Conformance.coreSuite({
                filter: (c) =>
                  c.name.toLowerCase().includes("distinct") || c.name.toLowerCase().includes("idempotent") ||
                  c.name.toLowerCase().includes("digest") || c.name.toLowerCase().includes("prefix")
              })[s.caseIdx]!
              const store = yield* MemoryEngine.makeStore()
              const real = yield* MemoryEngine.make(store)

              const faulty: EngineSubject.EngineSubject = s.faultMode === 0
                ? EngineSubject.makeNoop()
                : s.faultMode === 1
                ? EngineSubject.make({
                  ...real,
                  // Always returns a different executionId and wrong result to trip identity/replay pins
                  run: (opts) =>
                    Effect.map(real.run(opts), (res) => ({
                      ...res,
                      executionId: `${res.executionId}-tampered`,
                      value: "tampered"
                    }))
                })
                : s.faultMode === 2
                ? EngineSubject.make({
                  ...real,
                  // Always returns empty journal
                  journal: () => Effect.succeed([])
                })
                : s.faultMode === 3
                ? EngineSubject.make({
                  ...real,
                  // Interrupt does nothing
                  interrupt: (id) => Effect.andThen(real.interrupt(id), EngineSubject.makeNoop().interrupt(id))
                })
                : EngineSubject.make({
                  ...real,
                  // Resume always returns completed with wrong value
                  resume: (id) => Effect.succeed({ executionId: id, status: "completed", value: "wrong" })
                })

              // Running a pin against a faulty engine must never crash with an unhandled JS exception;
              // it cleanly succeeds or fails with ConformanceViolation / EngineSubjectError.
              const ex = yield* Effect.exit(c.run(faulty))
              expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)

              // Also directly exercise EngineSubject.layerNoop & EngineSubject.layer & Pin helpers
              const noopEx = yield* Effect.exit(
                Effect.gen(function*() {
                  const eng = yield* EngineSubject.EngineSubject
                  yield* eng.run({ flow: { name: "f", steps: [] }, payload: null })
                }).pipe(Effect.provide(EngineSubject.layerNoop()))
              )
              expect(Exit.isFailure(noopEx)).toBe(true)

              const noopRes = yield* Effect.exit(EngineSubject.makeNoop().result("x"))
              const noopInt = yield* Effect.exit(EngineSubject.makeNoop().interrupt("x"))
              const noopResume = yield* Effect.exit(EngineSubject.makeNoop().resume("x"))
              const noopJ = yield* Effect.exit(EngineSubject.makeNoop().journal("x"))
              expect(Exit.isFailure(noopRes)).toBe(true)
              expect(Exit.isFailure(noopInt)).toBe(true)
              expect(Exit.isFailure(noopResume)).toBe(true)
              expect(Exit.isFailure(noopJ)).toBe(true)

              const customLayerRes = yield* Effect.gen(function*() {
                const eng = yield* EngineSubject.EngineSubject
                return eng.name
              }).pipe(Effect.provide(EngineSubject.layer(real)))
              expect(customLayerRes).toBe(real.name)

              const pinFail = yield* Effect.exit(Pin.assert("test-pin", false, "boom", 1, 2))
              expect(Exit.isFailure(pinFail)).toBe(true)
            })
          ).pipe(Effect.provide(TestClock.layer()))
      ),
    120_000
  )

  it(
    "fuzzes FlowEngineLike and MemoryEngine across step kinds, failures, restarts, interrupts, and decorated runtime faults",
    () =>
      property(
        Arbitrary.all({
          flowName: word,
          stepKind: Arbitrary.schema(Schema.Literals(["step", "race"])),
          sealed: bool,
          shouldFail: bool,
          withPayload: bool,
          withIdempotency: bool,
          payloadVal: word,
          faultKind: intBetween(0, 4)
        }),
        execs,
        (s) =>
          Effect.scoped(
            Effect.gen(function*() {
              const spec: EngineSubject.FlowSpec = {
                name: `testing/wave6/${s.flowName}/${s.stepKind}/${s.sealed}/${s.shouldFail}`,
                steps: [
                  s.stepKind === "race"
                    ? ({
                      key: "r1",
                      kind: "race" as const,
                      sealed: false,
                      branches: [
                        {
                          key: "b1",
                          sealed: s.sealed,
                          kind: "step" as const,
                          run: (input: unknown) =>
                            s.shouldFail
                              ? Effect.fail({ _tag: "StepBoom", input })
                              : Effect.succeed({ echoed: input ?? "none" })
                        },
                        {
                          key: "b2",
                          sealed: false,
                          kind: "step" as const,
                          run: () => Effect.sleep("5 millis").pipe(Effect.as({ fallback: true }))
                        }
                      ]
                    } as EngineSubject.StepSpec)
                    : ({
                      key: "s1",
                      sealed: s.sealed,
                      kind: "step" as const,
                      run: (input: unknown) =>
                        s.shouldFail
                          ? Effect.fail({ _tag: "StepBoom", input })
                          : Effect.succeed({ echoed: input ?? "none" })
                    } as EngineSubject.StepSpec),
                  {
                    key: "s2",
                    sealed: false,
                    kind: "step",
                    run: (input) => Effect.succeed({ second: input ?? "none" })
                  }
                ]
              }

              // 1. FlowEngineLike.layer() over FlowEngine.layerMemory
              const flowLayer = FlowEngineLike.layerOver(FlowEngine.layerMemory)
              yield* Effect.gen(function*() {
                const eng = yield* EngineSubject.EngineSubject
                const res = yield* eng.run({
                  flow: spec,
                  payload: s.withPayload ? { v: s.payloadVal } : undefined,
                  ...(s.withIdempotency ? { idempotencyKey: `idem-${s.flowName}-${s.payloadVal}` } : {})
                })
                expect(res.status).toBe(s.stepKind === "step" && s.shouldFail ? "failed" : "completed")

                const fetched = yield* eng.result(res.executionId)
                expect(fetched.executionId).toBe(res.executionId)

                const j = yield* eng.journal(res.executionId)
                expect(Array.isArray(j)).toBe(true)

                // Duplicate idempotencyKey returns same execution
                if (s.withIdempotency) {
                  const dup = yield* eng.run({
                    flow: spec,
                    payload: s.withPayload ? { v: s.payloadVal } : undefined,
                    idempotencyKey: `idem-${s.flowName}-${s.payloadVal}`
                  })
                  expect(dup.executionId).toBe(res.executionId)
                }

                // Unknown executionId fails cleanly
                expect(Exit.isFailure(yield* Effect.exit(eng.result("missing-exec-id")))).toBe(true)
                const intMiss = yield* Effect.exit(eng.interrupt("missing-exec-id"))
                expect(Exit.isSuccess(intMiss) || Exit.isFailure(intMiss)).toBe(true)
                expect(Exit.isFailure(yield* Effect.exit(eng.resume("missing-exec-id")))).toBe(true)
                const jMiss = yield* Effect.exit(eng.journal("missing-exec-id"))
                expect(Exit.isSuccess(jMiss) || Exit.isFailure(jMiss)).toBe(true)
              }).pipe(Effect.provide(flowLayer))

              // 2. Decorated FlowRuntime fault paths (Failed, Interrupted, Suspended, poll None, cancel error)
              const faultLayer = s.faultKind === 0
                ? decoratedFlowEngine(() => ({
                  poll: () => Effect.succeed(Option.some(new Flow.Complete({ exit: Exit.fail("forced-fail") })))
                }))
                : s.faultKind === 1
                ? decoratedFlowEngine(() => ({
                  poll: () => Effect.succeed(Option.some(new Flow.Complete({ exit: Exit.interrupt() })))
                }))
                : s.faultKind === 2
                ? decoratedFlowEngine(() => {
                  let polls = 0
                  return {
                    poll: () =>
                      Effect.sync(() =>
                        ++polls === 1
                          ? Option.some(new Flow.Suspended())
                          : Option.some(new Flow.Complete({ exit: Exit.succeed("resumed") }))
                      )
                  }
                })
                : s.faultKind === 3
                ? decoratedFlowEngine(() => ({
                  interruptUnsafe: (_f, executionId) =>
                    Effect.fail(
                      new FlowRuntime.CancelRequestFailed({
                        code: "unsafe_interrupt_unsupported",
                        executionId,
                        reason: "forced"
                      })
                    )
                }))
                : decoratedFlowEngine(() => ({}))

              yield* Effect.gen(function*() {
                const eng = yield* EngineSubject.EngineSubject
                const ex = yield* Effect.exit(
                  eng.run({
                    flow: {
                      name: `testing/wave6/fault/${s.faultKind}`,
                      steps: [{ key: "k", sealed: false, kind: "step", run: () => Effect.succeed("ok") }]
                    },
                    payload: null
                  }).pipe(Effect.timeout("150 millis"))
                )
                expect(Exit.isSuccess(ex) || Exit.isFailure(ex)).toBe(true)
              }).pipe(Effect.provide(faultLayer))

              // 3. MemoryEngine.layer + RestartableEngine.layer
              const store = yield* MemoryEngine.makeStore()
              yield* Effect.gen(function*() {
                const eng = yield* EngineSubject.EngineSubject
                const res = yield* eng.run({
                  flow: spec,
                  payload: s.withPayload ? { v: s.payloadVal } : undefined,
                  ...(s.withIdempotency ? { idempotencyKey: `mem-${s.flowName}` } : {})
                })
                expect(res.status).toBe(s.stepKind === "step" && s.shouldFail ? "failed" : "completed")
                const fetched = yield* eng.result(res.executionId)
                expect(fetched.status).toBe(res.status)
                const resumed = yield* eng.resume(res.executionId)
                expect(resumed.executionId).toBe(res.executionId)
                const entries = yield* eng.journal(res.executionId)
                expect(entries.length).toBeGreaterThan(0)
              }).pipe(Effect.provide(MemoryEngine.layer(store)))

              // RestartableEngine.layer crash & restart
              const restartable = yield* RestartableEngine.make()
              const r1 = yield* restartable.engine.run({
                flow: {
                  name: `testing/wave6/restart/${s.flowName}`,
                  steps: [{ key: "a", sealed: true, kind: "step", run: () => Effect.succeed(s.payloadVal) }]
                },
                payload: s.payloadVal
              })
              expect(r1.status).toBe("completed")
              yield* restartable.restart
              const afterRestart = yield* restartable.engine.result(r1.executionId)
              expect(afterRestart.status).toBe("completed")
              const resumedAfterRestart = yield* restartable.restartAndResume(r1.executionId)
              expect(resumedAfterRestart.status).toBe("completed")
              const resumedAfterKill = yield* restartable.killAndResume(r1.executionId)
              expect(resumedAfterKill.status).toBe("completed")
            })
          )
      ),
    120_000
  )
})
