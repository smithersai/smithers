/** Real transport lifecycle regressions for the CLI's Node WebSocket. */
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Socket } from "effect/unstable/socket"
import { createServer } from "node:http"
import type { Socket as NetSocket } from "node:net"
import { describe, expect, it } from "vitest"
import * as NodeWebSocket from "../src/internal/NodeWebSocket.ts"

const stalledHandshake = async () => {
  const server = createServer()
  const connections = new Set<NetSocket>()
  server.on("connection", (connection) => {
    connections.add(connection)
    connection.once("close", () => connections.delete(connection))
  })
  const requested = new Promise<void>((resolve) => server.once("upgrade", () => resolve()))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected loopback server")
  return {
    url: `ws://127.0.0.1:${address.port}`,
    requested,
    server,
    close: async () => {
      for (const connection of connections) connection.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

describe("Node WebSocket lifecycle", () => {
  it("owns the asynchronous handshake error after Effect detaches its reader", async () => {
    const host = await stalledHandshake()
    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const socket = yield* Socket.makeWebSocket(host.url)
          const read = yield* Effect.forkChild(Stream.runDrain(Socket.toStream(socket)))
          yield* Effect.promise(() => host.requested)
          yield* Fiber.interrupt(read)
          return yield* Fiber.await(read)
        }).pipe(
          Effect.provide(Layer.succeed(Socket.WebSocketConstructor, NodeWebSocket.make("fixture-token"))),
          Effect.scoped
        )
      )
      expect(Exit.isFailure(result)).toBe(true)
      // `ws.close()` reports its handshake error on a later Node turn.
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      await host.close()
    }
  })

  it("still reports a refused handshake through Effect's typed error channel", async () => {
    const host = await stalledHandshake()
    host.server.on("upgrade", (_request, connection) => {
      connection.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
    try {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const socket = yield* Socket.makeWebSocket(host.url)
          return yield* Stream.runDrain(Socket.toStream(socket))
        }).pipe(
          Effect.provide(Layer.succeed(Socket.WebSocketConstructor, NodeWebSocket.make())),
          Effect.scoped,
          Effect.exit
        )
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: "SocketError",
          reason: { _tag: "SocketOpenError" }
        })
      }
    } finally {
      await host.close()
    }
  })
})
