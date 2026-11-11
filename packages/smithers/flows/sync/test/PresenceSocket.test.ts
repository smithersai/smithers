/**
 * PresenceSocket over a fake `Socket.WebSocketConstructor`: each dial lands on
 * `dials` as a socket the test drives, delivering the room's frames and
 * closing with the protocol's codes. Reconnect delays run on `it.effect`'s
 * TestClock. The last case wires two pages to a real PresenceRoom over the
 * in-memory host.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Socket from "effect/socket/Socket"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as PresenceProtocol from "../src/PresenceProtocol.ts"
import * as PresenceRoom from "../src/PresenceRoom.ts"
import * as PresenceSocket from "../src/PresenceSocket.ts"
import { makeHost } from "./presenceHost.ts"

type Listener = (event: Socket.WebSocketEvent) => void

/** A page's socket as the test sees it: what the page sent, and how to answer. */
class FakeSocket implements Socket.WebSocketLike {
  readyState = 1
  readonly sent: Array<string> = []
  closedWith: number | undefined
  private readonly listeners = new Map<string, Set<Listener>>()
  readonly url: string
  constructor(url: string) {
    this.url = url
  }
  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener)
  }
  send(data: string | Uint8Array) {
    this.sent.push(data as string)
  }
  close(code?: number) {
    this.closedWith = code
  }
  emit(type: string, event: Socket.WebSocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  /** The room's frame, or any other message. */
  message(data: unknown) {
    this.emit("message", { data })
  }
  roster(self: string, participants: ReadonlyArray<PresenceProtocol.Participant>) {
    this.message(PresenceProtocol.encodeServerFrame({ type: "roster", self, participants }))
  }
  /** The connection ends: an error, then a close with `code`, or none. */
  drop(code?: number) {
    this.readyState = 3
    this.emit("error", {})
    this.emit("close", code === undefined ? {} : { code })
  }
  /** The states this socket carried, decoded. */
  states() {
    return this.sent.map((text) => PresenceProtocol.decodeClientFrame(text)?.state)
  }
}

const url = "wss://app.test/presence/branch-1"

/** A constructor whose every dial lands on `dials`. */
const fake = Effect.gen(function*() {
  const dials = yield* Queue.unbounded<FakeSocket>()
  const layer = Layer.succeed(Socket.WebSocketConstructor)((target) => {
    const socket = new FakeSocket(target)
    Queue.offerUnsafe(dials, socket)
    return socket
  })
  return { dials, layer }
})

const participant = (id: string, state: string | null = null): PresenceProtocol.Participant => ({
  id,
  principal: `github:${id}`,
  name: id,
  access: "write",
  state
})

/** Collects every status until `done` holds for one. */
const statuses = (connection: PresenceSocket.Connection, done: (status: PresenceSocket.Status) => boolean) =>
  connection.status.pipe(Stream.takeUntil(done), Stream.runCollect, Effect.map((all) => Array.from(all)))

/** Waits until a status with `tag` comes. */
const reach = (connection: PresenceSocket.Connection, tag: PresenceSocket.Status["_tag"]) =>
  connection.status.pipe(Stream.filter((status) => status._tag === tag), Stream.take(1), Stream.runDrain)

const offline = (connection: PresenceSocket.Connection, attempt: number) =>
  connection.status.pipe(
    Stream.filter((status) => status._tag === "Offline" && status.attempt === attempt),
    Stream.take(1),
    Stream.runDrain
  )

describe("PresenceSocket", () => {
  it.effect("opens on the first roster, then sends the latest state and follows the roster", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const rosters = yield* Effect.forkChild(connection.roster.pipe(Stream.take(3), Stream.runCollect))
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Open"))
      yield* connection.set("first")
      yield* connection.set("second")
      const socket = yield* Queue.take(dials)
      expect(socket.url).toBe(url)
      socket.message("not a roster")
      socket.message(new Uint8Array([1, 2]))
      expect(socket.sent).toEqual([])
      socket.roster("me", [participant("ada"), participant("me")])
      expect(yield* Fiber.join(all)).toEqual([{ _tag: "Connecting" }, { _tag: "Open", self: "me" }])
      expect(socket.states()).toEqual(["second"])
      socket.roster("me", [participant("ada", "x"), participant("me", "second")])
      expect(Array.from(yield* Fiber.join(rosters))).toEqual([
        [],
        [participant("ada"), participant("me")],
        [participant("ada", "x"), participant("me", "second")]
      ])
    }).pipe(Effect.scoped))

  it.effect("sends each new state, and never one the room already holds", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const socket = yield* Queue.take(dials)
      socket.roster("me", [participant("me")])
      yield* reach(connection, "Open")
      for (const state of [null, "a", "a", null, "€".repeat(341)]) {
        yield* connection.set(state)
        yield* TestClock.adjust(PresenceProtocol.stateIntervalMs)
      }
      expect(socket.states()).toEqual(["a", null, "€".repeat(341)])
    }).pipe(Effect.scoped))

  it.effect("sends at most one state per interval, the latest when it has passed", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const socket = yield* Queue.take(dials)
      socket.roster("me", [participant("me")])
      yield* reach(connection, "Open")
      yield* connection.set("a")
      expect(socket.states()).toEqual(["a"])
      for (let move = 0; move < 50; move++) yield* connection.set(`b${move}`)
      yield* TestClock.adjust(PresenceProtocol.stateIntervalMs - 1)
      expect(socket.states()).toEqual(["a"])
      yield* TestClock.adjust(1)
      expect(socket.states()).toEqual(["a", "b49"])
      // Back where the room already holds it: nothing to send when the interval passes.
      yield* connection.set("c")
      yield* connection.set("b49")
      yield* TestClock.adjust(PresenceProtocol.stateIntervalMs)
      expect(socket.states()).toEqual(["a", "b49"])
      // A state after a quiet interval goes at once.
      yield* connection.set("d")
      expect(socket.states()).toEqual(["a", "b49", "d"])
    }).pipe(Effect.scoped))

  it.effect("dies on a state over 1024 bytes of UTF-8", () =>
    Effect.gen(function*() {
      const { layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      for (const state of ["x".repeat(1025), "€".repeat(342)]) {
        const exit = yield* Effect.exit(connection.set(state))
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "PlatformError",
            reason: { _tag: "BadArgument", module: "PresenceSocket", method: "set" }
          })
        }
      }
    }).pipe(Effect.scoped))

  it.effect("empties the roster when the connection drops, and sends only the latest state after reconnecting", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const rosters = yield* Effect.forkChild(connection.roster.pipe(Stream.take(4), Stream.runCollect))
      const first = yield* Queue.take(dials)
      first.roster("one", [participant("one")])
      yield* reach(connection, "Open")
      yield* connection.set("a")
      first.drop(1006)
      yield* offline(connection, 1)
      yield* connection.set("b")
      yield* connection.set("c")
      yield* TestClock.adjust(1_000)
      const second = yield* Queue.take(dials)
      second.roster("two", [participant("two")])
      yield* connection.status.pipe(
        Stream.filter((status) => status._tag === "Open" && status.self === "two"),
        Stream.take(1),
        Stream.runDrain
      )
      expect(first.states()).toEqual(["a"])
      expect(second.states()).toEqual(["c"])
      expect(Array.from(yield* Fiber.join(rosters))).toEqual([
        [],
        [participant("one")],
        [],
        [participant("two")]
      ])
    }).pipe(Effect.scoped))

  it.effect("sends no state after reconnecting when the latest is null", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const first = yield* Queue.take(dials)
      first.roster("one", [])
      yield* reach(connection, "Open")
      yield* connection.set("a")
      yield* connection.set(null)
      first.drop(PresenceProtocol.CloseCode.changed)
      yield* offline(connection, 1)
      yield* TestClock.adjust(1_000)
      const second = yield* Queue.take(dials)
      second.roster("two", [])
      yield* connection.status.pipe(
        Stream.filter((status) => status._tag === "Open" && status.self === "two"),
        Stream.take(1),
        Stream.runDrain
      )
      expect(second.sent).toEqual([])
    }).pipe(Effect.scoped))

  it.effect.each([
    PresenceProtocol.CloseCode.left,
    PresenceProtocol.CloseCode.unsupported,
    PresenceProtocol.CloseCode.noAccess,
    PresenceProtocol.CloseCode.tooBig
  ])("closes for good on final code %i and never redials", (code) =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Closed"))
      const socket = yield* Queue.take(dials)
      socket.roster("me", [participant("me")])
      socket.drop(code)
      expect(yield* Fiber.join(all)).toEqual([
        { _tag: "Connecting" },
        { _tag: "Open", self: "me" },
        { _tag: "Closed", code }
      ])
      yield* TestClock.adjust("1 hour")
      expect(yield* Queue.size(dials)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect.each([PresenceProtocol.CloseCode.changed, PresenceProtocol.CloseCode.full])(
    "redials after 1 s on code %i",
    (code) =>
      Effect.gen(function*() {
        const { dials, layer } = yield* fake
        const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
        const first = yield* Queue.take(dials)
        first.drop(code)
        yield* offline(connection, 1)
        yield* TestClock.adjust(999)
        expect(yield* Queue.size(dials)).toBe(0)
        yield* TestClock.adjust(1)
        expect((yield* Queue.take(dials)).url).toBe(url)
      }).pipe(Effect.scoped)
  )

  it.effect("redials with the protocol's backoff and stops after ten attempts", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const all = yield* Effect.forkChild(statuses(connection, (status) => status._tag === "Closed"))
      for (let attempt = 1; attempt <= PresenceProtocol.reconnect.maxAttempts; attempt++) {
        const socket = yield* Queue.take(dials)
        socket.drop(attempt % 2 === 0 ? 1011 : undefined)
        yield* offline(connection, attempt)
        yield* TestClock.adjust(PresenceProtocol.reconnectDelay(attempt)! - 1)
        expect(yield* Queue.size(dials)).toBe(0)
        yield* TestClock.adjust(1)
      }
      const last = yield* Queue.take(dials)
      last.drop(1006)
      const seen = yield* Fiber.join(all)
      expect(seen.filter((status) => status._tag === "Offline")).toEqual(
        Array.from({ length: 10 }, (_, index) => ({
          _tag: "Offline",
          attempt: index + 1,
          code: index % 2 === 0 ? 1006 : 1011
        }))
      )
      expect(seen.at(-1)).toEqual({ _tag: "Closed", code: 1006 })
      yield* TestClock.adjust("1 hour")
      expect(yield* Queue.size(dials)).toBe(0)
    }).pipe(Effect.scoped))

  it.effect("counts attempts from one again after a connection received a roster", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      const all = yield* Effect.forkChild(
        statuses(connection, (status) => status._tag === "Offline" && status.code === 1013)
      )
      ;(yield* Queue.take(dials)).drop(1006)
      yield* offline(connection, 1)
      yield* TestClock.adjust(1_000)
      ;(yield* Queue.take(dials)).drop(1006)
      yield* offline(connection, 2)
      yield* TestClock.adjust(2_000)
      const third = yield* Queue.take(dials)
      third.roster("me", [])
      yield* reach(connection, "Open")
      third.drop(1013)
      expect((yield* Fiber.join(all)).filter((status) => status._tag !== "Connecting")).toEqual([
        { _tag: "Offline", attempt: 1, code: 1006 },
        { _tag: "Offline", attempt: 2, code: 1006 },
        { _tag: "Open", self: "me" },
        { _tag: "Offline", attempt: 1, code: 1013 }
      ])
    }).pipe(Effect.scoped))

  it.effect("treats a URL the constructor rejects as dropped", () =>
    Effect.gen(function*() {
      const refusing = Layer.succeed(Socket.WebSocketConstructor)(() => {
        throw new SyntaxError("Invalid URL")
      })
      const connection = yield* PresenceSocket.connect("not a url").pipe(Effect.provide(refusing))
      expect(yield* statuses(connection, (status) => status._tag === "Offline")).toEqual([
        { _tag: "Connecting" },
        { _tag: "Offline", attempt: 1, code: 1006 }
      ])
    }).pipe(Effect.scoped))

  it.effect("closing the scope closes the socket with 1000, stops redialing, and ends both streams", () =>
    Effect.gen(function*() {
      const { dials, layer } = yield* fake
      const { connection, socket } = yield* Effect.scoped(Effect.gen(function*() {
        const connection = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
        const socket = yield* Queue.take(dials)
        socket.roster("me", [participant("me")])
        yield* reach(connection, "Open")
        return { connection, socket }
      }))
      expect(socket.closedWith).toBe(1000)
      // Its own close event after the hang-up reaches no one.
      socket.drop(1000)
      yield* TestClock.adjust("1 hour")
      expect(yield* Queue.size(dials)).toBe(0)
      expect((yield* Effect.exit(Stream.runDrain(connection.status)))._tag).toBe("Success")
      expect((yield* Effect.exit(Stream.runDrain(connection.roster)))._tag).toBe("Success")
      yield* connection.set("late")
      expect(socket.sent).toEqual([])
    }))

  it.effect("two pages see each other through a real room", () =>
    Effect.gen(function*() {
      const room = makeHost()
      /** Each dial joins the room as the next name; frames cross both ways in memory. */
      const names = ["ada", "bob"]
      const layer = Layer.succeed(Socket.WebSocketConstructor)((target) => {
        const page = new FakeSocket(target)
        const server = room.accept()
        server.raw.onSend = (text) => page.message(text)
        page.send = (data) => Effect.runSync(PresenceRoom.receive(room.host, server, data as string))
        queueMicrotask(() => {
          Effect.runSync(PresenceRoom.join(room.host, server, { principal: "p", name: names.shift()!, access: "read" }))
        })
        return page
      })
      const ada = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      yield* reach(ada, "Open")
      const bob = yield* PresenceSocket.connect(url).pipe(Effect.provide(layer))
      yield* reach(bob, "Open")
      yield* ada.set("{\"path\":\"src/a.ts\"}")
      const seen = yield* bob.roster.pipe(
        Stream.filter((roster) => roster.some((participant) => participant.state !== null)),
        Stream.take(1),
        Stream.runCollect
      )
      expect(Array.from(seen)[0]!.map((participant) => [participant.name, participant.state])).toEqual([
        ["ada", "{\"path\":\"src/a.ts\"}"],
        ["bob", null]
      ])
    }).pipe(Effect.scoped))
})
