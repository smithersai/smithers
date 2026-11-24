import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Fuzz } from "@smthrs/fuzz"
import { Node } from "@smthrs/plan"
import { Arbitrary, Cause, Effect, Exit, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect"
import { Etag, HttpPlatform } from "effect/http"
import { HttpApi, HttpApiTest } from "effect/http-api"
import { RpcTest } from "effect/rpc"
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

            const rendered = Diagnostic.renderDiagnosticWith(Diagnostic.hostReflection(process), value)
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

  it("FlowProxyServer.layerRpcHandlers & layerHttpApi scope execution ids, round-trip results and guard defects", async () => {
    const secret = "proxy-fuzz-secret-XYZ123"
    const arb = Arbitrary.schema(
      Schema.Struct({
        transport: Schema.Literals(["rpc", "http"]),
        prefix: Schema.Literals(["", "v1."]),
        scoping: Schema.Literals(["namespace", "decline", "none"]),
        tenant: Schema.Literals(["tenant-a", "tenant-b", "acme/eu"]),
        clientId: Schema.Literals(["shared", "run-1", "tenant-a:shared", "a b"]),
        dies: Schema.Boolean,
        x: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
        y: Schema.Literals(["", "hello", "emoji 🚀"])
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ transport, prefix, scoping, tenant, clientId, dies, x, y }) =>
          Effect.gen(function*() {
            // Fresh declarations per execution, so one run's engine never answers another's.
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
            const flows = [flowA, flowB] as const
            // The same flow twice claims every operation address twice.
            let collided = false
            try {
              FlowProxy.assertNoCollisions([flowA, flowA], prefix)
            } catch {
              collided = true
            }
            if (!collided) return false
            FlowProxy.assertNoCollisions(flows, prefix)

            let calls = 0
            const dispatched = () => calls
            const engine = Layer.mergeAll(
              stepA.toLayer(({ x: n }) =>
                Effect.suspend(() => {
                  calls++
                  return dies ? Effect.die(new Error(`upstream refused: token=${secret}`)) : Effect.succeed(n * 2)
                })
              ),
              Interpreter.layer(flowA),
              Interpreter.layer(flowB)
            ).pipe(
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer))
            )

            const observed: Array<Parameters<FlowProxyServer.ExecutionIdScope>[0]> = []
            const scopeFor = (owner: string): FlowProxyServer.ExecutionIdScope | undefined =>
              scoping === "none" ? undefined : (input) => {
                observed.push(input)
                return scoping === "namespace" ? `${owner}/${input.clientValue}` : undefined
              }
            const options = (owner: string) => {
              const scope = scopeFor(owner)
              return scope === undefined ? {} : { executionId: scope }
            }
            /** The id the engine must have run under for a request from `owner`. */
            const betaId = `${clientId}.beta`
            const expectedId = (owner: string) => scoping === "namespace" ? `${owner}/${betaId}` : betaId

            /** One execute of each flow as `owner`, over the generated transport. */
            const call = (owner: string) => {
              if (transport === "rpc") {
                const group = FlowProxy.toRpcGroup(flows, { prefix })
                return Effect.gen(function*() {
                  const client = yield* RpcTest.makeClient(group)
                  const alpha = yield* Effect.exit(
                    client[`${prefix}proxy-fuzz/alpha`]({ payload: { x }, executionId: clientId })
                  )
                  const beta = yield* client[`${prefix}proxy-fuzz/beta`]({ payload: { y }, executionId: betaId })
                  return { alpha, beta }
                }).pipe(
                  Effect.provide(FlowProxyServer.layerRpcHandlers(flows, { prefix, ...options(owner) })),
                  Effect.scoped
                )
              }
              const api = HttpApi.make("proxyFuzz").add(FlowProxy.toHttpApiGroup("flows", flows))
              return Effect.gen(function*() {
                const client = yield* HttpApiTest.groups(api, ["flows"])
                const alpha = yield* Effect.exit(
                  client.flows["proxy-fuzz/alpha"]({ payload: { payload: { x }, executionId: clientId } })
                )
                const beta = yield* client.flows["proxy-fuzz/beta"]({
                  payload: { payload: { y }, executionId: betaId }
                })
                return { alpha, beta }
              }).pipe(
                Effect.provide(
                  FlowProxyServer.layerHttpApi(api, "flows", flows, options(owner)).pipe(
                    Layer.provideMerge(HttpTestServices)
                  )
                ),
                Effect.scoped
              )
            }

            return yield* Effect.gen(function*() {
              const first = yield* call(tenant)
              // Round trip: beta echoes its payload; alpha doubles, or is refused without the secret.
              if (first.beta !== `echo:${y}`) return false
              if (dies) {
                if (Exit.isSuccess(first.alpha)) return false
                const rendered = Cause.pretty(first.alpha.cause) + JSON.stringify(Cause.squash(first.alpha.cause))
                if (rendered.includes(secret)) return false
                if (transport === "rpc") {
                  const refusal = Cause.squash(first.alpha.cause)
                  if (!(refusal instanceof FlowProxyServer.FlowHandlerDefect)) return false
                  if (refusal.flowName !== flowA._tag || !refusal.diagnostic.includes("[REDACTED]")) return false
                }
              } else if (!Exit.isSuccess(first.alpha) || first.alpha.value !== x * 2) {
                return false
              }
              if (dispatched() !== 1) return false

              // The scope saw the client's own id and payload for each execute.
              if (scoping !== "none") {
                const seen = observed.map((
                  input
                ) => [input.flow._tag, input.operation, input.clientValue, input.payload])
                const wanted = [
                  [flowA._tag, "execute", clientId, { x }],
                  [flowB._tag, "execute", betaId, { y }]
                ]
                if (JSON.stringify(seen) !== JSON.stringify(wanted)) return false
              }

              // The engine ran under the scoped id, and under no other.
              const ran = (id: string) =>
                flowB.poll(id).pipe(
                  Effect.map(Option.isSome),
                  // An id the engine never ran under is refused as not found.
                  Effect.catch((error) =>
                    String(error).includes("FlowExecutionNotFound") ? Effect.succeed(false) : Effect.fail(error)
                  )
                )
              if (scoping === "decline") {
                // A declining scope leaves the engine to mint an id: the client's names nothing.
                if (yield* ran(betaId)) return false
              } else {
                if (!(yield* ran(expectedId(tenant)))) return false
                if (scoping === "namespace" && (yield* ran(betaId))) return false
              }

              // A second tenant sending the same client id shares the run only without a namespace.
              const other = tenant === "tenant-b" ? "tenant-c" : "tenant-b"
              const second = yield* call(other)
              if (second.beta !== `echo:${y}`) return false
              if (!dies && (!Exit.isSuccess(second.alpha) || second.alpha.value !== x * 2)) return false
              if (scoping === "namespace") {
                if (!(yield* ran(expectedId(other)))) return false
                if (!dies && dispatched() !== 2) return false
              } else if (scoping === "none" && !dies && dispatched() !== 1) {
                return false
              }
              return true
            }).pipe(Effect.provide(engine))
          }),
        { seed: seed + 1, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

const HttpTestServices = Layer.mergeAll(Path.layer, Etag.layerWeak, HttpPlatform.layer).pipe(
  Layer.provideMerge(FileSystem.layerNoop({}))
)
