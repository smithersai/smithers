import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Arbitrary, Effect, Layer, Logger, PlatformError, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { ExitCode, ProcessId } from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as HttpTransport from "../src/internal/HttpTransport.ts"
import * as JsonLimits from "../src/internal/JsonLimits.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"
import { fakeProcess } from "./fixtures/FakeProcess.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])

const jsonResp = (
  req: Parameters<HttpClient.HttpClient["execute"]>[0],
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
    })
  )

const sseResp = (
  req: Parameters<HttpClient.HttpClient["execute"]>[0],
  events: ReadonlyArray<string>,
  headers: Record<string, string> = {}
) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(events.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream", ...headers }
    })
  )

const parseBody = (req: Parameters<HttpClient.HttpClient["execute"]>[0]): Record<string, unknown> => {
  if (req.body._tag === "Uint8Array") {
    return JSON.parse(new TextDecoder().decode(req.body.body)) as Record<string, unknown>
  }
  return {}
}

describe("@smthrs/mcp Wave 10 deep fuzz", () => {
  it(
    "McpClient validates initialize, catalog limits, outputSchema/enumKey, tools/call results, and snapshotArguments",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          scenario: Schema.Literals([
            "badServerName",
            "initBadProtoType",
            "initBadCaps",
            "catalogNonObjTool",
            "catalogLongToolName",
            "catalogForbiddenToolName",
            "catalogToolDocTooLarge",
            "catalogTotalDocTooLarge",
            "catalogBadNextCursor",
            "outputValidEnumAndItems",
            "outputEnumMismatch",
            "outputTypeMismatch",
            "outputMissingRequired",
            "outputNestedPropMismatch",
            "outputArrayItemMismatch",
            "outputMissingStructured",
            "outputIsErrorBypass",
            "resultNonObj",
            "resultNoContentOrStructured",
            "resultNonArrayContent",
            "resultNonObjBlock",
            "resultNonBoolIsError",
            "resultNonObjStructured"
          ])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ scenario }) =>
            Effect.gen(function*() {
              const outputSchema = {
                type: ["object", "null"],
                required: ["id", "tags"],
                properties: {
                  id: { type: "string" },
                  tags: { type: "array", items: { type: "integer" } },
                  choice: { enum: [{ a: 1, b: [2, 3] }, "ok"] }
                }
              }

              const client = HttpClient.make((req) => {
                if (req.method === "DELETE") {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
                }
                const msg = parseBody(req)
                const method = msg.method as string
                const id = msg.id
                if (method === "notifications/initialized") {
                  return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
                }
                if (method === "initialize") {
                  if (scenario === "initBadProtoType") {
                    return Effect.succeed(
                      jsonResp(req, {
                        jsonrpc: "2.0",
                        id,
                        result: { protocolVersion: 123, capabilities: { tools: {} } }
                      })
                    )
                  }
                  if (scenario === "initBadCaps") {
                    return Effect.succeed(
                      jsonResp(req, {
                        jsonrpc: "2.0",
                        id,
                        result: { protocolVersion: "2025-06-18", capabilities: "bad" }
                      })
                    )
                  }
                  return Effect.succeed(jsonResp(req, {
                    jsonrpc: "2.0",
                    id,
                    result: {
                      protocolVersion: "2025-06-18",
                      capabilities: { tools: {} },
                      serverInfo: { name: "srv", version: "1" }
                    }
                  }))
                }
                if (method === "tools/list") {
                  if (scenario === "catalogNonObjTool") {
                    return Effect.succeed(jsonResp(req, { jsonrpc: "2.0", id, result: { tools: ["not-obj"] } }))
                  }
                  if (scenario === "catalogLongToolName") {
                    return Effect.succeed(
                      jsonResp(req, {
                        jsonrpc: "2.0",
                        id,
                        result: { tools: [{ name: "a".repeat(40), inputSchema: { type: "object" } }] }
                      })
                    )
                  }
                  if (scenario === "catalogForbiddenToolName") {
                    return Effect.succeed(
                      jsonResp(req, {
                        jsonrpc: "2.0",
                        id,
                        result: { tools: [{ name: "bad/name", inputSchema: { type: "object" } }] }
                      })
                    )
                  }
                  if (scenario === "catalogToolDocTooLarge") {
                    return Effect.succeed(
                      jsonResp(req, {
                        jsonrpc: "2.0",
                        id,
                        result: {
                          tools: [{ name: "t1", description: "x".repeat(200), inputSchema: { type: "object" } }]
                        }
                      })
                    )
                  }
                  if (scenario === "catalogTotalDocTooLarge") {
                    return Effect.succeed(jsonResp(req, {
                      jsonrpc: "2.0",
                      id,
                      result: {
                        tools: [
                          { name: "t1", description: "x".repeat(80), inputSchema: { type: "object" } },
                          { name: "t2", description: "y".repeat(80), inputSchema: { type: "object" } }
                        ]
                      }
                    }))
                  }
                  if (scenario === "catalogBadNextCursor") {
                    return Effect.succeed(jsonResp(req, { jsonrpc: "2.0", id, result: { tools: [], nextCursor: "" } }))
                  }
                  return Effect.succeed(jsonResp(req, {
                    jsonrpc: "2.0",
                    id,
                    result: {
                      tools: [{ name: "run", inputSchema: { type: "object" }, outputSchema }]
                    }
                  }))
                }
                if (method === "tools/call") {
                  const payload = (() => {
                    switch (scenario) {
                      case "outputValidEnumAndItems":
                        return {
                          content: [{ type: "text", text: "ok" }],
                          structuredContent: { id: "x", tags: [1, 2], choice: { b: [2, 3], a: 1 } }
                        }
                      case "outputEnumMismatch":
                        return { content: [], structuredContent: { id: "x", tags: [1], choice: "nope" } }
                      case "outputTypeMismatch":
                        return { content: [], structuredContent: { id: 123, tags: [1] } }
                      case "outputMissingRequired":
                        return { content: [], structuredContent: { id: "x" } }
                      case "outputNestedPropMismatch":
                        return { content: [], structuredContent: { id: "x", tags: "not-array" } }
                      case "outputArrayItemMismatch":
                        return { content: [], structuredContent: { id: "x", tags: ["bad"] } }
                      case "outputMissingStructured":
                        return { content: [{ type: "text", text: "no structured" }] }
                      case "outputIsErrorBypass":
                        return { content: [{ type: "text", text: "err" }], isError: true }
                      case "resultNonObj":
                        return "string-not-obj"
                      case "resultNoContentOrStructured":
                        return {}
                      case "resultNonArrayContent":
                        return { content: "nope" }
                      case "resultNonObjBlock":
                        return { content: [42] }
                      case "resultNonBoolIsError":
                        return { content: [], isError: "yes" }
                      case "resultNonObjStructured":
                        return { content: [], structuredContent: [1, 2] }
                      default:
                        return { content: [] }
                    }
                  })()
                  return Effect.succeed(jsonResp(req, { jsonrpc: "2.0", id, result: payload }))
                }
                return Effect.succeed(jsonResp(req, { jsonrpc: "2.0", id, result: {} }))
              })

              const layer = Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), silentLogger)
              const connectOpts: McpClient.HttpConnectOptions = {
                server: scenario === "badServerName" ? "bad/server" : "srv",
                url: "https://mcp.example.com/rpc",
                maxToolNameBytes: 16,
                maxToolDocumentBytes: scenario === "catalogToolDocTooLarge" ? 120 : 4096,
                maxCatalogDocumentBytes: scenario === "catalogTotalDocTooLarge" ? 150 : 8192
              }

              const outcome = yield* Effect.scoped(
                Effect.gen(function*() {
                  const mcp = yield* McpClient.connect(connectOpts)
                  if (scenario === "outputValidEnumAndItems" || scenario === "outputIsErrorBypass") {
                    const res = yield* mcp.callTool("run", { arr: [1, 2], nested: { ok: true } })
                    // Also test McpFlows with description-less tool and publicError
                    const source = McpFlows.mcp(mcp)
                    const [binding] = yield* source.bindings()
                    const hasDesc = binding !== undefined && binding.descriptor.description.includes("run")
                    return (scenario === "outputIsErrorBypass"
                      ? res.isError === true
                      : res.structuredContent !== undefined) && hasDesc
                  }
                  const callRes = yield* Effect.result(mcp.callTool("run", {}))
                  return Result.isFailure(callRes)
                })
              ).pipe(Effect.result, Effect.provide(layer))

              if (
                scenario === "badServerName" ||
                scenario === "initBadProtoType" ||
                scenario === "initBadCaps" ||
                scenario.startsWith("catalog")
              ) {
                return Result.isFailure(outcome)
              }
              return Result.isSuccess(outcome) && outcome.success === true
            }),
          { seed, executions: Math.min(executions, 100) }
        )
      )
      const failure = Fuzz.formatReport(report)
      if (failure !== undefined) throw new Error(failure)

      // Exercise every snapshotArguments / snapshotJson rejection path
      const argClient = HttpClient.make((req) => {
        if (req.method === "DELETE") {
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
        }
        const msg = parseBody(req)
        if (msg.method === "notifications/initialized") {
          return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
        }
        if (msg.method === "initialize") {
          return Effect.succeed(
            jsonResp(req, {
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            })
          )
        }
        if (msg.method === "tools/list") {
          return Effect.succeed(
            jsonResp(req, {
              jsonrpc: "2.0",
              id: msg.id,
              result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            })
          )
        }
        return Effect.succeed(jsonResp(req, { jsonrpc: "2.0", id: msg.id, result: { content: [] } }))
      })
      const argLayer = Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, argClient), silentLogger)

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const mcp = yield* McpClient.connect({
              server: "argsrv",
              url: "https://mcp.example.com/rpc",
              maxOutboundFrameBytes: 512
            })
            const cyc: Record<string, unknown> = {}
            cyc.self = cyc
            let deep: unknown = 1
            for (let i = 0; i < 130; i++) deep = { d: deep }
            const arrWithGetter: Array<unknown> = [1]
            Object.defineProperty(arrWithGetter, 0, { get: () => 1, enumerable: true })
            const sparseArr: Array<unknown> = []
            sparseArr.length = 2
            const objWithHidden: Record<string, unknown> = { ok: 1 }
            Object.defineProperty(objWithHidden, "hidden", { value: 2, enumerable: false })
            const objWithGetter = {
              get x() {
                return 1
              }
            }
            const objWithSym: Record<PropertyKey, unknown> = { [Symbol("s")]: 1 }
            const throwingProxy = new Proxy({}, {
              getPrototypeOf() {
                throw new Error("boom")
              }
            })

            // Non-enumerable prop is skipped and succeeds
            const okRes = yield* mcp.callTool("echo", objWithHidden)
            expect(okRes.isError).toBe(false)

            const badArgs: Array<unknown> = [
              { n: Number.NaN },
              { u: undefined },
              { b: 1n },
              { f: () => 1 },
              { s: Symbol("x") },
              cyc,
              deep,
              { a: arrWithGetter },
              { a: sparseArr },
              { a: [Number.POSITIVE_INFINITY] },
              { a: new Array(600).fill(0) },
              { d: new Date() },
              objWithSym,
              objWithGetter,
              { big: "x".repeat(600) },
              throwingProxy,
              [1, 2, 3],
              null
            ]
            for (const bad of badArgs) {
              const r = yield* Effect.result(mcp.callTool("echo", bad as Record<string, unknown>))
              expect(Result.isFailure(r)).toBe(true)
            }
          })
        ).pipe(Effect.provide(argLayer))
      )

      // JsonLimits + Rpc edge cases
      expect(JsonLimits.checkParsed({ a: Number.POSITIVE_INFINITY })).toContain("finite")
      expect(Rpc.classify({ jsonrpc: "2.0", method: 123 as unknown as string })._tag).toBe("Malformed")
      expect(Rpc.classify({ jsonrpc: "2.0", method: "ping", id: 1.5 })._tag).toBe("Malformed")
    },
    60_000
  )

  it(
    "HttpTransport & StdioTransport cover redirects, SSE server-requests/errors/timeouts, scope close, and cancellation",
    async () => {
      const layer = silentLogger

      // Invalid URLs in HttpTransport.connect
      for (const badUrl of [":::not-a-url", "ftp://mcp.example.com", "https://user:pass@mcp.example.com"]) {
        const dummyClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((req) => Effect.succeed(jsonResp(req, {})))
        )
        const r = await Effect.runPromise(
          Effect.scoped(HttpTransport.connect({ server: "h", url: badUrl })).pipe(
            Effect.result,
            Effect.provide(Layer.mergeAll(dummyClient, layer))
          )
        )
        expect(Result.isFailure(r)).toBe(true)
      }

      // HttpTransport: redirect latches terminal error, non-202 / non-empty 202 on notify, SSE with server request limit, SSE malformed, SSE error reply, SSE empty stream, request timeout + cancellation, post after scope closed
      const httpModes = [
        "redirectLatch",
        "notifyNon202",
        "notify202WithBody",
        "sseTooManyServerRequests",
        "sseMalformed",
        "sseErrorReply",
        "sseEmptyNoReply",
        "sseBadJsonDepth",
        "requestTimeoutAndCancel",
        "invalidTimeouts",
        "postAfterClose"
      ] as const

      for (const mode of httpModes) {
        let cancelSeen = false
        const client = HttpClient.make((req) => {
          if (req.method === "DELETE") {
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
          }
          const msg = parseBody(req)
          if (msg.method === "notifications/cancelled") {
            cancelSeen = true
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
          }
          if (mode === "redirectLatch") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                req,
                new Response(null, { status: 302, headers: { location: "https://other" } })
              )
            )
          }
          if (mode === "notifyNon202") {
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("{}", { status: 200 })))
          }
          if (mode === "notify202WithBody") {
            return Effect.succeed(HttpClientResponse.fromWeb(req, new Response("body", { status: 202 })))
          }
          if (mode === "sseTooManyServerRequests") {
            if (msg.method === undefined) {
              return Effect.succeed(HttpClientResponse.fromWeb(req, new Response(null, { status: 202 })))
            }
            const events = Array.from(
              { length: 5 },
              (_, i) => `data: ${JSON.stringify({ jsonrpc: "2.0", id: `s${i}`, method: "ping" })}\n\n`
            )
            return Effect.succeed(sseResp(req, events))
          }
          if (mode === "sseMalformed") {
            return Effect.succeed(sseResp(req, [`data: ${JSON.stringify({ jsonrpc: "1.0", id: msg.id })}\n\n`]))
          }
          if (mode === "sseErrorReply") {
            return Effect.succeed(
              sseResp(req, [
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "boom" } })}\n\n`
              ])
            )
          }
          if (mode === "sseEmptyNoReply") {
            return Effect.succeed(
              sseResp(req, [`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`])
            )
          }
          if (mode === "sseBadJsonDepth") {
            let deep = "1"
            for (let i = 0; i < 130; i++) deep = `{"a":${deep}}`
            return Effect.succeed(sseResp(req, [`data: {"jsonrpc":"2.0","id":${msg.id},"result":${deep}}\n\n`]))
          }
          if (mode === "requestTimeoutAndCancel") {
            return Effect.sleep("250 millis").pipe(Effect.as(jsonResp(req, { jsonrpc: "2.0", id: msg.id, result: {} })))
          }
          return Effect.succeed(jsonResp(req, { jsonrpc: "2.0", id: msg.id, result: {} }))
        })

        const httpLayer = Layer.mergeAll(Layer.succeed(HttpClient.HttpClient, client), layer)
        if (mode === "postAfterClose") {
          const transport = await Effect.runPromise(
            Effect.scoped(HttpTransport.connect({ server: "h", url: "https://mcp.example.com/rpc" })).pipe(
              Effect.provide(httpLayer)
            )
          )
          const r = await Effect.runPromise(Effect.result(transport.request("tools/list")))
          expect(Result.isFailure(r)).toBe(true)
          continue
        }

        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const transport = yield* HttpTransport.connect({
                server: "h",
                url: "https://mcp.example.com/rpc",
                maxServerRequests: 2
              })
              if (mode === "redirectLatch") {
                const r1 = yield* Effect.result(transport.request("tools/list"))
                const r2 = yield* Effect.result(transport.request("tools/list"))
                expect(Result.isFailure(r1) && Result.isFailure(r2)).toBe(true)
              } else if (mode === "notifyNon202" || mode === "notify202WithBody") {
                const r = yield* Effect.result(transport.notify("notifications/initialized"))
                expect(Result.isFailure(r)).toBe(true)
              } else if (mode === "requestTimeoutAndCancel") {
                const r = yield* Effect.result(transport.request("tools/list", {}, 25))
                expect(Result.isFailure(r)).toBe(true)
                yield* Effect.sleep("20 millis")
                expect(cancelSeen).toBe(true)
              } else if (mode === "invalidTimeouts") {
                const r1 = yield* Effect.result(transport.request("tools/list", {}, 0))
                const r2 = yield* Effect.result(transport.notify("notifications/initialized", {}, -1))
                expect(Result.isFailure(r1) && Result.isFailure(r2)).toBe(true)
              } else {
                const r = yield* Effect.result(transport.request("tools/list"))
                expect(Result.isFailure(r)).toBe(true)
              }
            })
          ).pipe(Effect.provide(httpLayer))
        )
      }

      // StdioTransport: timeout + cancellation notification, request/notify after close, env option, stdout failure
      const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeProcess({ pid: ProcessId(42) }))
      const closedTransport = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const t = yield* StdioTransport.connect({
              server: "stdio-w10",
              command: "fake-mcp",
              args: [],
              env: { EXTRA_FLAG: "1" },
              requestTimeoutMs: 40
            })
            const r = yield* Effect.result(t.request("tools/list", {}, 30))
            expect(Result.isFailure(r)).toBe(true)
            return t
          })
        ).pipe(Effect.provide(Layer.mergeAll(spawnerLayer, layer)))
      )
      const afterReq = await Effect.runPromise(Effect.result(closedTransport.request("tools/list")))
      const afterNot = await Effect.runPromise(Effect.result(closedTransport.notify("notifications/initialized")))
      expect(Result.isFailure(afterReq) && Result.isFailure(afterNot)).toBe(true)

      // StdioTransport stdout failure and exitCode failure / non-zero exit
      const failErr = PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "spawn" })
      for (
        const overrides of [
          { pid: ProcessId(43), stdout: Stream.fail(failErr) },
          { pid: ProcessId(44), exitCode: Effect.fail(failErr) },
          { pid: ProcessId(45), exitCode: Effect.succeed(ExitCode(7)) }
        ]
      ) {
        const spLayer = Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fakeProcess(overrides)),
          layer
        )
        const r = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function*() {
              const t = yield* StdioTransport.connect({
                server: "stdio-err",
                command: "fake-mcp",
                args: [],
                requestTimeoutMs: 200
              })
              return yield* Effect.result(t.request("tools/list"))
            })
          ).pipe(Effect.provide(spLayer))
        )
        expect(Result.isFailure(r)).toBe(true)
      }
    },
    60_000
  )
})
