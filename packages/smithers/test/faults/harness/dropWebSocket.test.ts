import { NodeWS } from "@effect/platform-node"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { dropWebSocket, SocketState, trackingWebSocketConstructor } from "./dropWebSocket.ts"

// The `ws` server class the client half of this harness is built on, reached
// through the same re-export `@effect/platform-node` uses for the client.
const Server = NodeWS.WebSocketServer

interface ServerSocket {
  on: (event: string, listener: (data: unknown) => void) => unknown
  send: (data: never) => void
  terminate: () => void
}

let server: InstanceType<typeof Server>
let url: string
const accepted: Array<ServerSocket> = []

beforeAll(async () => {
  server = new Server({ host: "127.0.0.1", port: 0 })
  server.on("connection", (socket: ServerSocket) => {
    accepted.push(socket)
    socket.on("message", (data) => socket.send(data as never))
  })
  await new Promise<void>((resolve) => server.once("listening", () => resolve()))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a TCP address")
  url = `ws://127.0.0.1:${address.port}`
})

afterAll(() =>
  new Promise<void>((resolve) => {
    // `close` waits for every connection to end, and these cases deliberately
    // leave sockets open, so the server-side halves are cut first.
    for (const socket of accepted) socket.terminate()
    server.close(() => resolve())
  })
)

const opened = (socket: { once: (event: string, listener: () => void) => unknown }) =>
  new Promise<void>((resolve) => socket.once("open", () => resolve()))

describe("dropWebSocket", () => {
  it("tracks every socket a client constructs", async () => {
    const tracker = trackingWebSocketConstructor()
    expect(tracker.opened()).toBe(0)
    expect(tracker.latestState()).toBeUndefined()
    tracker.construct(url)
    tracker.construct(url)
    expect(tracker.opened()).toBe(2)
  })

  it("drops a live socket abruptly and resolves when it is closed", async () => {
    const tracker = trackingWebSocketConstructor()
    const socket = tracker.construct(url) as unknown as {
      once: (e: string, l: () => void) => unknown
      readyState: number
    }
    await opened(socket)
    expect(socket.readyState).toBe(SocketState.open)
    expect(tracker.latestState()).toBe(SocketState.open)
    // The report is what a case reads to know it cut a live connection rather
    // than one its own scope had already released.
    expect(await tracker.dropLatest("abrupt")).toEqual({ stateBefore: SocketState.open, cut: true })
    expect(socket.readyState).toBe(SocketState.closed)
    expect(tracker.latestState()).toBe(SocketState.closed)
  })

  it("closes a socket politely when asked to", async () => {
    const tracker = trackingWebSocketConstructor()
    const socket = tracker.construct(url) as unknown as {
      once: (e: string, l: () => void) => unknown
      readyState: number
    }
    await opened(socket)
    expect(await tracker.dropLatest("close")).toEqual({ stateBefore: SocketState.open, cut: true })
    expect(socket.readyState).toBe(SocketState.closed)
  })

  it("reports that a socket which is already closed was not cut", async () => {
    const tracker = trackingWebSocketConstructor()
    const socket = tracker.construct(url) as unknown as {
      once: (e: string, l: () => void) => unknown
      readyState: number
      close: () => void
      terminate: () => void
    }
    await opened(socket)
    await tracker.dropLatest("abrupt")
    expect(await dropWebSocket(socket, "abrupt")).toEqual({ stateBefore: SocketState.closed, cut: false })
    expect(socket.readyState).toBe(SocketState.closed)
  })

  it("refuses to drop when nothing has been constructed", async () => {
    const tracker = trackingWebSocketConstructor()
    await expect(tracker.dropLatest()).rejects.toThrow(/no socket has been constructed/)
  })
})
