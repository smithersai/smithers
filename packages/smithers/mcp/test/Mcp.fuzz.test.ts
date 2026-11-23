import * as Cell from "@smthrs/harness/Cell"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import { Arbitrary, Effect, Logger, Option, Redacted, Result, Schema, Stream } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientError from "effect/http/HttpClientError"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import { describe, expect, it } from "vitest"
import * as Mcp from "../src/index.ts"
import * as DiagnosticReporter from "../src/internal/DiagnosticReporter.ts"
import * as JsonLimits from "../src/internal/JsonLimits.ts"
import * as Limits from "../src/internal/Limits.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as Transport from "../src/internal/Transport.ts"
import { fakeServer, respondToEcho } from "./fixtures/FakeServer.ts"
import { provideSpawner } from "./fixtures/FakeProcess.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "150"))
const pureExecutions = Math.max(24, Math.min(baseExecutions, 180))
const ioExecutions = Math.max(16, Math.min(Math.ceil(baseExecutions / 3), 50))
const simExecutions = Math.max(12, Math.min(Math.ceil(baseExecutions / 5), 28))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const silentLogger = Logger.layer([])

const runFuzz = async <A, E>(
  arb: Parameters<typeof Fuzz.run<A, E>>[0],
  predicate: (value: A) => Effect.Effect<boolean, E, never>,
  options: { readonly seed: number; readonly executions: number; readonly execution?: Fuzz.Execution }
) => {
  const report = await Effect.runPromise(
    Fuzz.run(
      arb,
      (value) => predicate(value).pipe(Effect.provide(silentLogger)),
      options
    )
  )
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

const SafeName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,14}$/))
const AsciiText = Schema.String.check(Schema.isPattern(/^[\x20-\x7e]{0,64}$/))

const makeHttpMock = (
  handler: (req: {
    readonly method: string
    readonly url: string
    readonly headers: Record<string, string>
    readonly body: Record<string, unknown> | undefined
  }) => {
    readonly status?: number
    readonly contentType?: string
    readonly headers?: Record<string, string>
    readonly body?: string
    readonly fail?: boolean
  }
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function*() {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(request.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v
      }
      let body: Record<string, unknown> | undefined
      if (request.body._tag === "Uint8Array") {
        const text = new TextDecoder().decode(request.body.body)
        body = text.trim() === "" ? undefined : JSON.parse(text) as Record<string, unknown>
      }
      const res = handler({ method: request.method, url: request.url, headers, body })
      if (res.fail === true) {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("transport failed") })
          })
        )
      }
      const respHeaders = new Headers(res.headers)
      if (res.contentType !== undefined) respHeaders.set("content-type", res.contentType)
      const status = res.status ?? 200
      const webResponse = new Response(status === 204 ? null : (res.body ?? ""), {
        status,
        headers: respHeaders
      })
      return HttpClientResponse.fromWeb(request, webResponse)
    })
  )

describe("@smthrs/mcp fuzz", () => {
  it("fuzzes McpError, Diagnostics, DiagnosticReporter, Limits, and JsonLimits", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        code: Mcp.McpError.Code,
        message: AsciiText,
        source: Schema.Literals([
          "spawn",
          "stderr",
          "transport",
          "remote-error",
          "invalid-response",
          "invalid-arguments"
        ]),
        largeDetail: Schema.Boolean,
        throwInObserver: Schema.Boolean,
        depth: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 135 })),
        badIntKind: Schema.Literals(["zero", "neg", "frac", "nan", "inf", "ok"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const err = new Mcp.McpError.McpError({ code: v.code, message: v.message, server: v.server })
          const encoded = Schema.encodeSync(Mcp.McpError.McpError)(err)
          const decoded = Schema.decodeUnknownSync(Mcp.McpError.McpError)(encoded)
          expect(decoded.code).toBe(v.code)
          expect(decoded.server).toBe(v.server)

          // Limits
          const badInt = v.badIntKind === "zero" ? 0 : v.badIntKind === "neg" ? -1 : v.badIntKind === "frac" ? 1.5 : v.badIntKind === "nan" ? Number.NaN : v.badIntKind === "inf" ? Number.POSITIVE_INFINITY : 10
          expect(Limits.isPositiveInteger(badInt)).toBe(badInt === 10)
          const checked = yield* Effect.result(Limits.checkPositiveIntegers(v.server, [["timeoutMs", badInt]]))
          if (badInt === 10) expect(Result.isSuccess(checked)).toBe(true)
          else expect(Result.isFailure(checked) && checked.failure.code === "protocol_error").toBe(true)

          // JsonLimits depth + reserved keys + freezeParsed
          let nested: unknown = { leaf: v.message }
          for (let i = 0; i < v.depth; i++) nested = i % 2 === 0 ? { child: nested } : [nested]
          const depthIssue = JsonLimits.checkParsed(nested)
          if (v.depth + 1 > JsonLimits.maxDepth) {
            expect(depthIssue).toBeDefined()
          } else {
            expect(depthIssue).toBeUndefined()
            JsonLimits.freezeParsed(nested)
            expect(Object.isFrozen(nested)).toBe(true)
          }
          let tooDeep: unknown = 1
          for (let i = 0; i <= JsonLimits.maxDepth + 2; i++) tooDeep = [tooDeep]
          expect(JsonLimits.checkParsed(tooDeep)).toBeDefined()

          // Diagnostics & DiagnosticReporter (with observer, throwing observer, and absent observer)
          const events: Array<Mcp.Diagnostics.Event> = []
          const payload = v.largeDetail ? "x".repeat(20_000) : v.message
          const reporter = yield* DiagnosticReporter.make(v.server).pipe(
            Effect.provide(
              Mcp.Diagnostics.layer((ev) => {
                events.push(ev)
                if (v.throwInObserver) throw new Error("observer boom")
              })
            )
          )
          reporter(v.source, payload)
          expect(events.length).toBe(1)
          expect(events[0]!.server).toBe(v.server)
          expect(events[0]!.source).toBe(v.source)
          expect(events[0]!.truncated).toBe(v.largeDetail)
          expect(Redacted.value(events[0]!.detail).length).toBeLessThanOrEqual(16_384)

          // Absent observer discards cleanly
          const noopReporter = yield* DiagnosticReporter.make(v.server)
          noopReporter(v.source, payload)
          return true
        }),
      { seed: seed + 1, executions: pureExecutions }
    )
  })

  it("fuzzes Rpc parse/encode/replyOf/classify and Transport.lines/replyError", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        idKind: Schema.Literals(["num", "str", "null", "none", "invalid"]),
        idNum: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 500 })),
        method: SafeName,
        errCode: Schema.Literals([-32601, -32602, -32000, -32603]),
        errMsgKind: Schema.Literals(["unknown-tool", "generic"]),
        rpcMethod: Schema.Literals(["tools/call", "tools/list", "initialize"]),
        chunks: Schema.Array(AsciiText).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
        crTerminates: Schema.Boolean,
        delim: Schema.Literals(["\n", "\r\n", "\r"]),
        maxLineBytes: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 256 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          // Rpc.encode & parse roundtrip
          const encoded = Rpc.encode({ jsonrpc: "2.0", id: v.idNum, method: v.method, params: { ok: true } })
          const decodedText = new TextDecoder().decode(encoded)
          expect(decodedText.endsWith("\n")).toBe(true)
          const parsedReq = Rpc.parse(decodedText.trim())
          expect(parsedReq).toBeDefined()
          if (parsedReq !== undefined) {
            expect(Rpc.classify(parsedReq)._tag).toBe("Request")
          }

          // Notification
          const notif = Rpc.parse(JSON.stringify({ jsonrpc: "2.0", method: v.method }))
          expect(notif).toBeDefined()
          if (notif !== undefined) {
            expect(Rpc.classify(notif)._tag).toBe("Notification")
          }

          // Reply variants
          const id = v.idKind === "num"
            ? v.idNum
            : v.idKind === "str"
            ? `id-${v.idNum}`
            : v.idKind === "null"
            ? null
            : v.idKind === "invalid"
            ? { bad: 1 }
            : undefined

          const resultLine = JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), result: { ok: 1 } })
          const parsedRes = Rpc.parse(resultLine)
          if (parsedRes !== undefined) {
            const cls = Rpc.classify(parsedRes)
            if (cls._tag === "Result") {
              expect(cls.result).toEqual({ ok: 1 })
            }
          }

          const errMessage = v.errMsgKind === "unknown-tool" ? "Unknown tool requested" : "boom failure"
          const errLine = JSON.stringify({
            jsonrpc: "2.0",
            id: v.idNum,
            error: { code: v.errCode, message: errMessage }
          })
          const parsedErr = Rpc.parse(errLine)
          expect(parsedErr).toBeDefined()
          if (parsedErr !== undefined) {
            const reply = Rpc.replyOf(parsedErr)
            expect(reply._tag).toBe("Error")
            if (reply._tag === "Error") {
              const mcpErr = Transport.replyError(v.server, v.rpcMethod, reply)
              if (v.rpcMethod === "tools/call") {
                const expected = (v.errCode === -32601 || v.errCode === -32602) && v.errMsgKind === "unknown-tool"
                  ? "tool_not_found"
                  : "tool_failed"
                expect(mcpErr.code).toBe(expected)
              } else {
                expect(mcpErr.code).toBe("protocol_error")
              }
            }
          }

          // Malformed lines
          expect(Rpc.parse("")).toBeUndefined()
          expect(Rpc.parse("not-json")).toBeUndefined()
          expect(Rpc.parse("[]")).toBeUndefined()
          const badVer = Rpc.parse(JSON.stringify({ jsonrpc: "1.0", id: 1, result: {} }))
          if (badVer !== undefined) expect(Rpc.classify(badVer)._tag).toBe("Malformed")
          const invalidReply = Rpc.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "x" } }))
          if (invalidReply !== undefined) {
            expect(Rpc.replyOf(invalidReply)._tag).toBe("Malformed")
          }
          const invalidErrObj = Rpc.parse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: "bad", message: 1 } }))
          if (invalidErrObj !== undefined) {
            expect(Rpc.replyOf(invalidErrObj)._tag).toBe("Malformed")
          }
          const missingBoth = Rpc.parse(JSON.stringify({ jsonrpc: "2.0", id: 1 }))
          if (missingBoth !== undefined) {
            expect(Rpc.replyOf(missingBoth)._tag).toBe("Malformed")
          }

          // Transport.lines across arbitrary chunk boundaries
          const encoder = new TextEncoder()
          const joined = v.chunks.join(v.delim)
          const rawBytes = encoder.encode(joined)
          const pieces: Array<Uint8Array> = [new Uint8Array(0)]
          for (let i = 0; i < rawBytes.length; i += 3) {
            pieces.push(rawBytes.subarray(i, Math.min(i + 3, rawBytes.length)))
          }
          const res = yield* Effect.result(
            Stream.runCollect(
              Transport.lines(v.server, v.maxLineBytes, Stream.fromIterable(pieces), { crTerminates: v.crTerminates })
            )
          )
          if (Result.isFailure(res)) {
            expect(res.failure.code).toBe("protocol_error")
          } else {
            expect(Array.isArray(res.success)).toBe(true)
          }

          expect(Transport.closed(v.server, "eof").code).toBe("connection_closed")
          expect(Transport.timeout(v.server, "tools/call", 500).code).toBe("timeout")
          return true
        }),
      { seed: seed + 2, executions: pureExecutions }
    )
  })

  it("fuzzes McpClient stdio connect, pagination, structured results, tool calls, and McpFlows projection", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        a: Schema.Int.check(Schema.isBetween({ minimum: -500, maximum: 500 })),
        b: Schema.Int.check(Schema.isBetween({ minimum: -500, maximum: 500 })),
        structured: Schema.Boolean,
        paginated: Schema.Boolean,
        toolError: Schema.Boolean,
        includeFilter: Schema.Literals(["all", "valid", "missing"]),
        delimiter: Schema.Literals(["\n", "\r\n"])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const spawner = yield* fakeServer(
            (request) => {
              if (request.method === "initialize") {
                return {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: v.server, version: "1.0" }
                }
              }
              if (request.method === "tools/list") {
                const cursor = (request.params as { cursor?: string } | undefined)?.cursor
                if (v.paginated && cursor === undefined) {
                  return {
                    tools: [{
                      name: "add",
                      description: "Adds numbers",
                      inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
                      ...(v.structured
                        ? { outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] } }
                        : {})
                    }],
                    nextCursor: "page-2"
                  }
                }
                if (v.paginated && cursor === "page-2") {
                  return {
                    tools: [{
                      name: "echo",
                      description: "Echoes text",
                      inputSchema: { type: "object", properties: { text: { type: "string" } } }
                    }]
                  }
                }
                return {
                  tools: [{
                    name: "add",
                    description: "Adds numbers",
                    inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
                    ...(v.structured
                      ? { outputSchema: { type: "object", properties: { sum: { type: "number" } }, required: ["sum"] } }
                      : {})
                  }]
                }
              }
              if (request.method === "tools/call") {
                const params = request.params as { name: string; arguments: Record<string, unknown> }
                if (params.name === "add") {
                  const sum = Number(params.arguments.a) + Number(params.arguments.b)
                  return {
                    content: [{ type: "text", text: String(sum) }],
                    isError: v.toolError,
                    ...(v.structured && !v.toolError ? { structuredContent: { sum } } : {})
                  }
                }
                if (params.name === "echo") {
                  return { content: [{ type: "text", text: String(params.arguments.text ?? "") }] }
                }
              }
              return undefined
            },
            { delimiter: v.delimiter }
          )

          const events: Array<Mcp.Diagnostics.Event> = []
          const result = yield* Effect.scoped(
            provideSpawner(
              Effect.gen(function*() {
                const client = yield* Mcp.McpClient.connect({
                  server: v.server,
                  command: "fake-mcp",
                  args: []
                })
                expect(client.server).toBe(v.server)
                expect(client.tools.length).toBeGreaterThanOrEqual(1)

                const callRes = yield* client.callTool("add", { a: v.a, b: v.b })
                expect(callRes.isError).toBe(v.toolError)
                if (v.structured && !v.toolError) {
                  expect(callRes.structuredContent).toEqual({ sum: v.a + v.b })
                }

                // Unknown tool fails with tool_not_found
                const missingRes = yield* Effect.result(client.callTool("nonexistent-tool", {}))
                expect(Result.isFailure(missingRes) && missingRes.failure.code === "tool_not_found").toBe(true)

                // Invalid non-object arguments
                const badArgs = yield* Effect.result(client.callTool("add", { bad: BigInt(1) as unknown }))
                expect(Result.isFailure(badArgs)).toBe(true)

                // McpFlows projection
                const projOpts = v.includeFilter === "all"
                  ? {}
                  : v.includeFilter === "valid"
                  ? { include: ["add"] }
                  : { include: ["does-not-exist"] }
                const source = Mcp.McpFlows.mcp(client, projOpts)
                const bindingsRes = yield* Effect.result(source.bindings())
                expect(Result.isSuccess(bindingsRes)).toBe(true)
                if (Result.isSuccess(bindingsRes)) {
                  if (v.includeFilter === "missing") {
                    expect(bindingsRes.success.length).toBe(0)
                  } else {
                    expect(bindingsRes.success.length).toBeGreaterThanOrEqual(1)
                    expect(bindingsRes.success[0]!.descriptor.name).toBe(`mcp/${v.server}/add`)
                  }
                }
                return true
              }),
              spawner
            )
          ).pipe(Effect.provide(Mcp.Diagnostics.layer((e) => events.push(e))))

          expect(result).toBe(true)
          return true
        }),
      { seed: seed + 3, executions: ioExecutions }
    )
  })

  it("fuzzes McpClient stdio error paths (bad handshake, bad catalog, duplicate tools, cursor loop, remote errors)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        fault: Schema.Literals([
          "bad-protocol-version",
          "missing-tools-capability",
          "invalid-initialize-result",
          "bad-catalog-shape",
          "duplicate-tool",
          "too-many-tools",
          "cursor-cycle",
          "too-many-pages",
          "bad-tool-name",
          "bad-input-schema",
          "bad-output-schema",
          "remote-rpc-error-init",
          "remote-rpc-error-call",
          "remote-unknown-tool-call",
          "invalid-call-content",
          "missing-structured-content",
          "bad-options-max-frame",
          "bad-options-timeout",
          "close-after-init"
        ])
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          let page = 0
          const spawner = yield* fakeServer(
            (request) => {
              if (request.method === "initialize") {
                if (v.fault === "bad-protocol-version") {
                  return { protocolVersion: "1999-01-01", capabilities: { tools: {} } }
                }
                if (v.fault === "missing-tools-capability") {
                  return { protocolVersion: "2025-06-18", capabilities: {} }
                }
                if (v.fault === "invalid-initialize-result") {
                  return "not-an-object"
                }
                return { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              }
              if (request.method === "tools/list") {
                page += 1
                if (v.fault === "bad-catalog-shape") return { tools: "nope" }
                if (v.fault === "duplicate-tool") {
                  return {
                    tools: [
                      { name: "dup", inputSchema: { type: "object" } },
                      { name: "dup", inputSchema: { type: "object" } }
                    ]
                  }
                }
                if (v.fault === "too-many-tools") {
                  return {
                    tools: [
                      { name: "t1", inputSchema: { type: "object" } },
                      { name: "t2", inputSchema: { type: "object" } },
                      { name: "t3", inputSchema: { type: "object" } }
                    ]
                  }
                }
                if (v.fault === "cursor-cycle") {
                  return {
                    tools: [{ name: `t${page}`, inputSchema: { type: "object" } }],
                    nextCursor: "same-cursor"
                  }
                }
                if (v.fault === "too-many-pages") {
                  return {
                    tools: [{ name: `t${page}`, inputSchema: { type: "object" } }],
                    nextCursor: `p-${page}`
                  }
                }
                if (v.fault === "bad-tool-name") {
                  return { tools: [{ name: "", inputSchema: { type: "object" } }] }
                }
                if (v.fault === "bad-input-schema") {
                  return { tools: [{ name: "t1", inputSchema: { type: "string" } }] }
                }
                if (v.fault === "bad-output-schema") {
                  return { tools: [{ name: "t1", inputSchema: { type: "object" }, outputSchema: "bad" }] }
                }
                if (v.fault === "missing-structured-content") {
                  return {
                    tools: [{
                      name: "add",
                      inputSchema: { type: "object" },
                      outputSchema: { type: "object" }
                    }]
                  }
                }
                return respondToEcho(request)
              }
              if (request.method === "tools/call") {
                if (v.fault === "invalid-call-content") return { content: "not-array" }
                if (v.fault === "missing-structured-content") return { content: [{ type: "text", text: "1" }], structuredContent: "not-an-object" }
                return respondToEcho(request)
              }
              return undefined
            },
            {
              closeAfterReply: v.fault === "close-after-init",
              envelope: (request, result) => {
                if (v.fault === "remote-rpc-error-init" && request.method === "initialize") {
                  return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "init failed" } }
                }
                if (v.fault === "remote-rpc-error-call" && request.method === "tools/call") {
                  return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "exec crashed" } }
                }
                if (v.fault === "remote-unknown-tool-call" && request.method === "tools/call") {
                  return { jsonrpc: "2.0", id: request.id, error: { code: -32602, message: "Unknown tool add" } }
                }
                return { jsonrpc: "2.0", id: request.id, result }
              }
            }
          )

          const res = yield* Effect.scoped(
            provideSpawner(
              Effect.gen(function*() {
                const opts: Mcp.McpClient.StdioConnectOptions = {
                  server: v.server,
                  command: "fake-mcp",
                  args: [],
                  ...(v.fault === "bad-options-max-frame" ? { maxFrameBytes: 0 } : {}),
                  ...(v.fault === "bad-options-timeout" ? { requestTimeoutMs: -5 } : {}),
                  ...(v.fault === "too-many-tools" ? { maxTools: 2 } : {}),
                  ...(v.fault === "too-many-pages" ? { maxCatalogPages: 2 } : {})
                }
                const client = yield* Mcp.McpClient.connect(opts)
                return yield* client.callTool("add", { a: 1, b: 2 })
              }),
              spawner
            )
          ).pipe(Effect.result)

          expect(Result.isFailure(res)).toBe(true)
          if (Result.isFailure(res)) {
            expect(Mcp.McpError.Code.literals).toContain(res.failure.code)
          }
          return true
        }),
      { seed: seed + 4, executions: Math.max(ioExecutions, 65) }
    )
  })

  it("fuzzes Streamable HTTP transport (JSON, SSE, sessions, auth, 401/403/404/500, unsafe URLs, and McpFlows.connected)", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        mode: Schema.Literals([
          "json-ok",
          "sse-ok",
          "auth-https-ok",
          "auth-loopback-ok",
          "auth-http-refused",
          "bad-url",
          "status-401",
          "status-404",
          "status-500",
          "transport-error",
          "wrong-content-type",
          "sse-invalid-json",
          "session-delete-on-close"
        ]),
        a: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
        b: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          let sawDelete = false
          const httpDiags: Array<string> = []
          const http = makeHttpMock(({ method, body, headers }) => {
            if (method === "DELETE") {
              sawDelete = true
              return { status: 204 }
            }
            if (v.mode === "transport-error") return { fail: true }
            if (v.mode === "status-401") return { status: 401, contentType: "text/plain", body: "unauth" }
            if (v.mode === "status-404") return { status: 404, contentType: "text/plain", body: "missing" }
            if (v.mode === "status-500") return { status: 500, contentType: "text/plain", body: "oops" }
            if (v.mode === "wrong-content-type") return { status: 200, contentType: "text/plain", body: "hello" }

            const rpcMethod = body?.method
            const id = body?.id
            if (id === undefined) {
              // Notification (e.g. notifications/initialized)
              return { status: 202 }
            }

            let result: unknown = {}
            if (rpcMethod === "initialize") {
              result = { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            } else if (rpcMethod === "tools/list") {
              result = {
                tools: [{
                  name: "add",
                  description: "Add two numbers",
                  inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }
                }]
              }
            } else if (rpcMethod === "tools/call") {
              const args = (body?.params as { arguments: { a: number; b: number } }).arguments
              result = { content: [{ type: "text", text: String(args.a + args.b) }] }
            }

            const payload = { jsonrpc: "2.0", id, result }
            const respHeaders: Record<string, string> = { "mcp-session-id": "sess-1" }
            if (v.mode === "auth-https-ok" || v.mode === "auth-loopback-ok") {
              expect(headers["authorization"]).toBe("Bearer secret-tok")
            }

            if (v.mode === "sse-ok") {
              return {
                status: 200,
                contentType: "text/event-stream",
                headers: respHeaders,
                body: `: comment\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`
              }
            }
            if (v.mode === "sse-invalid-json") {
              return {
                status: 200,
                contentType: "text/event-stream",
                headers: respHeaders,
                body: `data: {broken\n\n`
              }
            }
            return {
              status: 200,
              contentType: "application/json",
              headers: respHeaders,
              body: JSON.stringify(payload)
            }
          })

          const url = v.mode === "bad-url"
            ? "ftp://not-http.example/mcp"
            : v.mode === "auth-http-refused"
            ? "http://remote.example.test/mcp"
            : v.mode === "auth-loopback-ok"
            ? "http://127.0.0.1:8080/mcp"
            : "https://mcp.example.test/mcp"

          const authProvider = (v.mode === "auth-https-ok" || v.mode === "auth-loopback-ok" || v.mode === "auth-http-refused")
            ? { token: Effect.succeed(Redacted.make("secret-tok")) }
            : undefined

          const res = yield* Effect.scoped(
            Effect.gen(function*() {
              const opts: Mcp.McpClient.HttpConnectOptions = {
                server: v.server,
                url,
                ...(authProvider !== undefined ? { authProvider } : {})
              }
              if (v.mode === "json-ok") {
                const source = yield* Mcp.McpFlows.connected(opts)
                const bindings = yield* source.bindings()
                expect(bindings.length).toBe(1)
                return { ok: true }
              }
              const client = yield* Mcp.McpClient.connect(opts)
              const callRes = yield* client.callTool("add", { a: v.a, b: v.b })
              expect(callRes.content[0]).toEqual({ type: "text", text: String(v.a + v.b) })
              return { ok: true }
            })
          ).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
            Effect.provide(Mcp.Diagnostics.layer((e) => httpDiags.push(`${e.source}:${Redacted.value(e.detail)}`))),
            Effect.result
          )

          const shouldSucceed = v.mode === "json-ok" || v.mode === "sse-ok" || v.mode === "auth-https-ok" ||
            v.mode === "auth-loopback-ok" || v.mode === "session-delete-on-close"
          if (Result.isSuccess(res) !== shouldSucceed) {
            throw new Error(`mode=${v.mode} expected=${shouldSucceed} got=${Result.isFailure(res) ? res.failure.code + ":" + res.failure.message : "success"} diags=${JSON.stringify(httpDiags)}`)
          }
          if (v.mode === "session-delete-on-close") {
            expect(sawDelete).toBe(true)
          }
          return true
        }),
      { seed: seed + 5, executions: Math.max(ioExecutions, 55) }
    )
  })

  it("fuzzes concurrent tool calls over stdio under FuzzSimulation", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        pairs: Schema.Array(
          Schema.Struct({
            a: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 })),
            b: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
          })
        ).check(Schema.isMinLength(2), Schema.isMaxLength(6))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          const spawner = yield* fakeServer(respondToEcho)
          const results = yield* Effect.scoped(
            provideSpawner(
              Effect.gen(function*() {
                const client = yield* Mcp.McpClient.connect({ server: v.server, command: "mcp", args: [] })
                return yield* Effect.all(
                  v.pairs.map((p) => client.callTool("add", p)),
                  { concurrency: "unbounded" }
                )
              }),
              spawner
            )
          )
          expect(results.length).toBe(v.pairs.length)
          for (let i = 0; i < v.pairs.length; i++) {
            expect(results[i]!.content[0]).toEqual({
              type: "text",
              text: String(v.pairs[i]!.a + v.pairs[i]!.b)
            })
          }
          return true
        }),
      { seed: seed + 6, executions: simExecutions, execution: FuzzSimulation.execution() }
    )
  })

  it("fuzzes McpFlows.connected validation, binding execution, option schemas, and edge SSE/stdio frames", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        server: SafeName,
        prefix: SafeName,
        scenario: Schema.Literals([
          "empty-prefix",
          "missing-include",
          "missing-exclude",
          "execute-binding",
          "sse-server-ping-and-notif",
          "sse-uncorrelated-error",
          "sse-wrong-id",
          "http-session-404",
          "http-bad-session-id",
          "connect-schemas"
        ]),
        a: Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 })),
        b: Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 }))
      })
    )

    await runFuzz(
      arb,
      (v) =>
        Effect.gen(function*() {
          if (v.scenario === "connect-schemas") {
            const stdioDecoded = Schema.decodeUnknownSync(Mcp.McpClient.ConnectOptionsSchema)({
              server: v.server,
              command: "mcp-bin",
              args: ["--flag"]
            })
            expect(stdioDecoded.server).toBe(v.server)
            const httpDecoded = Schema.decodeUnknownSync(Mcp.McpClient.HttpConnectOptionsSchema)({
              server: v.server,
              url: "https://mcp.example.test/mcp"
            })
            expect(httpDecoded.server).toBe(v.server)
            return true
          }

          if (
            v.scenario === "empty-prefix" ||
            v.scenario === "missing-include" ||
            v.scenario === "missing-exclude" ||
            v.scenario === "execute-binding"
          ) {
            const spawner = yield* fakeServer(respondToEcho)
            const res = yield* Effect.scoped(
              provideSpawner(
                Effect.gen(function*() {
                  const opts: Mcp.McpClient.StdioConnectOptions & Mcp.McpFlows.ProjectionOptions =
                    v.scenario === "empty-prefix"
                      ? { server: v.server, command: "mcp", args: [], namePrefix: "" }
                      : v.scenario === "missing-include"
                      ? { server: v.server, command: "mcp", args: [], include: ["nope"] }
                      : v.scenario === "missing-exclude"
                      ? { server: v.server, command: "mcp", args: [], exclude: ["nope"] }
                      : { server: v.server, command: "mcp", args: [], namePrefix: v.prefix }
                  const source = yield* Mcp.McpFlows.connected(opts)
                  const bindings = yield* source.bindings()
                  expect(bindings.length).toBe(1)
                  expect(bindings[0]!.descriptor.name).toBe(`${v.prefix}/add`)
                  const desc = bindings[0]!.descriptor
                  const out = yield* bindings[0]!.run(new Cell.Call({
                    flowName: desc.name,
                    input: { a: v.a, b: v.b },
                    capabilities: desc.capabilities,
                    effects: desc.effects,
                    placement: Option.none(),
                    identity: new Cell.CallIdentity({
                      session: "mcp-fuzz",
                      frame: 0,
                      cell: "cell-0",
                      ordinal: 0,
                      declaration: Cell.declarationDigest(desc),
                      layers: []
                    })
                  }))
                  expect(out).toBeDefined()
                  return out
                }),
                spawner
              )
            ).pipe(Effect.result)

            if (v.scenario === "execute-binding") {
              expect(Result.isSuccess(res)).toBe(true)
            } else {
              expect(Result.isFailure(res)).toBe(true)
            }
            return true
          }

          // HTTP edge scenarios
          let reqCount = 0
          const http = makeHttpMock(({ method, body }) => {
            if (method === "DELETE") return { status: 204 }
            reqCount += 1
            const id = body?.id
            if (id === undefined) return { status: 202 }
            if (v.scenario === "http-bad-session-id" && body?.method === "initialize") {
              return {
                status: 200,
                contentType: "application/json",
                headers: { "mcp-session-id": "bad session" },
                body: JSON.stringify({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } })
              }
            }
            if (v.scenario === "http-session-404" && body?.method === "tools/list") {
              return { status: 404, contentType: "text/plain", body: "expired" }
            }
            const result = body?.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
              : { tools: [{ name: "add", inputSchema: { type: "object" } }] }
            const reply = { jsonrpc: "2.0", id, result }
            if (v.scenario === "sse-server-ping-and-notif" && body?.method === "tools/list") {
              const events = [
                `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`,
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" })}\n\n`,
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: "srv-2", method: "unknown/req" })}\n\n`,
                `data: ${JSON.stringify(reply)}\n\n`
              ].join("")
              return { status: 200, contentType: "text/event-stream", headers: { "mcp-session-id": "s1" }, body: events }
            }
            if (v.scenario === "sse-uncorrelated-error" && body?.method === "tools/list") {
              const events = [
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "uncorr" } })}\n\n`,
                `data: ${JSON.stringify(reply)}\n\n`
              ].join("")
              return { status: 200, contentType: "text/event-stream", headers: { "mcp-session-id": "s1" }, body: events }
            }
            if (v.scenario === "sse-wrong-id" && body?.method === "tools/list") {
              return {
                status: 200,
                contentType: "text/event-stream",
                headers: { "mcp-session-id": "s1" },
                body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: 99999, result })}\n\n`
              }
            }
            return {
              status: 200,
              contentType: "application/json",
              headers: { "mcp-session-id": "s1" },
              body: JSON.stringify(reply)
            }
          })

          const res = yield* Effect.scoped(
            Mcp.McpClient.connect({ server: v.server, url: "https://mcp.example.test/mcp" })
          ).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.result)

          const shouldPass = v.scenario === "sse-server-ping-and-notif" || v.scenario === "sse-uncorrelated-error"
          expect(Result.isSuccess(res)).toBe(shouldPass)
          expect(reqCount).toBeGreaterThan(0)
          return true
        }),
      { seed: seed + 7, executions: Math.max(ioExecutions, 50) }
    )
  })
})
