/**
 * PresenceRoom over an in-memory host shaped like a hibernating Durable
 * Object (`presenceHost.ts`): every read of the host's sockets wraps them
 * afresh and attachments survive only as structured clones, so these tests
 * also prove the room keeps nothing in memory.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Metric from "effect/Metric"
import * as TestClock from "effect/testing/TestClock"
import * as PresenceProtocol from "../src/PresenceProtocol.ts"
import * as PresenceRoom from "../src/PresenceRoom.ts"
import { hostOver, makeHost, type TestSocket } from "./presenceHost.ts"

const { CloseCode } = PresenceProtocol

const person = (name: string, access: PresenceProtocol.Access = "write"): PresenceRoom.Identity => ({
  principal: `github:${name}`,
  name,
  access
})

/** The last roster `socket` received, decoded. */
const lastRoster = (socket: TestSocket) => {
  const text = socket.raw.sent.at(-1)
  return text === undefined ? undefined : PresenceProtocol.decodeServerFrame(text)
}

const namesSeenBy = (socket: TestSocket) => lastRoster(socket)?.participants.map((participant) => participant.name)

const stateFrame = (state: string | null) => PresenceProtocol.encodeClientFrame({ type: "state", state })

/** Joins one socket per name, in order. */
const joinAll = (room: ReturnType<typeof makeHost>, names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) =>
    Effect.gen(function*() {
      const socket = room.accept()
      expect(yield* PresenceRoom.join(room.host, socket, person(name))).toBe("joined")
      return socket
    }))

const isolated = <A, E>(effect: Effect.Effect<A, E>) => Effect.provideService(effect, Metric.MetricRegistry, new Map())

describe("PresenceRoom", () => {
  it.effect("sends every connection the roster in join order, each with its own self", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob, cy] = yield* joinAll(room, ["ada", "bob", "cy"])
      expect(ada!.raw.sent).toHaveLength(3)
      expect(bob!.raw.sent).toHaveLength(2)
      expect(cy!.raw.sent).toHaveLength(1)
      const ids = (yield* PresenceRoom.connections(room.host)).map((connection) => connection.participant.id)
      expect(new Set(ids).size).toBe(3)
      for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
      for (const [index, socket] of [ada!, bob!, cy!].entries()) {
        expect(lastRoster(socket)).toEqual({
          type: "roster",
          self: ids[index],
          participants: ["ada", "bob", "cy"].map((name, at) => ({
            id: ids[at],
            principal: `github:${name}`,
            name,
            access: "write",
            state: null
          }))
        })
      }
    }))

  it.effect("relays a state to everyone and keeps it through hibernation", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      yield* PresenceRoom.receive(room.host, bob!, stateFrame("{\"path\":\"README.md\"}"))
      for (const socket of [ada!, bob!]) {
        expect(lastRoster(socket)?.participants.map((participant) => participant.state)).toEqual([
          null,
          "{\"path\":\"README.md\"}"
        ])
      }
      // A woken object: a new host over the same sockets, nothing else.
      const woken = hostOver(room.raws)
      const after = yield* PresenceRoom.connections(woken)
      expect(after.map((connection) => [connection.participant.name, connection.participant.state])).toEqual([
        ["ada", null],
        ["bob", "{\"path\":\"README.md\"}"]
      ])
      yield* PresenceRoom.receive(woken, after[0]!.socket, stateFrame(null))
      expect(namesSeenBy(bob!)).toEqual(["ada", "bob"])
      expect(lastRoster(bob!)?.participants.map((participant) => participant.state)).toEqual([
        null,
        "{\"path\":\"README.md\"}"
      ])
    }))

  it.effect("keeps join order after a departure, and a newcomer joins last", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob, cy] = yield* joinAll(room, ["ada", "bob", "cy"])
      yield* PresenceRoom.leave(room.host, cy!)
      room.drop(cy!)
      const [dee] = yield* joinAll(room, ["dee"])
      // The runtime hands sockets back in any order.
      room.raws.reverse()
      expect(namesSeenBy(dee!)).toEqual(["ada", "bob", "dee"])
      expect((yield* PresenceRoom.connections(room.host)).map((connection) => connection.participant.name)).toEqual([
        "ada",
        "bob",
        "dee"
      ])
      expect(namesSeenBy(ada!)).toEqual(namesSeenBy(bob!))
    }))

  it.effect("gives everyone one order when two joins read the room at once", () =>
    Effect.gen(function*() {
      const room = makeHost()
      // A host whose first two reads see the room as it was when each began,
      // and finish only once both have begun: each join reads the room
      // before either writes.
      const bothReading = yield* Deferred.make<void>()
      let reads = 0
      const host: PresenceRoom.RoomHost<TestSocket> = {
        sockets: Effect.gen(function*() {
          const read = (yield* room.host.sockets).map((socket): TestSocket => {
            const attachment = socket.deserializeAttachment()
            return { ...socket, deserializeAttachment: <T>() => attachment as T | null }
          })
          reads += 1
          if (reads === 2) yield* Deferred.succeed(bothReading, undefined)
          if (reads <= 2) yield* Deferred.await(bothReading)
          return read
        })
      }
      const [ada, bob] = [room.accept(), room.accept()]
      yield* Effect.all([PresenceRoom.join(host, ada, person("ada")), PresenceRoom.join(host, bob, person("bob"))], {
        concurrency: "unbounded"
      })
      const order = (yield* PresenceRoom.connections(host)).map((connection) => connection.participant.id)
      expect(order).toEqual([...order].sort())
      const seqs = room.raws.map((raw) => (raw.attachment as { readonly seq: number }).seq)
      expect(seqs).toEqual([1, 1])
      expect(lastRoster(ada)?.participants.map((participant) => participant.id)).toEqual(order)
      expect(lastRoster(bob)?.participants.map((participant) => participant.id)).toEqual(order)
    }))

  it.effect("keeps host data on the connection and out of every frame", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const socket = room.accept()
      const data = "d".repeat(PresenceProtocol.maxDataBytes)
      yield* PresenceRoom.join(room.host, socket, { ...person("ada", "read"), data })
      const [plain] = yield* joinAll(room, ["bob"])
      const connections = yield* PresenceRoom.connections(room.host)
      expect(connections.map((connection) => connection.data)).toEqual([data, undefined])
      expect(connections[0]!.participant.access).toBe("read")
      for (const text of [...socket.raw.sent, ...plain!.raw.sent]) expect(text).not.toContain("ddd")
    }))

  it.effect("dies on data over 512 bytes of UTF-8, and on joining a socket twice", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const tooMuch = yield* Effect.exit(
        PresenceRoom.join(room.host, room.accept(), { ...person("ada"), data: "€".repeat(171) })
      )
      expect(Exit.isFailure(tooMuch) && Cause.hasDies(tooMuch.cause)).toBe(true)
      if (Exit.isFailure(tooMuch)) {
        expect(Cause.squash(tooMuch.cause)).toMatchObject({
          _tag: "PlatformError",
          reason: { _tag: "BadArgument", module: "PresenceRoom", method: "join" }
        })
      }
      const socket = room.accept()
      yield* PresenceRoom.join(room.host, socket, person("bob"))
      const twice = yield* Effect.exit(PresenceRoom.join(room.host, socket, person("bob")))
      expect(Exit.isFailure(twice) && Cause.hasDies(twice.cause)).toBe(true)
      if (Exit.isFailure(twice)) {
        expect(Cause.squash(twice.cause)).toMatchObject({
          _tag: "PlatformError",
          reason: { _tag: "BadArgument", module: "PresenceRoom", method: "join" }
        })
      }
      expect(yield* PresenceRoom.connections(room.host)).toHaveLength(1)
    }))

  it.effect("closes the 257th socket with full and tells no one", () =>
    isolated(Effect.gen(function*() {
      const room = makeHost()
      const joined = yield* joinAll(room, Array.from({ length: PresenceProtocol.maxParticipants }, (_, i) => `p${i}`))
      const before = joined[0]!.raw.sent.length
      const late = room.accept()
      expect(yield* PresenceRoom.join(room.host, late, person("late"))).toBe("full")
      expect(late.raw.closed).toEqual({ code: CloseCode.full, reason: "full" })
      expect(late.raw.attachment).toBeUndefined()
      expect(joined[0]!.raw.sent).toHaveLength(before)
      expect(yield* PresenceRoom.connections(room.host)).toHaveLength(256)
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.joins, { outcome: "full" }))).count).toBe(1)
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.joins, { outcome: "joined" }))).count).toBe(256)
      // A departure makes room again.
      yield* PresenceRoom.leave(room.host, joined[0]!)
      expect(yield* PresenceRoom.join(room.host, room.accept(), person("late"))).toBe("joined")
    })))

  it.effect.each(
    [
      ["an ArrayBuffer", new ArrayBuffer(2), CloseCode.unsupported, "unsupported"],
      ["a Uint8Array", new Uint8Array([123, 125]), CloseCode.unsupported, "unsupported"],
      ["malformed JSON", "{", CloseCode.unsupported, "unsupported"],
      ["another frame type", "{\"type\":\"roster\"}", CloseCode.unsupported, "unsupported"],
      ["a state over 1024 bytes", stateFrame("x".repeat(1025)), CloseCode.unsupported, "unsupported"],
      ["a frame over 2048 bytes", stateFrame("x".repeat(2048)), CloseCode.tooBig, "too_big"],
      ["a frame over 2048 bytes of UTF-8", stateFrame("é".repeat(1020)), CloseCode.tooBig, "too_big"]
    ] as const
  )(
    "closes a socket that sends %s, and the others hear without it",
    ([, message, code, outcome]) =>
      isolated(Effect.gen(function*() {
        const room = makeHost()
        const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
        yield* PresenceRoom.receive(room.host, bob!, message)
        expect(bob!.raw.closed?.code).toBe(code)
        expect(bob!.raw.attachment).toBeNull()
        expect(bob!.raw.sent).toHaveLength(1)
        expect(namesSeenBy(ada!)).toEqual(["ada"])
        expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.frames, { outcome }))).count).toBe(1)
        expect((yield* Metric.value(PresenceRoom.open)).count).toBe(1)
      }))
  )

  it.effect("sends nothing for a state the connection already holds, for a read-only one too", () =>
    isolated(Effect.gen(function*() {
      const room = makeHost()
      const ada = room.accept()
      const bob = room.accept()
      yield* PresenceRoom.join(room.host, ada, person("ada"))
      yield* PresenceRoom.join(room.host, bob, person("bob", "read"))
      yield* PresenceRoom.receive(room.host, bob, stateFrame(null))
      expect([ada.raw.sent.length, bob.raw.sent.length]).toEqual([2, 1])
      yield* PresenceRoom.receive(room.host, bob, stateFrame("{\"path\":\"a.ts\"}"))
      expect([ada.raw.sent.length, bob.raw.sent.length]).toEqual([3, 2])
      for (let frame = 0; frame < 5; frame++) {
        yield* PresenceRoom.receive(hostOver(room.raws), bob, stateFrame("{\"path\":\"a.ts\"}"))
      }
      expect([ada.raw.sent.length, bob.raw.sent.length]).toEqual([3, 2])
      expect(lastRoster(ada)?.participants.map((participant) => participant.state)).toEqual([
        null,
        "{\"path\":\"a.ts\"}"
      ])
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.frames, { outcome: "unchanged" }))).count).toBe(6)
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.frames, { outcome: "state" }))).count).toBe(1)
    })))

  it.effect("closes a connection past 20 frames in one second with tooFast, and the others hear without it", () =>
    isolated(Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      // Unchanged frames count too: a page cannot loop on its own state.
      for (let frame = 0; frame < PresenceProtocol.maxStatesPerSecond; frame++) {
        yield* PresenceRoom.receive(hostOver(room.raws), bob!, stateFrame("same"))
      }
      expect(bob!.raw.closed).toBeUndefined()
      yield* TestClock.adjust(999)
      yield* PresenceRoom.receive(hostOver(room.raws), bob!, stateFrame("one more"))
      expect(bob!.raw.closed?.code).toBe(CloseCode.tooFast)
      expect(bob!.raw.attachment).toBeNull()
      expect(namesSeenBy(ada!)).toEqual(["ada"])
      expect(PresenceProtocol.isFinal(CloseCode.tooFast)).toBe(false)
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.frames, { outcome: "too_fast" }))).count).toBe(1)
      expect((yield* Metric.value(PresenceRoom.open)).count).toBe(1)
    })))

  it.effect("counts frames per connection, and a new second starts the count afresh", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      for (let second = 0; second < 3; second++) {
        for (let frame = 0; frame < PresenceProtocol.maxStatesPerSecond; frame++) {
          yield* PresenceRoom.receive(room.host, ada!, stateFrame(`ada ${second} ${frame}`))
          yield* PresenceRoom.receive(room.host, bob!, stateFrame(`bob ${second} ${frame}`))
        }
        yield* TestClock.adjust(1_000)
      }
      expect([ada!.raw.closed, bob!.raw.closed]).toEqual([undefined, undefined])
      expect(lastRoster(ada!)?.participants.map((participant) => participant.state)).toEqual(["ada 2 19", "bob 2 19"])
    }))

  it.effect("ignores every message from a socket that has not joined or has left", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      const stranger = room.accept()
      yield* PresenceRoom.leave(room.host, bob!)
      const before = ada!.raw.sent.length
      for (const socket of [stranger, bob!]) {
        yield* PresenceRoom.receive(room.host, socket, stateFrame("here"))
        yield* PresenceRoom.receive(room.host, socket, new Uint8Array([1]))
      }
      expect(ada!.raw.sent).toHaveLength(before)
      expect([stranger.raw.closed, bob!.raw.closed]).toEqual([undefined, undefined])
    }))

  it.effect("leaves once: a second leave, or a leave before joining, tells no one", () =>
    isolated(Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      yield* PresenceRoom.leave(room.host, bob!)
      expect(namesSeenBy(ada!)).toEqual(["ada"])
      const before = ada!.raw.sent.length
      yield* PresenceRoom.leave(room.host, bob!)
      yield* PresenceRoom.leave(room.host, room.accept())
      expect(ada!.raw.sent).toHaveLength(before)
      expect(bob!.raw.closed).toBeUndefined()
      expect((yield* Metric.value(PresenceRoom.open)).count).toBe(1)
    })))

  it.effect("closes one connection with a code and tells the others; closes a stranger without telling", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      yield* PresenceRoom.close(room.host, bob!, CloseCode.changed)
      expect(bob!.raw.closed?.code).toBe(CloseCode.changed)
      expect(namesSeenBy(ada!)).toEqual(["ada"])
      const before = ada!.raw.sent.length
      const stranger = room.accept()
      yield* PresenceRoom.close(room.host, stranger, CloseCode.noAccess)
      expect(stranger.raw.closed?.code).toBe(CloseCode.noAccess)
      expect(ada!.raw.sent).toHaveLength(before)
    }))

  it.effect("evicts every connection of one principal, tells the others once, and counts them", () =>
    isolated(Effect.gen(function*() {
      const room = makeHost()
      const [ada, bobDesk, cy, bobLaptop] = yield* joinAll(room, ["ada", "bob", "cy", "bob"])
      const before = [ada!, cy!].map((socket) => socket.raw.sent.length)
      expect(yield* PresenceRoom.evict(room.host, "github:bob")).toBe(2)
      expect([bobDesk!.raw.closed?.code, bobLaptop!.raw.closed?.code]).toEqual([CloseCode.noAccess, CloseCode.noAccess])
      expect([ada!, cy!].map((socket, index) => socket.raw.sent.length - before[index]!)).toEqual([1, 1])
      expect(namesSeenBy(cy!)).toEqual(["ada", "cy"])
      expect((yield* Metric.value(PresenceRoom.evictions)).count).toBe(2)
      expect((yield* Metric.value(PresenceRoom.open)).count).toBe(2)
      expect(yield* PresenceRoom.evict(room.host, "github:nobody")).toBe(0)
      expect(yield* PresenceRoom.evict(room.host, "github:cy", CloseCode.changed)).toBe(1)
      expect(cy!.raw.closed?.code).toBe(CloseCode.changed)
      expect(namesSeenBy(ada!)).toEqual(["ada"])
    })))

  it.effect.each(["fail", "die", "throw"] as const)(
    "drops a socket whose send %ss and tells the rest again without it",
    (fault) =>
      isolated(Effect.gen(function*() {
        const room = makeHost()
        const [ada, bob, cy] = yield* joinAll(room, ["ada", "bob", "cy"])
        bob!.raw.sendFault = fault
        yield* PresenceRoom.receive(room.host, ada!, stateFrame("moved"))
        expect(namesSeenBy(ada!)).toEqual(["ada", "cy"])
        expect(namesSeenBy(cy!)).toEqual(["ada", "cy"])
        expect(bob!.raw.attachment).toBeNull()
        expect((yield* Metric.value(PresenceRoom.open)).count).toBe(2)
        // The host's close event for it later changes nothing.
        const before = ada!.raw.sent.length
        yield* PresenceRoom.leave(room.host, bob!)
        expect(ada!.raw.sent).toHaveLength(before)
      }))
  )

  it.effect("survives a socket that already closed, whose send throws as workerd's does", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob] = yield* joinAll(room, ["ada", "bob"])
      bob!.raw.closed = { code: 1006, reason: "" }
      yield* PresenceRoom.leave(room.host, ada!)
      expect(yield* PresenceRoom.connections(room.host)).toEqual([])
    }))

  it.effect.each(["fail", "die", "throw"] as const)(
    "never fails when closing a socket %ss",
    (fault) =>
      Effect.gen(function*() {
        const room = makeHost()
        const [ada, bob, cy] = yield* joinAll(room, ["ada", "bob", "cy"])
        for (const socket of [bob!, cy!]) socket.raw.closeFault = fault
        yield* PresenceRoom.close(room.host, bob!, CloseCode.noAccess)
        expect(yield* PresenceRoom.evict(room.host, "github:cy")).toBe(1)
        yield* PresenceRoom.receive(room.host, ada!, new ArrayBuffer(1))
        expect(yield* PresenceRoom.connections(room.host)).toEqual([])
        const full = makeHost()
        yield* joinAll(full, Array.from({ length: PresenceProtocol.maxParticipants }, (_, i) => `p${i}`))
        const late = full.accept()
        late.raw.closeFault = fault
        expect(yield* PresenceRoom.join(full.host, late, person("late"))).toBe("full")
      })
  )

  it.effect("is not fooled by a socket carrying another kind of attachment", () =>
    Effect.gen(function*() {
      const room = makeHost()
      const other = room.accept()
      other.serializeAttachment({ id: "terminal-1", principal: "github:mallory" })
      const [ada] = yield* joinAll(room, ["ada"])
      expect(namesSeenBy(ada!)).toEqual(["ada"])
      expect(other.raw.sent).toEqual([])
      expect(yield* PresenceRoom.evict(room.host, "github:mallory")).toBe(0)
      expect(other.raw.closed).toBeUndefined()
    }))

  it.effect("counts open connections up on a join and down on every way out", () =>
    isolated(Effect.gen(function*() {
      const room = makeHost()
      const [ada, bob, cy, dee] = yield* joinAll(room, ["ada", "bob", "cy", "dee"])
      expect((yield* Metric.value(PresenceRoom.open)).count).toBe(4)
      yield* PresenceRoom.leave(room.host, ada!)
      yield* PresenceRoom.close(room.host, bob!, CloseCode.left)
      yield* PresenceRoom.receive(room.host, cy!, new Uint8Array([0]))
      expect((yield* Metric.value(PresenceRoom.open)).count).toBe(1)
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.frames, { outcome: "state" }))).count).toBe(0)
      yield* PresenceRoom.receive(room.host, dee!, stateFrame("x"))
      expect((yield* Metric.value(Metric.withAttributes(PresenceRoom.frames, { outcome: "state" }))).count).toBe(1)
    })))

  it.effect("type-checks over a Durable Object's sockets, whose host read needs a service", () =>
    Effect.gen(function*() {
      // Alchemy's Cloudflare.WebSocket: methods, an Effect<void> send, and a
      // generic attachment pair; `state.getWebSockets()` needs RuntimeContext.
      interface AlchemySocket {
        send(data: string | Uint8Array): Effect.Effect<void>
        close(code: number, reason: string): Effect.Effect<void>
        serializeAttachment<T>(value: T): void
        deserializeAttachment<T>(): T | null
      }
      class RuntimeContext extends Context.Service<RuntimeContext, object>()("RuntimeContext") {}
      const sockets: Array<AlchemySocket> = []
      const host = { sockets: Effect.as(RuntimeContext, sockets) }
      const program: Effect.Effect<number, never, RuntimeContext> = PresenceRoom.evict(host, "github:ada")
      expect(yield* program.pipe(Effect.provideService(RuntimeContext, {}))).toBe(0)
    }))
})
