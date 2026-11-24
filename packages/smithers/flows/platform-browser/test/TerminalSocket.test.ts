/**
 * TerminalSocket against a real WebSocket server (`ws`) on loopback, through
 * Node's own WHATWG `WebSocket`: the browser default `layerWebSocket`
 * provides it. Reconnect delays run on `it.effect`'s TestClock. The server is
 * the host's half of `TerminalProtocol`: it sends `ready` and `ended`, writes
 * bytes, and closes with the protocol's codes or drops the connection.
 *
 * A peer's frames end when its connection closes, so "nothing else arrived"
 * is read after the close, never after a wait.
 */
import { describe, expect, it } from "@effect/vitest"
import { RetryPolicy } from "@smthrs/flow"
import { TerminalProtocol } from "@smthrs/sandbox"
import type * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { WebSocket as NodeWsClient, type WebSocket as Peer, WebSocketServer } from "ws"
import { TerminalSocket } from "../src/index.ts"
import * as Telemetry from "./fixtures/Telemetry.ts"

interface Frame {
  readonly binary: boolean
  readonly text: string
}

interface Attached {
  readonly peer: Peer
  /** Every frame the client sent, ending when the connection closes. */
  readonly frames: Queue.Queue<Frame, Cause.Done>
  /** The close code the server saw. */
  readonly closed: Deferred.Deferred<number>
}

/** A WebSocket server on a free loopback port; each connection arrives on `peers`. */
const serve = Effect.gen(function*() {
  const peers = yield* Queue.unbounded<Attached>()
  const server = yield* Effect.acquireRelease(
    Effect.callback<WebSocketServer>((resume) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
      server.on("listening", () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const client of server.clients) client.terminate()
        server.close(() => resume(Effect.void))
      })
  )
  server.on("connection", (peer) => {
    const frames = Effect.runSync(Queue.unbounded<Frame, Cause.Done>())
    const closed = Deferred.makeUnsafe<number>()
    peer.on("message", (data, binary) => {
      Queue.offerUnsafe(frames, { binary, text: Buffer.from(data as Buffer).toString("utf8") })
    })
    peer.on("close", (code) => {
      Queue.endUnsafe(frames)
      Deferred.doneUnsafe(closed, Effect.succeed(code))
    })
    Queue.offerUnsafe(peers, { peer, frames, closed })
  })
  const { port } = server.address() as { readonly port: number }
  return { url: `ws://127.0.0.1:${port}/terminal`, peers }
})

const control = (peer: Peer, value: TerminalProtocol.ServerControl) =>
  Effect.sync(() => peer.send(TerminalProtocol.encodeServerControl(value)))

type Construct = (url: string, options?: Socket.WebSocketConstructorOptions) => Socket.WebSocketLike

const browserWebSocket: Construct = Effect.runSync(
  Socket.WebSocketConstructor.use(Effect.succeed).pipe(Effect.provide(TerminalSocket.layerWebSocket))
)

/** The browser default's constructor, counting each dial. */
const counted = (dials: { count: number }) =>
  Layer.succeed(Socket.WebSocketConstructor)((url, options) => {
    dials.count += 1
    return browserWebSocket(url, options)
  })

/** Collects every status until `done` holds for one. */
const statuses = (connection: TerminalSocket.Connection, done: (status: TerminalSocket.Status) => boolean) =>
  connection.status.pipe(Stream.takeUntil(done), Stream.runCollect, Effect.map((all) => Array.from(all)))

/** Waits until a status with `tag` comes. */
const reach = (connection: TerminalSocket.Connection, tag: TerminalSocket.Status["_tag"]) =>
  connection.status.pipe(Stream.filter((status) => status._tag === tag), Stream.take(1), Stream.runDrain)

const text = (received: Array<Uint8Array>) => new TextDecoder().decode(Buffer.concat(received))

const quiet = { onOutput: () => {} }

const openSocket = (onOutput: (data: Uint8Array) => void) =>
  Effect.gen(function*() {
    const { peers, url } = yield* serve
    const client = yield* Deferred.make<WebSocket>()
    const connection = yield* TerminalSocket.connect(url, { onOutput }).pipe(
      Effect.provideService(Socket.WebSocketConstructor, (url) => {
        const socket = new WebSocket(url)
        Deferred.doneUnsafe(client, Effect.succeed(socket))
        return socket
      })
    )
    yield* control((yield* Queue.take(peers)).peer, { type: "ready", access: "read" })
    yield* reach(connection, "Open")
    return { connection, socket: yield* Deferred.await(client) }
  })

describe("TerminalSocket", () => {
  it.effect("carries bytes both ways, and the latest size, once open with write access", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const received: Array<Uint8Array> = []
      const connection = yield* TerminalSocket.connect(url, { onOutput: (bytes) => received.push(bytes) })
      yield* connection.resize(80, 24)
      yield* connection.resize(120, 40)
      const { frames, peer } = yield* Queue.take(peers)
      yield* control(peer, { type: "ready", access: "write" })
      yield* reach(connection, "Open")
      yield* connection.send("ls\r")
      yield* connection.send(new TextEncoder().encode("é"))
      yield* connection.resize(120, 40)
      yield* connection.resize(100.7, 0)
      expect(yield* Queue.take(frames)).toEqual({ binary: false, text: TerminalProtocol.encodeResize(120, 40) })
      expect(yield* Queue.take(frames)).toEqual({ binary: true, text: "ls\r" })
      expect(yield* Queue.take(frames)).toEqual({ binary: true, text: "é" })
      expect(yield* Queue.take(frames)).toEqual({ binary: false, text: TerminalProtocol.encodeResize(100, 1) })
      yield* Effect.sync(() => {
        peer.send(Buffer.from("hello "))
        peer.send(Buffer.from([0xe2, 0x82]))
        peer.send(Buffer.from([0xac, 0x0a]))
        peer.send("not a control frame")
        peer.send(Buffer.from("done"))
      })
      while (text(received) !== "hello €\ndone") yield* Effect.yieldNow
      expect(received.map((bytes) => bytes.byteLength)).toEqual([6, 2, 2, 4])
    }).pipe(Effect.scoped, Effect.provide(TerminalSocket.layerWebSocket)))

  it.effect("splits a long paste into frames of at most 64 KiB, and clamps a size to the protocol's bounds", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const connection = yield* TerminalSocket.connect(url, quiet)
      const { frames, peer } = yield* Queue.take(peers)
      yield* control(peer, { type: "ready", access: "write" })
      yield* reach(connection, "Open")
      yield* connection.send("x".repeat(TerminalProtocol.maxFrameBytes * 2 + 3))
      yield* connection.send("")
      yield* connection.resize(Number.NaN, Number.POSITIVE_INFINITY)
      const pasted = [yield* Queue.take(frames), yield* Queue.take(frames), yield* Queue.take(frames)]
      expect(pasted.map((frame) => [frame.binary, frame.text.length])).toEqual([
        [true, TerminalProtocol.maxFrameBytes],
        [true, TerminalProtocol.maxFrameBytes],
        [true, 3]
      ])
      expect(yield* Queue.take(frames)).toEqual({
        binary: false,
        text: TerminalProtocol.encodeResize(1, TerminalProtocol.maxRows)
      })
    }).pipe(Effect.scoped, Effect.provide(TerminalSocket.layerWebSocket)))

  it.effect("sends neither input nor a size with read access", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const { closed, frames } = yield* Effect.scoped(Effect.gen(function*() {
        const connection = yield* TerminalSocket.connect(url, quiet)
        yield* connection.resize(90, 30)
        const attached = yield* Queue.take(peers)
        yield* control(attached.peer, { type: "ready", access: "read" })
        yield* reach(connection, "Open")
        yield* connection.send("rm -rf /\r")
        yield* connection.resize(91, 30)
        return attached
      }))
      expect(yield* Deferred.await(closed)).toBe(1000)
      expect(yield* Queue.collect(frames)).toEqual([])
    }).pipe(Effect.provide(TerminalSocket.layerWebSocket)))

  it.effect("drops what is typed before the terminal opens and while it is offline, and sends the latest size", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const connection = yield* TerminalSocket.connect(url, quiet)
      yield* connection.send("before\r")
      const first = yield* Queue.take(peers)
      yield* connection.send("connected, not ready\r")
      yield* Effect.sync(() => first.peer.terminate())
      yield* reach(connection, "Offline")
      yield* connection.send("offline\r")
      yield* connection.resize(70, 20)
      yield* connection.resize(72, 22)
      yield* TestClock.adjust(1_000)
      const second = yield* Queue.take(peers)
      yield* control(second.peer, { type: "ready", access: "write" })
      yield* reach(connection, "Open")
      yield* connection.send("after\r")
      expect(yield* Queue.take(second.frames)).toEqual({ binary: false, text: TerminalProtocol.encodeResize(72, 22) })
      expect(yield* Queue.take(second.frames)).toEqual({ binary: true, text: "after\r" })
      expect(yield* Queue.collect(first.frames)).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(TerminalSocket.layerWebSocket)))

  it.effect("ends with the host's reason on `ended`, closes its side, and never redials", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const dials = { count: 0 }
      const connection = yield* TerminalSocket.connect(url, quiet).pipe(Effect.provide(counted(dials)))
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Ended"))
      const { closed, frames, peer } = yield* Queue.take(peers)
      yield* control(peer, { type: "ready", access: "write" })
      yield* control(peer, { type: "ended", reason: "slept" })
      expect(yield* Fiber.join(all)).toEqual([
        { _tag: "Connecting" },
        { _tag: "Open", access: "write" },
        { _tag: "Ended", reason: "slept" }
      ])
      yield* connection.send("late\r")
      expect(yield* Deferred.await(closed)).toBe(1000)
      expect(yield* Queue.collect(frames)).toEqual([])
      yield* TestClock.adjust("1 hour")
      expect(dials.count).toBe(1)
    }).pipe(Effect.scoped))

  it.effect.each([
    TerminalProtocol.CloseCode.ended,
    TerminalProtocol.CloseCode.noAccess,
    TerminalProtocol.CloseCode.tooBig
  ])("closes for good on final code %i and never redials", (code) =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const dials = { count: 0 }
      const connection = yield* TerminalSocket.connect(url, quiet).pipe(Effect.provide(counted(dials)))
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Closed"))
      const { peer } = yield* Queue.take(peers)
      yield* Effect.sync(() => peer.close(code, "bye"))
      expect(yield* Fiber.join(all)).toEqual([{ _tag: "Connecting" }, { _tag: "Closed", code }])
      yield* TestClock.adjust("1 hour")
      expect(dials.count).toBe(1)
    }).pipe(Effect.scoped))

  it.effect("redials after 1006 and 1011 with the protocol's backoff, and stops after ten attempts", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const dials = { count: 0 }
      const connection = yield* TerminalSocket.connect(url, quiet).pipe(Effect.provide(counted(dials)))
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Closed"))
      for (let attempt = 1; attempt <= TerminalProtocol.reconnect.maxAttempts; attempt++) {
        const { peer } = yield* Queue.take(peers)
        yield* Effect.sync(() => (attempt % 2 === 0 ? peer.close(1011) : peer.terminate()))
        yield* connection.status.pipe(
          Stream.filter((status) => status._tag === "Offline" && status.attempt === attempt),
          Stream.take(1),
          Stream.runDrain
        )
        const delay = TerminalProtocol.reconnectDelay(attempt)!
        yield* TestClock.adjust(delay - 1)
        expect(dials.count).toBe(attempt)
        yield* TestClock.adjust(1)
      }
      const { peer } = yield* Queue.take(peers)
      yield* Effect.sync(() => peer.terminate())
      const seen = yield* Fiber.join(all)
      expect(seen.filter((status) => status._tag === "Offline")).toEqual(
        Array.from({ length: 10 }, (_, index) => ({
          _tag: "Offline",
          attempt: index + 1,
          code: index % 2 === 0 ? 1006 : 1011
        }))
      )
      expect(seen.at(-1)).toEqual({ _tag: "Closed", code: 1006 })
      expect(dials.count).toBe(11)
      yield* TestClock.adjust("1 hour")
      expect(dials.count).toBe(11)
    }).pipe(Effect.scoped))

  it("redials on the protocol's backoff, as a flow RetryPolicy: 1 s doubling to 30 s, ten redials", () => {
    for (let attempt = 1; attempt <= TerminalProtocol.reconnect.maxAttempts + 2; attempt++) {
      expect(RetryPolicy.nextDelay(TerminalSocket.reconnect, attempt)).toEqual(
        Option.fromUndefinedOr(TerminalProtocol.reconnectDelay(attempt))
      )
    }
  })

  it.effect("redials as the RetryPolicy it is given decides, and closes when that policy gives up", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const dials = { count: 0 }
      const reconnect = RetryPolicy.make({ initialMs: 100, factor: 1, maxMs: 100, maxAttempts: 3 })
      const connection = yield* TerminalSocket.connect(url, { ...quiet, reconnect }).pipe(
        Effect.provide(counted(dials))
      )
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Closed"))
      for (let attempt = 1; attempt <= 3; attempt++) {
        const { peer } = yield* Queue.take(peers)
        yield* Effect.sync(() => peer.terminate())
        if (attempt < 3) {
          yield* connection.status.pipe(
            Stream.filter((status) => status._tag === "Offline" && status.attempt === attempt),
            Stream.take(1),
            Stream.runDrain
          )
          yield* TestClock.adjust(100)
        }
      }
      expect(yield* Fiber.join(all)).toEqual([
        { _tag: "Connecting" },
        { _tag: "Offline", attempt: 1, code: 1006 },
        { _tag: "Connecting" },
        { _tag: "Offline", attempt: 2, code: 1006 },
        { _tag: "Connecting" },
        { _tag: "Closed", code: 1006 }
      ])
      yield* TestClock.adjust("1 hour")
      expect(dials.count).toBe(3)
    }).pipe(Effect.scoped))

  it.effect.each([
    { thrown: new Error("the frame is gone"), type: "Error" },
    { thrown: "the frame is gone", type: "unknown" }
  ])("closes as failed, hangs up and logs it when the output callback throws ($type), and never redials", ({
    thrown,
    type
  }) => {
    const telemetry = Telemetry.make()
    return telemetry.observed(
      Effect.gen(function*() {
        const { peers, url } = yield* serve
        const dials = { count: 0 }
        const connection = yield* TerminalSocket.connect(url, {
          onOutput: () => {
            throw thrown
          }
        }).pipe(Effect.provide(counted(dials)))
        const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Closed"))
        const { closed, peer } = yield* Queue.take(peers)
        yield* control(peer, { type: "ready", access: "write" })
        yield* reach(connection, "Open")
        yield* Effect.sync(() => peer.send(Buffer.from("output")))
        expect(yield* Fiber.join(all)).toEqual([
          { _tag: "Connecting" },
          { _tag: "Open", access: "write" },
          { _tag: "Closed", code: TerminalProtocol.CloseCode.failed }
        ])
        expect(yield* Deferred.await(closed)).toBe(1000)
        yield* TestClock.adjust("1 hour")
        expect(dials.count).toBe(1)
        expect(telemetry.lines("browser.terminal.closed").map((line) => line.annotations)).toEqual([
          { outcome: "defect", "error.type": type }
        ])
      }).pipe(Effect.scoped)
    )
  })

  it.effect("counts attempts from one again after a connection reached ready", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const connection = yield* TerminalSocket.connect(url, quiet)
      const all = yield* Effect.forkChild(
        statuses(connection, (status) => status._tag === "Offline" && status.code === 1011)
      )
      const first = yield* Queue.take(peers)
      yield* Effect.sync(() => first.peer.terminate())
      yield* reach(connection, "Offline")
      yield* TestClock.adjust(1_000)
      const second = yield* Queue.take(peers)
      yield* Effect.sync(() => second.peer.terminate())
      yield* connection.status.pipe(
        Stream.filter((status) => status._tag === "Offline" && status.attempt === 2),
        Stream.take(1),
        Stream.runDrain
      )
      yield* TestClock.adjust(2_000)
      const third = yield* Queue.take(peers)
      yield* control(third.peer, { type: "ready", access: "read" })
      yield* reach(connection, "Open")
      yield* Effect.sync(() => third.peer.close(1011))
      expect((yield* Fiber.join(all)).filter((status) => status._tag !== "Connecting")).toEqual([
        { _tag: "Offline", attempt: 1, code: 1006 },
        { _tag: "Offline", attempt: 2, code: 1006 },
        { _tag: "Open", access: "read" },
        { _tag: "Offline", attempt: 1, code: 1011 }
      ])
    }).pipe(Effect.scoped, Effect.provide(TerminalSocket.layerWebSocket)))

  it.effect("treats a refused connection, and a URL the constructor rejects, as dropped", () =>
    Effect.gen(function*() {
      const refused = yield* Effect.scoped(Effect.map(serve, ({ url }) => url))
      for (const url of [refused, "not a url"]) {
        const connection = yield* TerminalSocket.connect(url, quiet)
        expect(yield* statuses(connection, (status) => status._tag === "Offline")).toEqual([
          { _tag: "Connecting" },
          { _tag: "Offline", attempt: 1, code: 1006 }
        ])
      }
    }).pipe(Effect.scoped, Effect.provide(TerminalSocket.layerWebSocket)))

  it.effect("takes binary frames as a Blob or a Node Buffer when the socket keeps its own binaryType", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      // Real constructors (Node's WebSocket and the `ws` client) whose binaryType stays at their default.
      const blobs = Layer.succeed(Socket.WebSocketConstructor)((target) => {
        const socket = new globalThis.WebSocket(target)
        Object.defineProperty(socket, "binaryType", { get: () => "blob", set: () => {} })
        return socket
      })
      const buffers = Layer.succeed(Socket.WebSocketConstructor)((target) => {
        const socket = new NodeWsClient(target)
        Object.defineProperty(socket, "binaryType", { get: () => "nodebuffer", set: () => {} })
        return socket as unknown as Socket.WebSocketLike
      })
      for (const layer of [blobs, buffers]) {
        const received: Array<Uint8Array> = []
        yield* Effect.scoped(Effect.gen(function*() {
          yield* TerminalSocket.connect(url, { onOutput: (bytes) => received.push(bytes) }).pipe(Effect.provide(layer))
          const { peer } = yield* Queue.take(peers)
          yield* Effect.sync(() => {
            peer.send(Buffer.from("one "))
            peer.send(Buffer.from("two"))
          })
          while (text(received) !== "one two") yield* Effect.yieldNow
        }))
        expect(received.map((bytes) => [bytes.constructor.name, bytes.byteOffset, bytes.buffer.byteLength])).toEqual([
          ["Uint8Array", 0, 4],
          ["Uint8Array", 0, 3]
        ])
      }
    }).pipe(Effect.scoped))

  it.live.each([
    { data: {}, code: TerminalProtocol.CloseCode.unsupported },
    { data: "x".repeat(TerminalProtocol.maxFrameBytes + 1), code: TerminalProtocol.CloseCode.tooBig },
    { data: "😀".repeat(TerminalProtocol.maxFrameBytes / 3), code: TerminalProtocol.CloseCode.tooBig }
  ])("closes on an invalid inbound frame with code $code", ({ data, code }) =>
    Effect.gen(function*() {
      const { connection, socket } = yield* openSocket(quiet.onOutput)
      socket.dispatchEvent(new MessageEvent("message", { data }))
      expect((yield* statuses(connection, (state) => state._tag === "Closed")).at(-1)).toEqual({ _tag: "Closed", code })
    }).pipe(Effect.scoped))

  it.live.each([
    { count: 65, bytes: 1 },
    { count: 17, bytes: TerminalProtocol.maxFrameBytes },
    { count: 1, bytes: TerminalProtocol.maxFrameBytes + 1 }
  ])(
    "closes on inbound overflow while decoding stalls ($count frames of $bytes bytes)",
    ({ count, bytes }) =>
      Effect.gen(function*() {
        const decoding = yield* Deferred.make<void>()
        const effects: Uint8Array[] = []
        const { connection, socket } = yield* openSocket((chunk) => effects.push(chunk))
        const stalled = new class extends Blob {
          override arrayBuffer(): Promise<ArrayBuffer> {
            Deferred.doneUnsafe(decoding, Effect.void)
            return new Promise(() => {})
          }
        }()
        socket.dispatchEvent(new MessageEvent("message", { data: stalled }))
        yield* Deferred.await(decoding)
        for (let index = 0; index < count; index++) {
          socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(bytes) }))
        }
        expect((yield* statuses(connection, (state) => state._tag === "Closed")).at(-1)).toEqual({
          _tag: "Closed",
          code: TerminalProtocol.CloseCode.tooBig
        })
        expect(effects).toEqual([])
      }).pipe(Effect.scoped)
  )

  it.effect("closing the scope closes the socket, stops redialing and ends the status", () =>
    Effect.gen(function*() {
      const { peers, url } = yield* serve
      const dials = { count: 0 }
      const { attached, status } = yield* Effect.scoped(Effect.gen(function*() {
        const connection = yield* TerminalSocket.connect(url, quiet).pipe(Effect.provide(counted(dials)))
        const attached = yield* Queue.take(peers)
        yield* control(attached.peer, { type: "ready", access: "write" })
        yield* reach(connection, "Open")
        return { attached, status: connection.status }
      }))
      expect(yield* Deferred.await(attached.closed)).toBe(1000)
      yield* TestClock.adjust("1 hour")
      expect(dials.count).toBe(1)
      // The status stream ends with the scope instead of waiting forever.
      expect((yield* Effect.exit(Stream.runDrain(status)))._tag).toBe("Success")
    }).pipe(Effect.scoped))
})
