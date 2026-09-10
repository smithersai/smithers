import { Deferred, Effect, Fiber, Queue, Ref, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import { ExitCode, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it, vi } from "vitest"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import { fakeProcess, provideSpawner } from "./fixtures/FakeProcess.ts"
import { respondToEcho, withFakeServer } from "./fixtures/FakeServer.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const waitFor = (assertion: () => void): Effect.Effect<void> =>
  Effect.promise(() => vi.waitFor(assertion, { timeout: 1_000 }))

describe("StdioTransport limits and terminal state", () => {
  it.each([
    { requestTimeoutMs: 0 },
    { queueCapacity: 0 },
    { maxFrameBytes: 0 },
    { maxOutboundFrameBytes: 0 },
    { maxStderrBytes: 0 },
    { requestTimeoutMs: 1.5 }
  ])("rejects invalid transport limits: %o", async (limits) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.flip(StdioTransport.connect({ server: "limited", command: "mcp", args: [], ...limits }))
    )

    expect(error).toMatchObject({ code: "protocol_error", server: "limited" })
  })

  it("rejects an invalid per-request deadline before writing", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "deadline", command: "mcp", args: [] })
        return yield* Effect.flip(transport.request("ping", {}, 0))
      })
    )

    expect(error).toMatchObject({ code: "protocol_error", server: "deadline" })
  })

  it("rejects an invalid per-notification deadline before writing", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "notify-deadline", command: "mcp", args: [] })
        return yield* Effect.flip(transport.notify("notifications/test", {}, 0))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "notify-deadline",
      message: "MCP notification timeout must be a positive integer"
    })
    expect(frames).toEqual([])
  })

  it("does not let a full cancellation queue delay the request deadline", async () => {
    const outcome = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(8),
        exitCode: Effect.as(Effect.sleep("6 seconds"), ExitCode(0)),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "full-cancellation-queue",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 300
        }),
        spawner
      )
      const started = Date.now()
      const request = yield* Effect.forkChild(Effect.flip(transport.request("tools/call")), {
        startImmediately: true
      })
      yield* Deferred.await(writerStarted)
      yield* transport.notify("fill-outbound-queue")
      const error = yield* Fiber.join(request)
      return { elapsed: Date.now() - started, error }
    })))

    expect(outcome.error).toMatchObject({
      code: "timeout",
      server: "full-cancellation-queue",
      message: "MCP server \"full-cancellation-queue\" did not answer tools/call within 300ms"
    })
    expect(outcome.elapsed).toBeLessThan(5_000)
  })

  it("cancels exactly once when a tools/call request times out", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "cancel-timeout",
          command: "mcp",
          args: [],
          requestTimeoutMs: 25
        })
        const failure = yield* Effect.flip(transport.request("tools/call", { secret: "do-not-copy" }))
        yield* waitFor(() =>
          expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toHaveLength(1)
        )
        return failure
      })
    )
    const request = frames.find((frame) => frame.method === "tools/call")!

    expect(error).toMatchObject({
      code: "timeout",
      server: "cancel-timeout",
      message: "MCP server \"cancel-timeout\" did not answer tools/call within 25ms"
    })
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([{
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: request.id, reason: "request no longer awaited" }
    }])
  })

  it("cancels exactly once when an outer fiber interrupts tools/call", async () => {
    const frames: Array<Rpc.Outbound> = []
    await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "cancel-interrupt", command: "mcp", args: [] })
        const pending = yield* Effect.forkChild(transport.request("tools/call", {}), { startImmediately: true })
        yield* waitFor(() => expect(frames.filter((frame) => frame.method === "tools/call")).toHaveLength(1))
        yield* Fiber.interrupt(pending)
        yield* waitFor(() =>
          expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toHaveLength(1)
        )
      })
    )
    const request = frames.find((frame) => frame.method === "tools/call")!

    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([{
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: request.id, reason: "request no longer awaited" }
    }])
  })

  it("does not cancel a tools/call request that receives a normal reply", async () => {
    const frames: Array<Rpc.Outbound> = []
    const result = await withFakeServer(
      (request) => {
        frames.push(request)
        return "done"
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "settled", command: "mcp", args: [] })
        const value = yield* transport.request("tools/call", {})
        yield* Effect.sleep("25 millis")
        return value
      })
    )

    expect(result).toBe("done")
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([])
  })

  it("does not cancel a tools/call request that receives a JSON-RPC error", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return "ignored"
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "settled-error", command: "mcp", args: [] })
        const failure = yield* Effect.flip(transport.request("tools/call", {}))
        yield* Effect.sleep("25 millis")
        return failure
      }),
      {
        envelope: (request) => ({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32_000, message: "remote failure" }
        })
      }
    )

    expect(error).toMatchObject({
      code: "tool_failed",
      server: "settled-error",
      message: "MCP server \"settled-error\" failed tools/call (-32000); remote details withheld"
    })
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([])
  })

  it("never cancels initialize when it times out", async () => {
    const frames: Array<Rpc.Outbound> = []
    const error = await withFakeServer(
      (request) => {
        frames.push(request)
        return undefined
      },
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "initialize-timeout", command: "mcp", args: [] })
        const failure = yield* Effect.flip(transport.request("initialize", {}, 25))
        yield* Effect.sleep("25 millis")
        return failure
      })
    )

    expect(error).toMatchObject({
      code: "timeout",
      server: "initialize-timeout",
      message: "MCP server \"initialize-timeout\" did not answer initialize within 25ms"
    })
    expect(frames.filter((frame) => frame.method === "notifications/cancelled")).toEqual([])
  })

  it("accepts an outbound frame exactly at maxOutboundFrameBytes", async () => {
    const params = { value: "bounded" }
    const bytes = Rpc.encode({ jsonrpc: "2.0", id: 1, method: "ping", params }).byteLength
    const result = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "outbound-boundary",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: bytes
        })
        return yield* transport.request("ping", params)
      })
    )

    expect(result).toBe("pong")
  })

  it("rejects an outbound frame one byte past maxOutboundFrameBytes", async () => {
    const params = { value: "bounded" }
    const bytes = Rpc.encode({ jsonrpc: "2.0", id: 1, method: "ping", params }).byteLength
    const error = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "outbound-limit",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: bytes - 1
        })
        return yield* Effect.flip(transport.request("ping", params))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "outbound-limit",
      message: `MCP server "outbound-limit" tried to send a ping frame larger than ${bytes - 1} bytes`
    })
  })

  it("turns an unexpected request serialization failure into protocol_error", async () => {
    const error = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "encode", command: "mcp", args: [] })
        return yield* Effect.flip(transport.request("raw", { value: 1n }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "encode",
      message: "MCP server \"encode\" could not encode a raw frame"
    })
  })

  it("bounds and safely encodes notifications", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({
          server: "notification-limit",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: 1
        })
        return yield* Effect.flip(transport.notify("large", { value: "x" }))
      })
    )

    expect(error).toMatchObject({
      code: "protocol_error",
      server: "notification-limit",
      message: "MCP server \"notification-limit\" tried to send a large frame larger than 1 bytes"
    })
  })

  it.each([
    ["CRLF", "\r\n", false],
    ["an unterminated frame", "", true],
    ["an unterminated frame ending in CR", "\r", true]
  ])("accepts %s", async (_label, delimiter, closeAfterReply) => {
    const result = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "framing", command: "mcp", args: [] })
        return yield* transport.request("ping")
      }),
      { delimiter, closeAfterReply }
    )

    expect(result).toBe("pong")
  })

  it("bounds notifications when a server stops reading stdin", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-writer",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 25
        }),
        spawner
      )

      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      return yield* Effect.flip(transport.notify("third"))
    })))

    expect(error).toMatchObject({ code: "timeout", server: "blocked-writer" })
  })

  it("bounds server-response admission when a peer stops reading its stdin", async () => {
    const failure = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const output = yield* Queue.unbounded<Uint8Array>()
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdout: Stream.fromQueue(output),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-server-response",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 25
        }),
        spawner
      )
      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      yield* Queue.offer(output, Rpc.encode({ jsonrpc: "2.0", id: 99, method: "ping" }))
      // The reader's deadline closes the connection and unblocks this offer;
      // the request's own, longer deadline must not be what releases it.
      yield* transport.request("waiting", undefined, 1_000).pipe(Effect.exit)
      return yield* Effect.flip(transport.notify("after-close"))
    })))
    expect(failure).toMatchObject({
      code: "timeout",
      message: "MCP server \"blocked-server-response\" did not answer server-response admission within 25ms"
    })
  })

  it("applies the outbound byte limit to responses, even for an immediate server ping", async () => {
    const failure = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdout: Stream.concat(
          Stream.make(
            new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(100), method: "ping" }) + "\n")
          ),
          Stream.never
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "large-server-response",
          command: "mcp",
          args: [],
          maxOutboundFrameBytes: 64
        }),
        spawner
      )
      return yield* Effect.flip(transport.request("x"))
    })))
    expect(failure).toMatchObject({
      code: "protocol_error",
      message: "MCP server \"large-server-response\" tried to send a server-response frame larger than 64 bytes"
    })
  })

  it("turns an exit-status failure into one terminal error for later traffic", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = fakeProcess({
        pid: ProcessId(3),
        exitCode: Effect.fail(PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "exitCode",
          description: "fixture failure"
        })),
        isRunning: Effect.succeed(false)
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "bad-exit", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("10 millis")
      const request = yield* Effect.flip(transport.request("later"))
      const notification = yield* Effect.flip(transport.notify("later"))
      yield* Effect.sleep("10 millis")
      return { request, notification }
    })))

    expect(errors.request).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("process exited"),
      server: "bad-exit"
    })
    expect(errors.notification).toBe(errors.request)
  })

  it("ignores a late reply after the process exit has closed the state", async () => {
    const outcome = await execute(Effect.scoped(Effect.gen(function*() {
      const replies = yield* Queue.unbounded<Uint8Array>()
      const exit = yield* Deferred.make<ExitCode>()
      const requestWritten = yield* Deferred.make<void>()
      const replyHandled = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(4),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(false),
        stdin: Sink.forEach((_chunk: Uint8Array) => Deferred.succeed(requestWritten, undefined)),
        // One frame, then end of stdout. The reader pulls that end only after
        // it has run the handler for the frame before it, so this finalizer is
        // a happens-after signal for the drop rather than a sleep long enough
        // to hope for one.
        stdout: Stream.fromQueue(replies).pipe(
          Stream.take(1),
          Stream.ensuring(Deferred.succeed(replyHandled, undefined))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "late-reply", command: "mcp", args: [] }),
        spawner
      )

      // Registers id 1: the frame reaching stdin proves the pending entry exists.
      const call = yield* Effect.forkChild(Effect.flip(transport.request("tools/call")), {
        startImmediately: true
      })
      yield* Deferred.await(requestWritten)

      // The close records `Closed` before it fails any waiter, so this request's
      // own failure is proof that the reader now observes a closed connection.
      yield* Deferred.succeed(exit, ExitCode(0))
      const closedError = yield* Fiber.join(call)

      // Only now does a well-formed reply for that id reach the reader.
      yield* Queue.offer(replies, new TextEncoder().encode("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"late\"}\n"))
      yield* Deferred.await(replyHandled)
      const afterwards = yield* Effect.flip(transport.notify("later"))
      return { afterwards, closedError }
    })))

    expect(outcome.closedError).toMatchObject({ code: "connection_closed", server: "late-reply" })
    // The dropped reply neither resolved anything nor moved the connection off
    // the error it closed with.
    expect(outcome.afterwards).toBe(outcome.closedError)
  })

  it("normalizes a host failure while reading stdout", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "stdout",
        description: "fixture failure"
      })
      const spawner = fakeProcess({
        pid: ProcessId(5),
        stdout: Stream.fail(failure)
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "bad-stdout", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("10 millis")
      return yield* Effect.flip(transport.request("later"))
    })))

    expect(error).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("stdout failed"),
      server: "bad-stdout"
    })
  })

  it("wakes a blocked enqueue when the process exits", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const exit = yield* Deferred.make<ExitCode>()
      const spawner = fakeProcess({
        pid: ProcessId(6),
        exitCode: Deferred.await(exit),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-enqueue",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 1_000
        }),
        spawner
      )
      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      const blocked = yield* Effect.forkChild(transport.notify("third"), { startImmediately: true })
      yield* Effect.sleep("10 millis")
      yield* Deferred.succeed(exit, ExitCode(0))
      const blockedError = yield* Effect.flip(Fiber.join(blocked))
      const laterError = yield* Effect.flip(transport.request("later"))
      return { blockedError, laterError }
    })))

    expect(errors.blockedError).toBe(errors.laterError)
    expect(errors.blockedError).toMatchObject({
      code: "connection_closed",
      server: "blocked-enqueue"
    })
  })

  it("fails every request pending at one terminal transition", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const exit = yield* Deferred.make<ExitCode>()
      const writes = yield* Ref.make(0)
      const allWritten = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(7),
        exitCode: Deferred.await(exit),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Ref.updateAndGet(writes, (count) => count + 1).pipe(
            Effect.flatMap((count) => count === 3 ? Deferred.succeed(allWritten, undefined) : Effect.void)
          )
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "pending", command: "mcp", args: [] }),
        spawner
      )
      const pending = yield* Effect.forkChild(
        Effect.all(
          ["one", "two", "three"].map((method) => Effect.flip(transport.request(method))),
          { concurrency: "unbounded" }
        ),
        { startImmediately: true }
      )
      yield* Deferred.await(allWritten)
      yield* Deferred.succeed(exit, ExitCode(0))
      return yield* Fiber.join(pending)
    })))

    expect(errors).toHaveLength(3)
    expect(errors.every((error) => error === errors[0])).toBe(true)
    expect(errors[0]).toMatchObject({ code: "connection_closed", server: "pending" })
  })
})
