/**
 * A scripted MCP server over the fake process handle.
 *
 * Every in-memory suite answers the client from the same fake: it parses the
 * JSON-RPC lines the client writes and replies to the ones the case scripts,
 * so a reply is never available before the request it answers exists.
 *
 * @since 0.1.0
 */
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Queue, Ref, Sink, Stream } from "effect"
import type { Scope } from "effect"
import { makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import * as Rpc from "../../src/internal/Rpc.ts"
import { fakeProcess, provideSpawner } from "./FakeProcess.ts"

/**
 * A fake MCP server: a stdin sink that parses each JSON-RPC line written to
 * it and, for every request it recognizes, pushes the scripted reply onto the
 * queue the fake's stdout stream drains. Unlike a static canned stream, this
 * reacts to what the client actually sends, so a reply is never available
 * before the client has registered the request it answers.
 */
export const fakeServer = (
  respond: (request: Rpc.Outbound) => unknown,
  options: {
    readonly delimiter?: string | undefined
    readonly closeAfterReply?: boolean | undefined
    readonly envelope?: ((request: Rpc.Outbound, result: unknown) => unknown) | undefined
  } = {}
): Effect.Effect<ChildProcessSpawner.ChildProcessSpawner["Service"]> =>
  Effect.gen(function*() {
    const replies = yield* Queue.unbounded<Uint8Array>()
    const buffer = yield* Ref.make("")
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function*() {
        const combined = yield* Ref.updateAndGet(buffer, (existing) => existing + decoder.decode(chunk))
        const lines = combined.split("\n")
        yield* Ref.set(buffer, lines.pop() ?? "")
        for (const line of lines) {
          const request = Rpc.parse(line)
          if (request === undefined) continue
          const outbound = request as unknown as Rpc.Outbound
          const result = respond(outbound)
          if (request.id === undefined || result === undefined) continue
          const reply = options.envelope?.(outbound, result) ?? { jsonrpc: "2.0", id: request.id, result }
          yield* Queue.offer(
            replies,
            encoder.encode(`${JSON.stringify(reply)}${options.delimiter ?? "\n"}`)
          )
        }
      })
    )

    return fakeProcess({
      pid: ProcessId(1),
      stdin,
      stdout: options.closeAfterReply === true
        ? Stream.take(Stream.fromQueue(replies), 1)
        : Stream.fromQueue(replies)
    })
  })

/** Tracks process ownership and every transport fiber independently for each spawn. */
export const trackedServer = (respond: (request: Rpc.Outbound) => unknown) => {
  const counts = { acquired: 0, released: 0, stopped: 0 }
  const stopped = Effect.sync(() => {
    counts.stopped += 1
  })
  const spawner = ChildProcessSpawner.makeNoop({
    spawn: (command) =>
      Effect.gen(function*() {
        const server = yield* fakeServer(respond)
        const handle = yield* server.spawn(command)
        return yield* Effect.acquireRelease(
          Effect.sync(() => {
            counts.acquired += 1
            return makeHandle({
              ...handle,
              stdin: handle.stdin.pipe(Sink.ensuring(stopped)),
              stdout: handle.stdout.pipe(
                // Let every transport fiber start before delivering a rejection.
                Stream.mapEffect((chunk) => Effect.yieldNow.pipe(Effect.as(chunk))),
                Stream.ensuring(stopped)
              ),
              stderr: Stream.never.pipe(Stream.ensuring(stopped)),
              exitCode: handle.exitCode.pipe(Effect.ensuring(stopped))
            })
          }),
          () =>
            Effect.sync(() => {
              counts.released += 1
            })
        )
      })
  })
  return { counts, spawner }
}

export const TOOLS = [
  { name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: {}, b: {} } } }
]

export const respondToEcho = (request: Rpc.Outbound): unknown => {
  if (request.method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} }
  }
  if (request.method === "tools/list") return { tools: TOOLS }
  if (request.method === "tools/call") {
    const params = request.params as {
      readonly name: string
      readonly arguments: { readonly a: number; readonly b: number }
    }
    return { content: [{ type: "text", text: String(params.arguments.a + params.arguments.b) }], isError: false }
  }
  return undefined
}

export const respondWithStructured = (
  outputSchema: Record<string, unknown>,
  structuredContent: Record<string, unknown>
) =>
(request: Rpc.Outbound): unknown => {
  if (request.method === "initialize") {
    return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: {} }
  }
  if (request.method === "tools/list") {
    return { tools: [{ ...TOOLS[0], outputSchema }] }
  }
  if (request.method === "tools/call") {
    return { content: [], structuredContent, isError: false }
  }
  return undefined
}

export const withFakeServer = <A, E>(
  respond: (request: Rpc.Outbound) => unknown,
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  options?: {
    readonly delimiter?: string | undefined
    readonly closeAfterReply?: boolean | undefined
    readonly envelope?: ((request: Rpc.Outbound, result: unknown) => unknown) | undefined
  }
): Promise<A> =>
  Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const spawner = yield* fakeServer(respond, options)
    return yield* provideSpawner(effect, spawner)
  })))
