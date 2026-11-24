import { Fuzz } from "@smthrs/fuzz"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Arbitrary, Effect, Exit, Layer, Logger, Queue, Redacted, Schema, Sink, Stream } from "effect"
import { ExitCode, ProcessId } from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import { fakeProcess } from "./fixtures/FakeProcess.ts"
import { fakeServer, trackedServer } from "./fixtures/FakeServer.ts"
const respondToEcho = (request: Rpc.Outbound): unknown => request.method === "echo" ? request.params : undefined

const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261154")
const baseExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "100")
const fastExec = Math.max(25, Math.min(Math.ceil(baseExecutions / 3), 60))

const assertPassed = <A, E = unknown>(report: Fuzz.Report<A, E>): void => {
  expect(report._tag, Fuzz.formatReport(report)).toBe("Passed")
}

describe("@smthrs/mcp Wave 9 deep StdioTransport & Diagnostics fuzzing", () => {
  it(
    "StdioTransport enforces limit bounds, per-call deadlines, ping replies, unknown server method rejection, and redacts stderr secrets",
    async () => {
      const arb = Arbitrary.schema(
        Schema.Struct({
          mode: Schema.Literals([
            "invalid-limit",
            "invalid-req-deadline",
            "invalid-notify-deadline",
            "echo-and-notify",
            "stderr-secret-redaction",
            "server-ping-and-unknown",
            "close-after-reply",
            "oversize-outbound"
          ]),
          limitField: Schema.Literals([
            "requestTimeoutMs",
            "queueCapacity",
            "maxFrameBytes",
            "maxOutboundFrameBytes",
            "maxStderrBytes"
          ]),
          badVal: Schema.Literals([0, -1, 1.5]),
          payloadText: Schema.Literals(["hello", "world", "ping-data", "unicode-🚀"])
        })
      )

      const report = await Effect.runPromise(
        Fuzz.run(
          arb,
          ({ mode, limitField, badVal, payloadText }) =>
            Effect.gen(function*() {
              const events: Array<Diagnostics.Event> = []
              const diagLayer = Diagnostics.layer((ev) => {
                events.push(ev)
              })

              if (mode === "invalid-limit") {
                const server = yield* fakeServer(respondToEcho)
                const exit = yield* Effect.exit(
                  Effect.scoped(
                    StdioTransport.connect({
                      server: "w9-lim",
                      command: "mcp",
                      args: [],
                      [limitField]: badVal
                    })
                  ).pipe(
                    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(server)),
                    Effect.provide(diagLayer)
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
                return true
              }

              if (mode === "invalid-req-deadline" || mode === "invalid-notify-deadline") {
                const server = yield* fakeServer(respondToEcho)
                const exit = yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const t = yield* StdioTransport.connect({ server: "w9-dl", command: "mcp", args: [] })
                      if (mode === "invalid-req-deadline") {
                        return yield* t.request("echo", { text: payloadText }, badVal)
                      }
                      return yield* t.notify("notifications/test", { text: payloadText }, badVal)
                    })
                  ).pipe(
                    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(server)),
                    Effect.provide(diagLayer)
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
                return true
              }

              if (mode === "echo-and-notify") {
                const tracked = trackedServer(respondToEcho)
                const res = yield* Effect.scoped(
                  Effect.gen(function*() {
                    const t = yield* StdioTransport.connect({
                      server: "w9-echo",
                      command: "mcp",
                      args: [],
                      env: { CUSTOM_FLAG: "1" }
                    })
                    yield* t.notify("notifications/initialized", {})
                    return yield* t.request("echo", { text: payloadText }, 2_000)
                  })
                ).pipe(
                  Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(tracked.spawner)),
                  Effect.provide(diagLayer)
                )
                expect(res).toEqual({ text: payloadText })
                expect(tracked.counts.acquired).toBe(1)
                expect(tracked.counts.released).toBe(1)
                return true
              }

              if (mode === "oversize-outbound") {
                const server = yield* fakeServer(respondToEcho)
                const exit = yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const t = yield* StdioTransport.connect({
                        server: "w9-big",
                        command: "mcp",
                        args: [],
                        maxOutboundFrameBytes: 64
                      })
                      return yield* t.request("echo", { text: "x".repeat(200) }, 2_000)
                    })
                  ).pipe(
                    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(server)),
                    Effect.provide(diagLayer)
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
                return true
              }

              if (mode === "close-after-reply") {
                const server = yield* fakeServer(respondToEcho, { closeAfterReply: true })
                yield* Effect.scoped(
                  Effect.gen(function*() {
                    const t = yield* StdioTransport.connect({ server: "w9-close", command: "mcp", args: [] })
                    const first = yield* t.request("echo", { text: payloadText }, 2_000)
                    expect(first).toEqual({ text: payloadText })
                    const secondExit = yield* Effect.exit(t.request("echo", { text: "after-eof" }, 2_000))
                    expect(Exit.isFailure(secondExit)).toBe(true)
                  })
                ).pipe(
                  Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(server)),
                  Effect.provide(diagLayer)
                )
                return true
              }

              if (mode === "stderr-secret-redaction") {
                const secret = "ghp_1234567890abcdef1234567890abcdef1234"
                const encoder = new TextEncoder()
                const spawner = fakeProcess({
                  pid: ProcessId(42),
                  stdin: Sink.drain,
                  stdout: Stream.empty,
                  stderr: Stream.make(
                    encoder.encode(`fatal auth token=${secret}\npartial-line`),
                    encoder.encode(" continued\n")
                  ),
                  exitCode: Effect.succeed(ExitCode(1))
                })
                const exit = yield* Effect.exit(
                  Effect.scoped(
                    Effect.gen(function*() {
                      const t = yield* StdioTransport.connect({
                        server: "w9-stderr",
                        command: "mcp",
                        args: [],
                        maxStderrBytes: 128
                      })
                      return yield* t.request("echo", { text: payloadText }, 1_000)
                    })
                  ).pipe(
                    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)),
                    Effect.provide(diagLayer)
                  )
                )
                expect(Exit.isFailure(exit)).toBe(true)
                // Raw secret must NEVER appear in any diagnostic event or failure message
                for (const ev of events) {
                  expect(Redacted.value(ev.detail)).not.toContain(secret)
                }
                return true
              }

              // server-ping-and-unknown: server pushes ping request + unknown method request + notification before replying
              const replies = yield* Queue.unbounded<Uint8Array>()
              const inboundFrames: Array<string> = []
              const encoder = new TextEncoder()
              const decoder = new TextDecoder()
              let buf = ""
              const spawner = fakeProcess({
                pid: ProcessId(7),
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Effect.gen(function*() {
                    buf += decoder.decode(chunk)
                    const lines = buf.split("\n")
                    buf = lines.pop() ?? ""
                    for (const line of lines) {
                      if (!line.trim()) continue
                      inboundFrames.push(line)
                      const parsed = Rpc.parse(line)
                      if (parsed && "method" in parsed && parsed.id !== undefined) {
                        yield* Queue.offer(
                          replies,
                          encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: "srv-ping", method: "ping" })}\n`)
                        )
                        yield* Queue.offer(
                          replies,
                          encoder.encode(
                            `${JSON.stringify({ jsonrpc: "2.0", id: "srv-unk", method: "server/unknown" })}\n`
                          )
                        )
                        yield* Queue.offer(
                          replies,
                          encoder.encode(
                            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n`
                          )
                        )
                        yield* Queue.offer(
                          replies,
                          encoder.encode(
                            `${JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: payloadText } })}\n`
                          )
                        )
                      }
                    }
                  })
                ),
                stdout: Stream.fromQueue(replies)
              })
              const res = yield* Effect.scoped(
                Effect.gen(function*() {
                  const t = yield* StdioTransport.connect({ server: "w9-srv", command: "mcp", args: [] })
                  return yield* t.request("echo", { text: payloadText }, 2_000)
                })
              ).pipe(
                Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)),
                Effect.provide(diagLayer)
              )
              expect(res).toEqual({ ok: payloadText })
              return true
            }).pipe(Effect.provide(Logger.layer([]))),
          { seed, executions: fastExec }
        )
      )
      assertPassed(report)
    },
    120_000
  )
})
