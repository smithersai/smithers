/**
 * MCP Streamable HTTP against a real loopback server.
 *
 * The server below is a small hand-written Streamable HTTP endpoint on
 * `node:http`: every case asserts what it received, not only what the client
 * returned. No `ChildProcessSpawner` is provided anywhere in this file.
 *
 * @since 1.0.0-rc.1
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, Fiber, Layer, Logger, Redacted, References, Scope, Tracer } from "effect"
import * as HttpClient from "effect/http/HttpClient"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { inspect } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import * as Diagnostics from "../src/Diagnostics.vibe"
import * as HttpTransport from "../src/internal/HttpTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.vibe"

type Message = Record<string, unknown>

interface Hit {
  readonly method: string
  readonly rpc: string | undefined
  readonly session: string | undefined
  readonly version: string | undefined
  readonly authorization: string | undefined
  readonly body: Message | undefined
}

/** Returns true when it answered the request itself. */
type Override = (message: Message, response: ServerResponse, hits: ReadonlyArray<Hit>) => boolean | Promise<boolean>

interface Options {
  readonly sse?: boolean
  readonly session?: string | undefined
  readonly override?: Override
}

const servers = new Set<Server>()

afterEach(async () => {
  await Promise.all([...servers].map((server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  ))
  servers.clear()
})

const bodyOf = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

const resultOf = (message: Message): unknown => {
  switch (message.method) {
    case "initialize":
      return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http", version: "1" } }
    case "tools/list":
      return {
        tools: [{
          name: "add",
          description: "Adds two numbers",
          inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } }
        }]
      }
    case "tools/call": {
      const args = (message.params as { arguments: { a: number; b: number } }).arguments
      return { content: [{ type: "text", text: String(args.a + args.b) }] }
    }
    default:
      return {}
  }
}

const event = (message: unknown) => `event: message\ndata: ${JSON.stringify(message)}\n\n`

/** A loopback Streamable HTTP MCP server that records every message it receives. */
const listen = async (options: Options = {}) => {
  const hits: Array<Hit> = []
  const session = Object.hasOwn(options, "session") ? options.session : "session-1"
  const server = createServer((request, response) => {
    void (async () => {
      const text = await bodyOf(request)
      const body = text === "" ? undefined : JSON.parse(text) as Message
      hits.push({
        method: request.method ?? "",
        rpc: typeof body?.method === "string" ? body.method : undefined,
        session: request.headers["mcp-session-id"] as string | undefined,
        version: request.headers["mcp-protocol-version"] as string | undefined,
        authorization: request.headers.authorization,
        body
      })
      if (body === undefined) return void response.writeHead(200).end()
      if (options.override !== undefined && await options.override(body, response, hits)) return
      if (!Object.hasOwn(body, "id") || !Object.hasOwn(body, "method")) return void response.writeHead(202).end()
      const reply = { jsonrpc: "2.0", id: body.id, result: resultOf(body) }
      const headers: Record<string, string> = body.method === "initialize" && session !== undefined
        ? { "mcp-session-id": session }
        : {}
      if (options.sse === true) {
        response.writeHead(200, { ...headers, "content-type": "text/event-stream" })
        response.end(event(reply))
      } else {
        response.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" })
        response.end(JSON.stringify(reply))
      }
    })()
  })
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/mcp`, origin: `http://127.0.0.1:${port}`, hits }
}

const rpcs = (hits: ReadonlyArray<Hit>) => hits.map((hit) => `${hit.method} ${hit.rpc ?? ""}`.trim())

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(NodeHttpClient.layerUndici)))

const failure = <A>(effect: Effect.Effect<A, McpError, HttpClient.HttpClient | Scope.Scope>) => run(Effect.flip(effect))

const connect = (url: string, overrides: Partial<McpClient.HttpConnectOptions> = {}) =>
  McpClient.connect({ server: "remote", url, ...overrides })

const add = (url: string, overrides: Partial<McpClient.HttpConnectOptions> = {}) =>
  Effect.flatMap(connect(url, overrides), (client) => client.callTool("add", { a: 2, b: 3 }))

describe("McpClient over Streamable HTTP", () => {
  it("connects, lists and calls over HTTP without a ChildProcessSpawner", async () => {
    const remote = await listen()
    let issued = 0
    const authProvider: McpClient.AuthProvider = {
      token: Effect.sync(() => Redacted.make(`token-${++issued}`))
    }
    const result = await run(Effect.gen(function*() {
      const client = yield* connect(remote.url, { authProvider })
      expect(client.tools.map((tool) => tool.name)).toEqual(["add"])
      return yield* client.callTool("add", { a: 2, b: 3 })
    }))
    expect(result).toEqual({ content: [{ type: "text", text: "5" }], isError: false, structuredContent: undefined })
    expect(rpcs(remote.hits)).toEqual([
      "POST initialize",
      "POST notifications/initialized",
      "POST tools/list",
      "POST tools/call",
      "DELETE"
    ])
    expect(remote.hits.map((hit) => hit.session)).toEqual([
      undefined,
      "session-1",
      "session-1",
      "session-1",
      "session-1"
    ])
    expect(remote.hits.map((hit) => hit.version)).toEqual([
      undefined,
      "2025-06-18",
      "2025-06-18",
      "2025-06-18",
      "2025-06-18"
    ])
    expect(remote.hits.map((hit) => hit.authorization)).toEqual([
      "Bearer token-1",
      "Bearer token-2",
      "Bearer token-3",
      "Bearer token-4",
      "Bearer token-5"
    ])
  })

  // The HTTP client records a header on its span only when the host's
  // `HttpClient.TracerHeaderFilter` admits it, and by default it admits none.
  it("records neither the bearer token nor the session id on its HTTP spans", async () => {
    const remote = await listen({ session: "session-synthetic-secret" })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const authProvider: McpClient.AuthProvider = { token: Effect.succeed(Redacted.make("token-synthetic-secret")) }
    await run(
      Effect.gen(function*() {
        const client = yield* connect(remote.url, { authProvider })
        return yield* client.callTool("add", { a: 2, b: 3 })
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )
    // Both went out on the wire, so the span is the only place left to keep
    // them from.
    expect(remote.hits.at(-1)).toMatchObject({
      authorization: "Bearer token-synthetic-secret",
      session: "session-synthetic-secret"
    })
    const exchanges = spans.filter((span) => span.kind === "client")
    expect(exchanges.map((span) => span.name)).toEqual(["POST", "POST", "POST", "POST", "DELETE"])
    const attributes = JSON.stringify(exchanges.map((span) => [...span.attributes]))
    expect(attributes).not.toContain("http.request.header.")
    expect(attributes).not.toContain("http.response.header.")
    expect(attributes).not.toContain("synthetic-secret")
  })

  // A host that turns header capture on records every header of an exchange.
  // The session id is what every later message is authorized by, so the
  // transport names it as a header to redact, in both directions.
  it("redacts the session id and the bearer token on HTTP spans that record headers", async () => {
    const remote = await listen({ session: "session-synthetic-secret" })
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    const authProvider: McpClient.AuthProvider = { token: Effect.succeed(Redacted.make("token-synthetic-secret")) }
    await run(
      Effect.gen(function*() {
        const client = yield* connect(remote.url, { authProvider })
        return yield* client.callTool("add", { a: 2, b: 3 })
      }).pipe(
        Effect.provideService(Tracer.Tracer, tracer),
        Effect.provideService(HttpClient.TracerHeaderFilter, () => true)
      )
    )
    expect(remote.hits.at(-1)).toMatchObject({
      authorization: "Bearer token-synthetic-secret",
      session: "session-synthetic-secret"
    })
    const exchanges = spans.filter((span) => span.kind === "client")
    expect(exchanges.map((span) => span.name)).toEqual(["POST", "POST", "POST", "POST", "DELETE"])
    // The server issues the id in its answer to `initialize`, and every later
    // message carries it back.
    expect(exchanges.map((span) => span.attributes.get("http.response.header.mcp-session-id"))).toEqual([
      "<redacted>",
      undefined,
      undefined,
      undefined,
      undefined
    ])
    expect(exchanges.map((span) => span.attributes.get("http.request.header.mcp-session-id"))).toEqual([
      undefined,
      "<redacted>",
      "<redacted>",
      "<redacted>",
      "<redacted>"
    ])
    for (const span of exchanges) {
      expect(span.attributes.get("http.request.header.authorization")).toBe("<redacted>")
      expect(span.attributes.get("http.request.header.accept")).not.toBe("<redacted>")
    }
    // The protocol version is public, and recorded as sent.
    expect(exchanges[2]!.attributes.get("http.request.header.mcp-protocol-version")).toBe("2025-06-18")
    expect(JSON.stringify(exchanges.map((span) => [...span.attributes]))).not.toContain("synthetic-secret")
  })

  describe("a server url that carries a secret", () => {
    // An MCP endpoint is often a capability url: the key sits in the path or
    // the query, and the transport sends no other credential.
    const secrets = ["PATH_SECRET", "QUERY_SECRET"]
    const secretUrl = (origin: string) => `${origin}/s/PATH_SECRET/mcp?api_key=QUERY_SECRET`

    /** One connect and tool call, with every span, log line and failure it produced. */
    const traced = async (url: string) => {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      const logs: Array<unknown> = []
      const logger = Logger.make((line) => {
        logs.push({ message: line.message, cause: Cause.pretty(line.cause) })
      })
      const exit = await Effect.runPromiseExit(
        Effect.scoped(add(url)).pipe(
          Effect.provide(NodeHttpClient.layerUndici),
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(References.MinimumLogLevel, "All")
        )
      )
      const exchanges = spans.filter((span) => span.kind === "client")
      const failures = exchanges.flatMap((span) =>
        span.status._tag === "Ended" && span.status.exit._tag === "Failure" ? [span.status.exit.cause] : []
      )
      return {
        exit,
        exchanges,
        spanFailures: failures.map((cause) => Cause.squash(cause)),
        /** Everything recorded, rendered the ways an exporter, a log sink or a reader could render it. */
        telemetry: [
          inspect(
            spans.map((span) => ({
              name: span.name,
              attributes: [...span.attributes],
              events: span.events,
              links: span.links,
              status: span.status
            })),
            { depth: 12 }
          ),
          ...failures.map((cause) => Cause.pretty(cause)),
          JSON.stringify(
            failures.flatMap((cause) => Cause.prettyErrors(cause).map((error) => [error.message, error.stack]))
          ),
          inspect(logs, { depth: 12 }),
          inspect(exit, { depth: 12 }),
          JSON.stringify(exit)
        ].join("\n")
      }
    }

    it("keeps the url's path and query out of every span on success", async () => {
      const remote = await listen()
      const { exchanges, exit, spanFailures, telemetry } = await traced(secretUrl(remote.origin))

      expect(Exit.isSuccess(exit)).toBe(true)
      for (const secret of secrets) expect(telemetry).not.toContain(secret)
      // What is left is each exchange's method, scheme, host, port and answer.
      const port = Number(new URL(remote.origin).port)
      expect(exchanges.map((span) => [span.name, Object.fromEntries(span.attributes)])).toEqual(
        (["POST", "POST", "POST", "POST", "DELETE"] as const).map((method, index) => [method, {
          "http.request.method": method,
          "url.scheme": "http",
          "server.address": "127.0.0.1",
          "server.port": port,
          "http.response.status_code": index === 1 ? 202 : 200
        }])
      )
      expect(spanFailures).toEqual([])
    })

    it.each([404, 503])(
      "keeps the url out of the span that failed with a %s, and out of its failure",
      async (status) => {
        const remote = await listen({
          override: (message, response) => {
            if (message.method !== "tools/call") return false
            response.writeHead(status).end(`no such tool at ${secretUrl(remote.origin)}`)
            return true
          }
        })
        const { exchanges, exit, spanFailures, telemetry } = await traced(secretUrl(remote.origin))

        expect(Exit.isFailure(exit)).toBe(true)
        for (const secret of secrets) expect(telemetry).not.toContain(secret)
        expect(exchanges[3]!.attributes.get("http.response.status_code")).toBe(status)
        expect(exchanges[3]!.attributes.get("error.type")).toBe(String(status))
        expect(spanFailures).toEqual([
          new McpError({
            code: "protocol_error",
            message: `MCP server "remote" answered with HTTP ${status}`,
            server: "remote"
          })
        ])
      }
    )

    it("keeps the url out of the span and the failure of a server that cannot be reached", async () => {
      const remote = await listen()
      const [server] = servers
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      servers.clear()
      const { exchanges, exit, spanFailures, telemetry } = await traced(secretUrl(remote.origin))

      expect(Exit.isFailure(exit)).toBe(true)
      for (const secret of secrets) expect(telemetry).not.toContain(secret)
      expect(exchanges.map((span) => span.name)).toEqual(["POST"])
      expect(spanFailures).toEqual([
        new McpError({
          code: "connection_closed",
          message: "MCP server \"remote\" is not reachable; transport details withheld",
          server: "remote"
        })
      ])
    })

    it("names its spans for the method even when the host names HTTP spans for their url", async () => {
      const remote = await listen()
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        }
      })
      await run(
        add(secretUrl(remote.origin)).pipe(
          Effect.provideService(Tracer.Tracer, tracer),
          Effect.provideService(HttpClient.SpanNameGenerator, (request) => `${request.method} ${request.url}`)
        )
      )
      expect(spans.filter((span) => span.kind === "client").map((span) => span.name)).toEqual([
        "POST",
        "POST",
        "POST",
        "POST",
        "DELETE"
      ])
    })
  })

  it("reads replies from an event stream, answering server requests on the way", async () => {
    const remote = await listen({
      sse: true,
      override: (message, response) => {
        if (message.method !== "tools/call") return false
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end([
          ": keep-alive",
          "",
          "event: message",
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}`,
          "",
          event({ jsonrpc: "2.0", id: "ping-1", method: "ping" }).trimEnd(),
          "",
          event({ jsonrpc: "2.0", id: 7, method: "sampling/createMessage", params: {} }).trimEnd(),
          "",
          event({ jsonrpc: "2.0", id: null, error: { code: -1, message: "stray" } }).trimEnd(),
          "",
          // One JSON message split over two data lines, the second without a space.
          `data: {"jsonrpc":"2.0","id":${String(message.id)},`,
          `data:"result":{"content":[{"type":"text","text":"5"}]}}`,
          "",
          ""
        ].join("\r\n"))
        return true
      }
    })
    const reports: Array<Diagnostics.Event> = []
    const result = await run(
      add(remote.url).pipe(
        Effect.provide(Diagnostics.layer((event) => reports.push(event)))
      )
    )
    expect(result.content).toEqual([{ type: "text", text: "5" }])
    const replies = remote.hits.filter((hit) => hit.rpc === undefined && hit.method === "POST").map((hit) => hit.body)
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: "ping-1", result: {} },
      { jsonrpc: "2.0", id: 7, error: { code: -32_601, message: "Method not found" } }
    ])
    expect(reports.map((report) => report.source)).toEqual(["remote-error"])
  })

  it("fails with McpError before any request reaches a host the egress policy denies", async () => {
    const remote = await listen()
    const reports: Array<Diagnostics.Event> = []
    const guarded = (patterns: ReadonlyArray<CapabilityPattern>) =>
      KernelHttpClient.layer.pipe(
        Layer.provide(NodeHttpClient.layerUndici),
        Layer.provide(Layer.effect(
          GrantStore.GrantStore,
          GrantStore.make({
            attended: false,
            rules: patterns.map((pattern) => new Rule({ effect: "allow", pattern }))
          })
        )),
        Layer.provide(Workspace.layer("/workspace"))
      )
    const denied = await Effect.runPromise(
      Effect.scoped(Effect.flip(add(remote.url))).pipe(
        Effect.provide(guarded([])),
        Effect.provide(Diagnostics.layer((event) => reports.push(event)))
      )
    )
    expect(denied).toBeInstanceOf(McpError)
    expect(denied).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" is not reachable: egress to its URL is not granted"
    })
    expect(remote.hits).toEqual([])
    expect(reports.map((report) => report.source)).toEqual(["transport"])

    const allowed = await Effect.runPromise(
      Effect.scoped(add(remote.url)).pipe(
        Effect.provide(guarded([new CapabilityPattern({ action: "net:post", resource: remote.origin })]))
      )
    )
    expect(allowed.content).toEqual([{ type: "text", text: "5" }])
    expect(rpcs(remote.hits)).toEqual([
      "POST initialize",
      "POST notifications/initialized",
      "POST tools/list",
      "POST tools/call",
      "DELETE"
    ])
  })

  it("reports an unreachable endpoint without transport details", async () => {
    const remote = await listen()
    for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
    servers.clear()
    const error = await failure(connect(remote.url))
    expect(error).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" is not reachable; transport details withheld"
    })
  })

  it("rejects an endpoint that is not an absolute http(s) URL without credentials", async () => {
    for (const url of ["not a url", "ftp://127.0.0.1/mcp", "http://user:secret@127.0.0.1/mcp", "http://:secret@h/"]) {
      const error = await failure(connect(url))
      expect(error).toMatchObject({
        code: "protocol_error",
        message: "MCP server \"remote\" url must be an absolute http or https URL without credentials"
      })
    }
  })

  it("rejects non-positive transport limits before sending anything", async () => {
    const remote = await listen()
    for (const name of ["requestTimeoutMs", "maxFrameBytes", "maxOutboundFrameBytes"] as const) {
      const error = await failure(connect(remote.url, { [name]: 0 }))
      expect(error.message).toBe(`MCP option "${name}" must be a positive integer`)
    }
    expect(remote.hits).toEqual([])
  })

  it("fails on a non-success status, and on 404 only as an ended session once one exists", async () => {
    const status = (method: string, code: number) =>
      listen({
        override: (message, response) => {
          if (message.method !== method) return false
          response.writeHead(code).end()
          return true
        }
      })
    const rejected = await status("initialize", 401)
    expect(await failure(connect(rejected.url))).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"remote\" answered initialize with HTTP 401"
    })
    const missing = await status("initialize", 404)
    expect((await failure(connect(missing.url))).message).toBe(
      "MCP server \"remote\" answered initialize with HTTP 404"
    )
    const broken = await status("tools/call", 500)
    expect((await failure(add(broken.url))).message).toBe("MCP server \"remote\" answered tools/call with HTTP 500")
    const expired = await status("tools/call", 404)
    expect(await failure(add(expired.url))).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" ended the session; reconnect to continue"
    })
    // The failed request is not replayed.
    expect(rpcs(expired.hits).filter((rpc) => rpc === "POST tools/call")).toHaveLength(1)
  })

  it("rejects replies that are not a JSON-RPC answer to the request", async () => {
    const answer = (write: (message: Message, response: ServerResponse) => void) =>
      listen({
        override: (message, response) => {
          if (message.method !== "tools/call") return false
          write(message, response)
          return true
        }
      })
    const json = (body: string) => (_: Message, response: ServerResponse) =>
      response.writeHead(200, { "content-type": "application/json" }).end(body)
    const cases: ReadonlyArray<readonly [Parameters<typeof answer>[0], Partial<McpError>]> = [
      [(_, response) => response.writeHead(200, { "content-type": "text/plain" }).end("5"), {
        code: "protocol_error",
        message: "MCP server \"remote\" answered tools/call with an unsupported content type"
      }],
      [(_, response) => response.writeHead(200).end(), {
        message: "MCP server \"remote\" answered tools/call with an unsupported content type"
      }],
      [json("hello"), { code: "protocol_error", message: "MCP server \"remote\" sent a message that is not JSON-RPC" }],
      [json(JSON.stringify({ jsonrpc: "1.0", id: 4, result: {} })), {
        code: "protocol_error",
        message: "MCP server \"remote\" sent a malformed JSON-RPC reply: a JSON-RPC message must carry jsonrpc \"2.0\""
      }],
      [json(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} })), {
        code: "protocol_error",
        message: "MCP server \"remote\" answered tools/call with a reply to another request"
      }],
      [
        (message, response) =>
          json(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32_000, message: "boom" } }))(
            message,
            response
          ),
        { code: "tool_failed", message: "MCP server \"remote\" failed tools/call (-32000); remote details withheld" }
      ],
      [json(JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })), {
        code: "connection_closed",
        message: "MCP server \"remote\" closed its response before answering tools/call"
      }],
      [json(`{"jsonrpc":"2.0","id":4,"result":${"[".repeat(130)}${"]".repeat(130)}}`), {
        code: "protocol_error",
        message: "MCP server \"remote\" sent invalid JSON: JSON nesting exceeds 128 containers"
      }],
      [
        (message, response) =>
          json(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: ["x".repeat(600)] } }))(
            message,
            response
          ),
        { code: "protocol_error", message: "MCP frame exceeded 512 bytes" }
      ]
    ]
    for (const [write, expected] of cases) {
      const remote = await answer(write)
      const error = await failure(add(remote.url, { maxFrameBytes: 512 }))
      expect(error).toMatchObject(expected)
    }
  })

  it("bounds event-stream lines and events, and fails a stream that ends unanswered", async () => {
    const stream = (body: string) =>
      listen({
        override: (message, response) => {
          if (message.method !== "tools/call") return false
          response.writeHead(200, { "content-type": "text/event-stream" }).end(body)
          return true
        }
      })
    const longLine = await stream(`data: ${"x".repeat(600)}\n\n`)
    expect((await failure(add(longLine.url, { maxFrameBytes: 512 }))).message).toBe("MCP frame exceeded 512 bytes")
    const longEvent = await stream(`${`data: ${"x".repeat(300)}\n`.repeat(2)}\n`)
    expect((await failure(add(longEvent.url, { maxFrameBytes: 512 }))).message).toBe("MCP frame exceeded 512 bytes")
    const unanswered = await stream(event({ jsonrpc: "2.0", method: "notifications/progress" }) + "data: {}")
    expect(await failure(add(unanswered.url))).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" closed its response before answering tools/call"
    })
  })

  it("skips an event whose data is empty, as a resumable stream's priming event is", async () => {
    // The MCP reference server opens a resumable stream with
    // `id: <event id>\ndata: \n\n`: an event that carries no message.
    const remote = await listen({
      override: (message, response) => {
        if (message.method !== "tools/call") return false
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          "id: prime-1\nretry: 1000\ndata: \n\nid: prime-2\ndata:\n\n" +
            event({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "5" }] } })
        )
        return true
      }
    })
    expect((await run(add(remote.url))).content).toEqual([{ type: "text", text: "5" }])
  })

  it("reads an event stream whose lines end in a lone CR", async () => {
    const remote = await listen({
      override: (message, response) => {
        if (message.method !== "tools/call") return false
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(event({ jsonrpc: "2.0", id: message.id, result: { content: [] } }).replaceAll("\n", "\r"))
        return true
      }
    })
    expect((await run(add(remote.url))).content).toEqual([])
  })

  it("fails a request pending when its scope closes, without cancelling over the ended session", async () => {
    const remote = await listen({ override: (message) => message.method === "tools/call" })
    const error = await run(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const client = yield* Scope.provide(connect(remote.url), scope)
      const pending = yield* Effect.forkChild(Effect.flip(client.callTool("add", { a: 2, b: 3 })))
      while (!remote.hits.some((hit) => hit.rpc === "tools/call")) yield* Effect.sleep(10)
      yield* Scope.close(scope, Exit.void)
      return yield* Fiber.join(pending)
    }))
    expect(error).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" connection scope closed"
    })
    await Effect.runPromise(Effect.sleep(50))
    expect(rpcs(remote.hits).slice(3)).toEqual(["POST tools/call", "DELETE"])
  })

  it("reports a response body lost mid-stream as a closed connection", async () => {
    const remote = await listen({
      override: (message, response) => {
        if (message.method !== "tools/call") return false
        response.writeHead(200, { "content-type": "application/json", "content-length": "100" })
        response.write("{\"jsonrpc\"")
        setTimeout(() => response.destroy(), 20)
        return true
      }
    })
    expect(await failure(add(remote.url))).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" is not reachable; transport details withheld"
    })
  })

  it("rejects a session id that is not visible ASCII", async () => {
    const remote = await listen({ session: "bad id" })
    expect(await failure(connect(remote.url))).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"remote\" sent an invalid session id"
    })
  })

  it("sends no session headers or DELETE when the server issues no session", async () => {
    const remote = await listen({ session: undefined })
    await run(add(remote.url))
    expect(rpcs(remote.hits)).toEqual([
      "POST initialize",
      "POST notifications/initialized",
      "POST tools/list",
      "POST tools/call"
    ])
    expect(remote.hits.every((hit) => hit.session === undefined)).toBe(true)
  })

  it("times out a request and tells the server it is no longer awaited", async () => {
    const remote = await listen({
      override: (message) => message.method === "tools/call"
    })
    const error = await run(Effect.gen(function*() {
      const client = yield* connect(remote.url, { requestTimeoutMs: 100 })
      const error = yield* Effect.flip(client.callTool("add", { a: 2, b: 3 }))
      // The session stays open, so the cancellation is delivered.
      while (!remote.hits.some((hit) => hit.rpc === "notifications/cancelled")) yield* Effect.sleep(10)
      return error
    }))
    expect(error).toMatchObject({
      code: "timeout",
      message: "MCP server \"remote\" did not answer tools/call within 100ms"
    })
    const cancelled = remote.hits.find((hit) => hit.rpc === "notifications/cancelled")
    expect(cancelled?.body?.params).toEqual({ requestId: 3, reason: "request no longer awaited" })
  })

  it("sends no cancellation for a timed-out initialize or an undispatched request", async () => {
    const hanging = await listen({ override: (message) => message.method === "initialize" })
    expect((await failure(connect(hanging.url, { handshakeTimeoutMs: 100 }))).code).toBe("timeout")
    await Effect.runPromise(Effect.sleep(50))
    expect(rpcs(hanging.hits)).toEqual(["POST initialize"])

    const idle = await listen()
    const error = await failure(connect(idle.url, {
      handshakeTimeoutMs: 100,
      authProvider: { token: Effect.never }
    }))
    expect(error.code).toBe("timeout")
    await Effect.runPromise(Effect.sleep(50))
    expect(idle.hits).toEqual([])
  })

  it("times out a notification the server never accepts", async () => {
    const remote = await listen({ override: (message) => message.method === "notifications/initialized" })
    expect(await failure(connect(remote.url, { handshakeTimeoutMs: 100 }))).toMatchObject({
      code: "timeout",
      message: "MCP server \"remote\" did not answer notifications/initialized within 100ms"
    })
  })

  it("propagates an auth provider failure unchanged", async () => {
    const remote = await listen()
    const refused = new McpError({ code: "protocol_error", message: "no credential", server: "remote" })
    expect(await failure(connect(remote.url, { authProvider: { token: Effect.fail(refused) } }))).toBe(refused)
    expect(remote.hits).toEqual([])
  })
})

describe("HttpTransport", () => {
  const open = (url: string, overrides: Partial<HttpTransport.ConnectOptions> = {}) =>
    HttpTransport.connect({ server: "remote", url, ...overrides })

  it("validates per-call deadlines and outbound size before sending", async () => {
    const remote = await listen()
    const errors = await run(Effect.gen(function*() {
      const transport = yield* open(remote.url, { maxOutboundFrameBytes: 64 })
      return [
        yield* Effect.flip(transport.request("tools/list", {}, 0)),
        yield* Effect.flip(transport.notify("notifications/initialized", undefined, 1.5)),
        yield* Effect.flip(transport.request("tools/call", { text: "x".repeat(100) }))
      ]
    }))
    expect(errors.map((error) => error.message)).toEqual([
      "MCP request timeout must be a positive integer",
      "MCP notification timeout must be a positive integer",
      "MCP server \"remote\" tried to send a tools/call frame larger than 64 bytes"
    ])
    expect(remote.hits).toEqual([])
  })

  it("keeps no protocol version from an initialize result that names none", async () => {
    const remote = await listen({
      override: (message, response) => {
        if (message.method !== "initialize") return false
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }))
        return true
      }
    })
    await run(Effect.gen(function*() {
      const transport = yield* open(remote.url)
      yield* transport.request("initialize", {})
      yield* transport.request("tools/list", {})
    }))
    expect(remote.hits.map((hit) => [hit.session, hit.version])).toEqual([
      [undefined, undefined],
      ["s", undefined],
      ["s", undefined]
    ])
  })

  it("rejects traffic after its scope closes", async () => {
    const remote = await listen()
    const error = await run(Effect.gen(function*() {
      const scope = yield* Scope.make()
      const transport = yield* Scope.provide(open(remote.url), scope)
      yield* Scope.close(scope, Exit.void)
      return yield* Effect.flip(transport.request("tools/list", {}))
    }))
    expect(error).toMatchObject({
      code: "connection_closed",
      message: "MCP server \"remote\" connection scope closed"
    })
    expect(remote.hits).toEqual([])
  })
})
