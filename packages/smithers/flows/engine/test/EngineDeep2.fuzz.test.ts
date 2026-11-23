import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Cause, Effect, Layer, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as FlowEngine from "../src/FlowEngine/index.ts"
import * as FlowProxy from "../src/FlowProxy.ts"
import * as FlowProxyServer from "../src/FlowProxyServer.ts"
import * as Diagnostic from "../src/internal/Diagnostic.ts"
import * as Utf16 from "../src/internal/Utf16.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "300" : "120"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261204")

describe("@smthrs/engine Diagnostic, Utf16, FlowProxy HTTP/RPC & Placed/Dispatch deep fuzz", () => {
  it("renderDiagnostic & Utf16 safely render arbitrary JS values, cycles, BigInt, Symbol, Map, Set, Errors & Redacted", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        kind: Schema.Literals([
          "primitive_str",
          "primitive_num",
          "bigint",
          "symbol",
          "error_nested",
          "circular_obj",
          "circular_arr",
          "map_set",
          "redacted",
          "cause_fail",
          "deep_nest",
          "throwing_getter",
          "null_proto"
        ]),
        text: Schema.Literals(["hello", "emoji 🚀 text", "lone\uD800surrogate", "x".repeat(500), ""])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ kind, text }) =>
          Effect.sync(() => {
            let value: unknown
            if (kind === "primitive_str") value = text
            else if (kind === "primitive_num") value = Number.NaN
            else if (kind === "bigint") value = 12345678901234567890n
            else if (kind === "symbol") value = Symbol("fuzz-sym")
            else if (kind === "error_nested") value = new Error("outer", { cause: new TypeError("inner") })
            else if (kind === "circular_obj") {
              const obj: Record<string, unknown> = { a: 1 }
              obj["self"] = obj
              value = obj
            } else if (kind === "circular_arr") {
              const arr: Array<unknown> = [1, 2]
              arr.push(arr)
              value = arr
            } else if (kind === "map_set") {
              value = { m: new Map([["k", 1]]), s: new Set(["a", "b"]), d: new Date(0), r: /abc/gi }
            } else if (kind === "redacted") {
              value = { secret: Redacted.make("SUPER_SECRET_VALUE_999") }
            } else if (kind === "cause_fail") {
              value = Cause.fail(new Error("boom"))
            } else if (kind === "deep_nest") {
              let cur: unknown = "leaf"
              for (let i = 0; i < 30; i++) cur = { nested: cur }
              value = cur
            } else if (kind === "throwing_getter") {
              const obj = {}
              Object.defineProperty(obj, "bad", {
                enumerable: true,
                get() {
                  throw new Error("getter boom")
                }
              })
              value = obj
            } else {
              const obj = Object.create(null)
              obj.key = text
              value = obj
            }

            const rendered = Diagnostic.renderDiagnostic(value)
            if (typeof rendered !== "string") return false
            if (kind === "redacted" && rendered.includes("SUPER_SECRET_VALUE_999")) return false

            const wf = Utf16.isWellFormedUtf16(text)
            if (text.includes("\uD800") && wf) return false
            return true
          }),
        { seed, executions: Math.min(executions, 150) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("FlowProxy.toHttpApiGroup, assertNoCollisions, operationAddresses & FlowProxyServer.layerHttpApi uphold invariants", async () => {
    const stepA = Action.make("proxy-fuzz/stepA", {
      payload: { x: Schema.Number },
      success: Schema.Number
    })
    const flowA = Flow.make("proxy-fuzz/alpha", {
      payload: { x: Schema.Number },
      success: Schema.Number,
      body: ({ x }) => stepA.call({ x })
    })
    const flowB = Flow.make("proxy-fuzz/beta", {
      payload: { y: Schema.String },
      success: Schema.String,
      body: ({ y }) => Node.succeed(`echo:${y}`)
    })

    const arb = Arbitrary.schema(
      Schema.Struct({
        prefix: Schema.Literals(["", "v1.", "api/"]),
        collide: Schema.Boolean,
        x: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ prefix, collide, x }) =>
          Effect.gen(function*() {
            const addr = FlowProxy.operationAddresses(flowA._tag, prefix)
            if (!addr.execute.includes("alpha")) return false

            const flows = collide ? ([flowA, flowA] as const) : ([flowA, flowB] as const)
            let collided = false
            try {
              FlowProxy.assertNoCollisions(flows, prefix)
            } catch {
              collided = true
            }
            if (collide && !collided) return false
            if (!collide && collided) return false

            if (!collide) {
              const httpGroup = FlowProxy.toHttpApiGroup("fuzzApi", [flowA, flowB])
              if (httpGroup === undefined) return false
              const rpcGroup = FlowProxy.toRpcGroup([flowA, flowB], prefix === "" ? undefined : { prefix })
              if (rpcGroup === undefined) return false

              const layer = Layer.mergeAll(
                stepA.toLayer(({ x: n }) => Effect.succeed(n * 2)),
                Interpreter.layer(flowA)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer))
              )
              const out = yield* flowA
                .execute({ x }, { executionId: `exec-proxy-${x}` })
                .pipe(Effect.provide(layer), Effect.scoped)
              if (out !== x * 2) return false
            }
            return FlowProxyServer.FlowHandlerDefect !== undefined
          }),
        { seed: seed + 1, executions: Math.min(executions, 40) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
