import { Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/Events.ts"
import { run } from "./Harness.ts"

const options: Events.Options = { directory: "/d", project: "p", heartbeat: "30 millis", replay: 3 }

const parse = (frames: ReadonlyArray<string>) =>
  frames.flatMap((chunk) => chunk.split("\n\n").filter((line) => line.startsWith("data: ")))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Events.Envelope)

describe("Events", () => {
  it("envelopes session events with the directory and project and remembers a bounded replay", async () => {
    const result = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make(options)
        const first = yield* hub.publish({
          type: "session.status",
          properties: { sessionID: "s", status: { type: "busy" } }
        })
        for (const index of [1, 2, 3]) {
          yield* hub.publish({ type: "message.part.delta", properties: { delta: `${index}` } })
        }
        return {
          first,
          all: yield* hub.replay(),
          after: yield* hub.replay(first.payload.id),
          unknown: yield* hub.replay("evt_nope")
        }
      })
    )
    expect(result.first).toMatchObject({ directory: "/d", project: "p", payload: { type: "session.status" } })
    expect(result.first.payload.id.startsWith("evt_")).toBe(true)
    expect(result.all.map((envelope) => envelope.payload.properties["delta"])).toEqual(["1", "2", "3"])
    expect(result.after.length).toBe(3)
    expect(result.unknown.length).toBe(3)
  })

  it("streams server.connected, the replay after a known id, live events, and heartbeats", async () => {
    const result = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make(options)
        const anchor = yield* hub.publish({ type: "a", properties: {} })
        yield* hub.publish({ type: "b", properties: {} })
        const collected = yield* Effect.forkChild(
          hub.stream({ after: anchor.payload.id }).pipe(Stream.take(5), Stream.runCollect)
        )
        yield* Effect.sleep("5 millis")
        yield* hub.publish({ type: "c", properties: {} })
        return yield* Fiber.join(collected)
      })
    )
    const [connected, replayed, live, ...beats] = result
    expect(parse([connected!])[0]!.payload.type).toBe("server.connected")
    expect(parse([connected!])[0]!.directory).toBeUndefined()
    expect(parse([replayed!])[0]!.payload.type).toBe("b")
    expect(parse([live!])[0]!.payload.type).toBe("c")
    expect(beats.every((beat) => beat.startsWith(Events.heartbeatComment))).toBe(true)
    expect(parse(beats)[0]!.payload.type).toBe("server.heartbeat")
  })

  it("ends every open stream on close, and a stream opened afterwards ends at once", async () => {
    const result = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make(options)
        const open = yield* Effect.forkDetach(Stream.runCollect(hub.stream()))
        yield* Effect.sleep("20 millis")
        yield* hub.publish({ type: "session.idle", properties: { sessionID: "s" } })
        yield* hub.close
        const drained = yield* Fiber.join(open)
        const late = yield* Stream.runCollect(hub.stream())
        return {
          drained: parse(drained).map((envelope) => envelope.payload.type),
          late: parse(late).map((e) => e.payload.type)
        }
      })
    )
    expect(result.drained).toEqual(["server.connected", "session.idle"])
    // Opened after the close: the replay, then the end, never a live wait.
    expect(result.late).toEqual(["server.connected", "session.idle"])
  })

  it("bounds each live queue: a stalled consumer gets the newest events, never every one", async () => {
    const result = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make({ directory: "/d", project: "p", heartbeat: "1 hour", replay: 3 })
        const gate = yield* Deferred.make<void>()
        const seen: Array<Events.Envelope> = []
        // The consumer reads server.connected, then stalls on the first live
        // frame until the gate opens.
        const consumer = yield* Effect.forkChild(
          hub.stream().pipe(
            Stream.mapEffect((chunk) =>
              Effect.as(
                seen.length === 0 ? Effect.void : Deferred.await(gate),
                parse([chunk])[0]!
              )
            ),
            Stream.runForEach((envelope) => Effect.sync(() => void seen.push(envelope)))
          )
        )
        yield* Effect.sleep("10 millis")
        for (let index = 1; index <= 40; index++) {
          yield* hub.publish({ type: "message.part.delta", properties: { delta: `${index}` } })
        }
        yield* Effect.sleep("10 millis")
        yield* Deferred.succeed(gate, undefined)
        yield* Effect.sleep("10 millis")
        yield* hub.close
        yield* Fiber.join(consumer)
        return seen.filter((envelope) => envelope.payload.type === "message.part.delta")
          .map((envelope) => envelope.payload.properties["delta"])
      })
    )
    expect(result.length).toBeLessThan(40)
    expect(result.slice(-3)).toEqual(["38", "39", "40"])
  })

  it("frames an envelope as one SSE data line and drops a closed subscriber", async () => {
    expect(Events.frame({ payload: { id: "evt_1", type: "x", properties: {} } })).toBe(
      `data: {"payload":{"id":"evt_1","type":"x","properties":{}}}\n\n`
    )
    expect(Events.frame({ directory: "/d", project: "p", payload: { id: "evt_1", type: "x", properties: {} } }, true))
      .toBe(`data: {"id":"evt_1","type":"x","properties":{}}\n\n`)
    const bare = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make(options)
        yield* hub.publish({ type: "a", properties: { sessionID: "s" } })
        const collected = yield* Effect.forkChild(hub.stream({ bare: true }).pipe(Stream.take(4), Stream.runCollect))
        yield* Effect.sleep("5 millis")
        yield* hub.publish({ type: "b", properties: {} })
        return yield* Fiber.join(collected)
      })
    )
    const bareEvents = bare.flatMap((chunk) =>
      chunk.split("\n\n").filter((line) => line.startsWith("data: ")).map((line) =>
        JSON.parse(line.slice(6)) as Record<string, unknown>
      )
    )
    expect(bareEvents.map((event) => event["type"])).toEqual(["server.connected", "a", "b", "server.heartbeat"])
    expect(bareEvents.every((event) => !("payload" in event) && !("directory" in event))).toBe(true)
    const count = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make({ directory: "/d", project: "p" })
        const one = yield* hub.stream().pipe(Stream.take(1), Stream.runCollect)
        yield* hub.publish({ type: "after-close", properties: {} })
        return one.length
      })
    )
    expect(count).toBe(1)
    const built = await run(
      Effect.gen(function*() {
        const hub = yield* Events.Events
        return typeof hub.publish
      }).pipe(Effect.provide(Events.layer(options)))
    )
    expect(built).toBe("function")
  })
})
