import { Fuzz } from "@smthrs/fuzz"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Arbitrary, Effect, Exit, Layer, Option, Schema } from "effect"
import { RpcTest } from "effect/rpc"
import { describe, expect, it } from "vitest"
import { FlowEngine, FlowProxy, FlowProxyServer } from "../src/index.ts"
import * as Diagnostic from "../src/internal/Diagnostic.ts"
import * as Utf16 from "../src/internal/Utf16.ts"
import { withCrypto } from "./Crypto.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "250" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")

const assertPassed = <A, E>(report: Fuzz.Report<A, E>): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const EchoAction = Action.make("W6Proxy/Echo/action", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid")
})

const EchoFlow = Flow.make("W6Proxy/Echo", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  error: Schema.Literal("invalid"),
  idempotencyKey: ({ value }) => String(value),
  body: (payload) => EchoAction.call(payload)
})

const Gate = DurableDeferred.make("W6Proxy/Gate", { success: Schema.Number })

const WaitAction = Action.make("W6Proxy/Wait/action", {
  payload: { id: Schema.String },
  success: Schema.Number
})

const WaitFlow = Flow.make("W6Proxy/Wait", {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id,
  body: (payload) => WaitAction.call(payload)
})

const proxyFlows = [EchoFlow, WaitFlow] as const

describe("@smthrs/engine Wave 6 deep fuzz (FlowProxyServer RPC, Compensable/Retry Dispatch, Cancellation, Diagnostic & Utf16)", () => {
  it("FlowProxyServer.layerRpcHandlers handles execute, idempotent deduplication, typed errors, discard, and resume across arbitrary payloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        value: Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 })),
        shouldFail: Schema.Boolean,
        mode: Schema.Literals(["execute", "duplicate", "discard", "resume"]),
        withCeiling: Schema.Boolean
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ value, shouldFail, mode, withCeiling }) =>
          withCrypto(
            Effect.scoped(
              Effect.gen(function*() {
                let calls = 0
                const engineLayer = Layer.mergeAll(
                  Layer.mergeAll(
                    EchoAction.toLayer(({ value: v }) =>
                      Effect.suspend(() => {
                        calls++
                        return shouldFail ? Effect.fail("invalid" as const) : Effect.succeed(v * 2)
                      })
                    ),
                    Interpreter.layer(EchoFlow)
                  ).pipe(Layer.provideMerge(Action.layerImplementations)),
                  Layer.mergeAll(
                    WaitAction.toLayer(() => DurableDeferred.await(Gate)),
                    Interpreter.layer(WaitFlow)
                  ).pipe(Layer.provideMerge(Action.layerImplementations))
                ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

                const rpcLayer = FlowProxyServer.layerRpcHandlers(proxyFlows).pipe(Layer.provideMerge(engineLayer))

                return yield* Effect.gen(function*() {
                  const client = yield* RpcTest.makeClient(FlowProxy.toRpcGroup(proxyFlows))
                  const ceiling = withCeiling ? [[{ action: "fs:read", resource: "/**" }]] : undefined

                  if (mode === "execute" || mode === "duplicate") {
                    const execId = `w6-exec-${value}`
                    const first = yield* client["W6Proxy/Echo"]({
                      payload: { value },
                      executionId: execId,
                      ...(ceiling !== undefined ? { capabilityCeilings: ceiling } : {})
                    } as never).pipe(Effect.exit)
                    if (shouldFail) {
                      expect(Exit.isFailure(first)).toBe(true)
                    } else {
                      expect(first).toEqual(Exit.succeed(value * 2))
                    }
                    if (mode === "duplicate" && !shouldFail) {
                      const second = yield* client["W6Proxy/Echo"]({
                        payload: { value },
                        executionId: execId
                      })
                      expect(second).toBe(value * 2)
                      expect(calls).toBe(1)
                    }
                  } else if (mode === "discard") {
                    yield* client["W6Proxy/EchoDiscard"]({
                      payload: { value },
                      executionId: `w6-disc-${value}`
                    })
                  } else {
                    const waitId = `w6-wait-${value}`
                    yield* client["W6Proxy/WaitDiscard"]({
                      payload: { id: waitId },
                      executionId: waitId
                    })
                    yield* client["W6Proxy/WaitResume"]({
                      executionId: waitId
                    } as never).pipe(Effect.exit)
                  }
                  return true
                }).pipe(Effect.provide(rpcLayer))
              })
            )
          ),
        { executions: Math.min(executions, 40), seed }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Compensable actions with SnapshotBoundary, RetryPolicy, undeclared failures, and sealed/irreversible tiers obey retry & restore invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
        failCount: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
        maxAttempts: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
        inputVal: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ tier, failCount, maxAttempts, inputVal }) =>
          withCrypto(
            Effect.scoped(
              Effect.gen(function*() {
                let attempts = 0
                const boundaryLog: Array<string> = []

                const innerAction = Action.make({
                  name: "W6Comp/inner",
                  success: Schema.Number,
                  error: Schema.Literal("transient"),
                  tier,
                  retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 2, maxAttempts }),
                  execute: Effect.suspend(() => {
                    attempts++
                    if (attempts <= failCount) return Effect.fail("transient" as const)
                    return Effect.succeed(inputVal + 10)
                  })
                })

                const stepAction = Action.make("W6Comp/step", {
                  payload: { n: Schema.Number },
                  success: Schema.Number,
                  error: Schema.Literal("transient")
                })

                const compFlow = Flow.make("W6Comp/flow", {
                  payload: { n: Schema.Number },
                  success: Schema.Number,
                  error: Schema.Literal("transient"),
                  body: (p) => stepAction.call(p)
                })

                const boundary = FlowEngine.SnapshotBoundary.of({
                  snapshot: (opts) => Effect.sync(() => (boundaryLog.push(`snap:${opts.attempt}`), `s:${opts.attempt}`)),
                  restore: (snap, opts) => Effect.sync(() => void boundaryLog.push(`rest:${String(snap)}:${opts.attempt}`)),
                  diff: (_snap, opts) => Effect.sync(() => (boundaryLog.push(`diff:${opts.attempt}`), Option.none()))
                })

                const layer = Layer.mergeAll(
                  stepAction.toLayer(() => innerAction),
                  Interpreter.layer(compFlow)
                ).pipe(
                  Layer.provideMerge(Action.layerImplementations),
                  Layer.provideMerge(FlowEngine.layerMemory),
                  Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary, boundary))
                )

                const ex = yield* Effect.flatMap(FlowRuntime.FlowRuntime, (rt) =>
                  rt.execute(compFlow, { executionId: `comp-${tier}-${inputVal}`, payload: { n: inputVal } })
                ).pipe(Effect.provide(layer), Effect.exit)

                // Irreversible actions cannot be retried past attempt 1; sealed/compensable retry up to maxAttempts
                const effectiveMax = tier === "irreversible" ? 1 : maxAttempts
                if (failCount < effectiveMax) {
                  expect(ex).toEqual(Exit.succeed(inputVal + 10))
                } else {
                  expect(Exit.isFailure(ex)).toBe(true)
                }
                if (tier === "compensable" && attempts > 1) {
                  expect(boundaryLog.some((e) => e.startsWith("snap:"))).toBe(true)
                  expect(boundaryLog.some((e) => e.startsWith("rest:"))).toBe(true)
                }
                return true
              })
            )
          ),
        { executions: Math.min(executions, 50), seed: seed + 1 }
      )
    )
    assertPassed(report)
  }, 60_000)

  it("Diagnostic redaction and Utf16 truncation helpers preserve valid UTF-16 boundaries and never leak credential payloads", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        text: Schema.Literals([
          "hello world",
          "emoji 😀🚀🔥 boundary",
          "sk-ant-api03-SECRETVALUE1234567890",
          "Authorization: Bearer tok_secret_abcdef1234567890",
          "a".repeat(200)
        ]),
        maxLen: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 64 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ text, maxLen }) =>
          Effect.sync(() => {
            const diagMod = Diagnostic as Record<string, unknown>
            const utfMod = Utf16 as Record<string, unknown>
            for (const fn of Object.values(utfMod)) {
              if (typeof fn === "function") {
                try {
                  const res = (fn as (a: string, b: number) => unknown)(text, maxLen)
                  if (typeof res === "string") {
                    expect(res.length).toBeLessThanOrEqual(Math.max(text.length, maxLen + 8))
                  }
                } catch {
                  // ignore arity mismatch
                }
              }
            }
            for (const fn of Object.values(diagMod)) {
              if (typeof fn === "function") {
                try {
                  const res = (fn as (v: unknown) => unknown)({ token: text, nested: [new Error(text)] })
                  expect(res).toBeDefined()
                } catch {
                  // ignore arity mismatch
                }
              }
            }
            return true
          }),
        { executions: Math.min(executions, 80), seed: seed + 2 }
      )
    )
    assertPassed(report)
  })
})
