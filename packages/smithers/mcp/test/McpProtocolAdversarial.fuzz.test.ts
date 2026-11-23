import { NodeServices } from "@effect/platform-node"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { Fuzz, FuzzSimulation } from "@smthrs/fuzz"
import * as Cell from "@smthrs/harness/Cell"
import { Arbitrary, Effect, Option, Result, Schema, Stream } from "effect"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import * as HttpTransport from "../src/internal/HttpTransport.ts"
import * as JsonLimits from "../src/internal/JsonLimits.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as Transport from "../src/internal/Transport.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"
import { server as wordServer } from "./quickstartServer.ts"

const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const pureExecutions = Math.max(25, Math.min(baseExecutions, 150))
const ioExecutions = Math.max(15, Math.min(Math.ceil(baseExecutions / 3), 50))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261123")
const integer = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const words = Schema.Array(Schema.Literals(["a", "é", "🎻", "\0", "\r", "\n", "\"", "\ud800", "\udfff"]))
  .check(Schema.isMinLength(1), Schema.isMaxLength(12))
const wire = Arbitrary.schema(Schema.Struct({
  words,
  id: integer(1, 99999),
  width: integer(1, 64),
  cuts: Schema.Array(integer(1, 127)).check(Schema.isMinLength(1), Schema.isMaxLength(12))
}))
const utf8 = new TextEncoder()
const checkReport = <A, E>(report: Fuzz.Report<A, E>) => expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")

function split(bytes: Uint8Array, widths: readonly number[]) {
  const chunks: Uint8Array[] = [bytes.subarray(0, 0)]
  for (let i = 0, offset = 0; offset < bytes.length; i++) {
    const end = offset + widths[i % widths.length]!
    chunks.push(bytes.subarray(offset, end))
    offset = end
  }
  return chunks
}

// A real line-oriented peer. Both requests must be pending before the peer
// can ping with a colliding ID. Only a correct pong releases the two replies.
const stdioPeer = String.raw`
const readline = require("node:readline")
const pending = []
const widths = JSON.parse(process.argv[1])
function send(message) {
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\r\n")
  for (let offset = 0, i = 0; offset < bytes.length; i++) {
    const end = offset + widths[i % widths.length]
    process.stdout.write(bytes.subarray(offset, end))
    offset = end
  }
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const msg = JSON.parse(line)
  if (msg.method === "echo") {
    pending.push(msg)
    if (pending.length === 2) {
      send({ method: "notifications/progress", params: { progress: 1 } })
      send({ id: String(pending[0].id), method: "ping" })
    }
  } else if (msg.id === String(pending[0].id) && JSON.stringify(msg.result) === "{}") {
    for (const request of pending.reverse()) send({ id: String(request.id), result: request.params })
  } else process.exit(1)
})
`

describe("MCP wire contracts", () => {
  it("counts containers on each branch and round-trips escaped and multibyte values through flow schemas", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(wire, (v) =>
        Effect.gen(function*() {
          const text = v.words.join("")
          const values = Array.from({ length: v.width }, (_, i) => ({ [text + i]: text }))
          const args = { [text]: values }
          const output = { content: values, structuredContent: args, isError: v.width % 2 === 0 }
          expect(Schema.decodeUnknownSync(McpFlows.Args)(JSON.parse(JSON.stringify(args)))).toEqual(args)
          expect(Schema.decodeUnknownSync(McpFlows.Result)(JSON.parse(JSON.stringify(output)))).toEqual(output)
          for (const bad of [null, text, 0]) {
            expect(Schema.is(McpFlows.Args)(bad)).toBe(false)
            expect(Schema.is(McpFlows.Result)({ ...output, content: [...values, bad] })).toBe(false)
            expect(Schema.is(McpFlows.Result)({ ...output, structuredContent: bad })).toBe(false)
          }
          expect(Schema.is(McpFlows.Result)({ ...output, isError: String(output.isError) })).toBe(false)
          expect(Schema.is(McpFlows.Result)({ isError: false })).toBe(false)
          let branch: unknown = text
          for (let depth = 1; depth <= JsonLimits.maxDepth + 1; depth++) {
            branch = v.cuts[depth % v.cuts.length]! % 2 ? [text, branch] : { [text]: branch }
            if (depth < JsonLimits.maxDepth - 1) continue
            expect(JsonLimits.checkParsed(branch) === undefined).toBe(depth <= JsonLimits.maxDepth)
          }
          return true
        }), { seed, executions: pureExecutions }))
    )
  })

  it("reassembles byte partitions and applies the inclusive line cap independently to every JSON shape", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(wire, (v) =>
        Effect.gen(function*() {
          const text = "🎻\0" + v.words.join("")
          const keys = Object.fromEntries(Array.from({ length: v.width }, (_, i) => [text + i, i]))
          for (const payload of [text.repeat(v.width), Array(v.width).fill(text), keys]) {
            const frame = JSON.stringify({ jsonrpc: "2.0", id: v.id, result: payload })
            const size = utf8.encode(frame).length
            const bytes = utf8.encode("\r\n" + frame + "\r\n" + frame)
            const chunks = split(bytes, v.cuts)
            const read = (cap: number) =>
              Transport.lines("partition", cap, Stream.fromIterable(chunks)).pipe(Stream.runCollect)
            const lines = yield* read(size)
            expect(lines).toEqual(["", frame, frame])
            expect(Rpc.classify(Rpc.parse(lines[1]!)!)).toEqual({ _tag: "Result", id: v.id, result: payload })
            expect((yield* Effect.flip(read(size - 1))).code).toBe("protocol_error")
          }
          return true
        }), { seed, executions: pureExecutions, execution: FuzzSimulation.execution() }))
    )
  })

  it("keeps request ids directional and rejects malformed claimed envelopes", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(wire, (v) =>
        Effect.gen(function*() {
          const id = String(v.id)
          const method = "echo" + v.words.join("")
          const params = { value: method }
          const classify = (fields: object) => Rpc.classify(Rpc.parse(JSON.stringify({ jsonrpc: "2.0", ...fields }))!)
          expect(classify({ id, method, params })).toEqual({ _tag: "Request", id, method, params })
          expect(classify({ method, params })).toEqual({ _tag: "Notification" })
          const error = { code: -v.id, message: method, data: params }
          expect(classify({ id, error })).toEqual({ _tag: "Error", id: v.id, ...error })
          expect(classify({ id: null, error })).toEqual({ _tag: "UncorrelatedError", ...error })
          for (
            const fields of [
              { id: "0" + id, result: null },
              { id: null, result: params },
              { error },
              { id },
              { id, error, result: params },
              { method, id, result: params },
              { method, params: [params] },
              { id, error: { ...error, code: id } },
              { jsonrpc: "1.0", id, result: params }
            ]
          ) expect(classify(fields)._tag).toBe("Malformed")
          expect(Rpc.parse(JSON.stringify(params))).toBeUndefined()
          expect(Rpc.parse("{\"jsonrpc\":" + id)).toBeUndefined()
          return true
        }), { seed, executions: pureExecutions }))
    )
  })

  it("correlates reversed, fragmented stdio replies across a simultaneous server ping", async () => {
    checkReport(
      await Effect.runPromise(Fuzz.run(wire, (v) =>
        Effect.scoped(Effect.gen(function*() {
          const transport = yield* StdioTransport.connect({
            server: "stdio",
            command: process.execPath,
            args: ["-e", stdioPeer, JSON.stringify(v.cuts)],
            requestTimeoutMs: 1500
          })
          const requests = [0, 1].map((index) => ({ index, value: "é🎻" + v.words.join("") }))
          const answers = yield* Effect.forEach(requests, (args) => transport.request("echo", args), { concurrency: 2 })
          expect(answers).toEqual(requests)
          return true
        })).pipe(Effect.provide(NodeServices.layer)), { seed, executions: ioExecutions }))
    )
  })

  it("enforces the tool argument budget and validates calls through the projected word-count flow", async () => {
    const report = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const cap = 512
        const client = yield* McpClient.connect({ ...wordServer, server: "words", maxOutboundFrameBytes: cap })
        const [binding] = yield* McpFlows.mcp(client, { include: ["word_count"] }).bindings()
        if (!binding) throw new Error("missing word_count binding")
        const call = (input: Schema.Json) =>
          new Cell.Call({
            flowName: binding.descriptor.name,
            input,
            capabilities: McpFlows.capabilities,
            effects: binding.descriptor.effects,
            placement: Option.none(),
            identity: new Cell.CallIdentity({
              session: "words",
              frame: 0,
              cell: "fuzz",
              ordinal: 0,
              declaration: Cell.declarationDigest(binding.descriptor),
              layers: []
            })
          })
        return yield* Fuzz.run(wire, (v) =>
          Effect.gen(function*() {
            const width = cap + v.width
            const text = v.words.join("")
            const wide = Object.fromEntries(Array.from({ length: width }, (_, i) => [text + i, null]))
            for (const excess of [("🎻" + text).repeat(width), Array(width).fill(0), wide]) {
              expect((yield* Effect.flip(client.callTool("word_count", { excess }))).code).toBe("protocol_error")
            }
            const invalid = yield* binding.run(call(text))
            expect(invalid.code).toBe("invalid_input")
            const success = yield* binding.run(call({ text }))
            const words = text.match(/\S+/gu)?.length ?? 0
            expect(success.value).toEqual({
              content: [{ type: "text", text: String(words) }],
              isError: false,
              structuredContent: { words }
            })
            return true
          }), { seed, executions: ioExecutions })
      })).pipe(Effect.provide(NodeServices.layer))
    )
    checkReport(report)
  })

  it("checks HTTP frame bytes, session header characters, and session-aware HTTP errors on loopback", async () => {
    const server = createServer(async (req, res) => {
      if (req.method === "DELETE") {
        res.writeHead(204).end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id: number
        method: string
        params: { session: string; value: string; status: number }
      }
      const { session, status, value } = message.params
      if (message.method === "initialize") {
        res.setHeader("mcp-session-id", session)
        res.setHeader("content-type", "application/json")
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value }))
      } else {
        // A wrong or missing session echoes a different status to the client.
        res.writeHead(req.headers["mcp-session-id"] === session ? status : 409).end("private-error-body")
      }
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("expected a loopback port")
      const url = "http://127.0.0.1:" + address.port
      checkReport(
        await Effect.runPromise(Fuzz.run(wire, (v) =>
          Effect.gen(function*() {
            const value = "🎻" + v.words.join("")
            const size = utf8.encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result: value })).length
            const session = "!" + "s".repeat(v.width) + "~"
            const status = [400, 404, 429, 500, 503][v.width % 5]!
            for (const mode of ["valid", "bytes", "header"] as const) {
              yield* Effect.scoped(Effect.gen(function*() {
                const transport = yield* HttpTransport.connect({
                  server: "http",
                  url,
                  maxFrameBytes: mode === "bytes" ? size - 1 : size
                })
                const params = { session: mode === "header" ? session + " space" : session, value, status }
                const init = yield* Effect.result(transport.request("initialize", params))
                if (mode !== "valid") {
                  if (Result.isSuccess(init)) throw new Error("accepted " + mode)
                  expect(init.failure.code).toBe("protocol_error")
                  expect(init.failure.message).toContain(
                    mode === "header" ? "invalid session id" : "exceeded " + (size - 1)
                  )
                  return
                }
                if (Result.isFailure(init)) throw init.failure
                expect(init.success).toBe(value)
                const failure = yield* Effect.flip(transport.request("echo", params))
                expect(failure.code).toBe(status === 404 ? "connection_closed" : "protocol_error")
                expect(failure.message).toContain(status === 404 ? "ended the session" : "HTTP " + status)
                expect(failure.message).not.toContain("private-error-body")
              }))
            }
            return true
          }).pipe(Effect.provide(NodeHttpClient.layerUndici)), { seed, executions: ioExecutions }))
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
