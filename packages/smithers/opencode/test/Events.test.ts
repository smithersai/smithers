import { Deferred, Effect, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/Events.ts"
import { run } from "./Harness.ts"

const options: Events.Options = { directory: "/d", project: "p", heartbeat: "30 millis", replay: 3 }

const dataLines = (frames: ReadonlyArray<string>) =>
  frames.flatMap((chunk) => chunk.split("\n")).filter((line) => line.startsWith("data: "))

const parse = (frames: ReadonlyArray<string>) =>
  dataLines(frames).map((line) => JSON.parse(line.slice("data: ".length)) as Events.Envelope)

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
        // The live subscriber registers only once the replay chunk has been
        // written, and the heartbeat clock starts at that same moment, so a
        // beat is the first observable proof that the stream is listening.
        const beating = yield* Deferred.make<void>()
        const collected = yield* Effect.forkChild(
          hub.stream({ after: anchor.payload.id }).pipe(
            Stream.tap((chunk) =>
              chunk.startsWith(Events.heartbeatComment) ? Deferred.succeed(beating, undefined) : Effect.void
            ),
            Stream.takeUntil((chunk) => chunk.includes(`"type":"c"`)),
            Stream.runCollect
          )
        )
        yield* Deferred.await(beating)
        yield* hub.publish({ type: "c", properties: {} })
        return yield* Fiber.join(collected)
      })
    )
    const [connected, replayed, ...rest] = result
    const live = rest.at(-1)
    const beats = rest.slice(0, -1)
    expect(parse([connected!])[0]!.payload.type).toBe("server.connected")
    expect(parse([connected!])[0]!.directory).toBeUndefined()
    expect(parse([replayed!])[0]!.payload.type).toBe("b")
    expect(parse([live!])[0]!.payload.type).toBe("c")
    expect(beats.length).toBeGreaterThan(0)
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
    // Opened after the close: the greeting, then the end, never a live wait.
    // Nothing is replayed, because the stream named no id.
    expect(result.late).toEqual(["server.connected"])
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

  it("replays nothing to a stream that named no id, and the gap after one it did", async () => {
    const result = await run(
      Effect.gen(function*() {
        const hub = yield* Events.make({ directory: "/d", project: "p", heartbeat: "1 hour", replay: 8 })
        const asked = yield* hub.publish({
          type: "permission.asked",
          properties: { id: "per_1", sessionID: "s" }
        })
        yield* hub.publish({ type: "permission.replied", properties: { requestID: "per_1", sessionID: "s" } })
        yield* hub.close
        const fresh = yield* Stream.runCollect(hub.stream())
        const resumed = yield* Stream.runCollect(hub.stream({ after: asked.payload.id }))
        return {
          fresh: parse(fresh).map((envelope) => envelope.payload.type),
          resumed: parse(resumed).map((envelope) => envelope.payload.type),
          asked: parse(yield* Stream.runCollect(hub.stream({ after: "evt_gone" })))
            .map((envelope) => envelope.payload.type),
          // What is open right now reaches a stream that was not there when
          // it was asked for, and is stamped with an id of its own.
          opening: parse(
            yield* Stream.runCollect(
              hub.stream({
                opening: Effect.succeed([{
                  type: "permission.asked",
                  properties: { id: "per_open", sessionID: "s" }
                }])
              })
            )
          )
        }
      })
    )
    // A fresh tab is not shown a permission card that was answered already.
    expect(result.fresh).toEqual(["server.connected"])
    expect(result.resumed).toEqual(["server.connected", "permission.replied"])
    // A stream that did ask for a replay still gets one, even for an id the
    // buffer no longer reaches: it asked to be told what it missed.
    expect(result.asked).toEqual(["server.connected", "permission.asked", "permission.replied"])
    expect(result.opening.map((envelope) => envelope.payload.type)).toEqual([
      "server.connected",
      "permission.asked"
    ])
    expect(result.opening[1]).toMatchObject({
      directory: "/d",
      project: "p",
      payload: { type: "permission.asked", properties: { id: "per_open" } }
    })
    expect(result.opening[1]!.payload.id.startsWith("evt_")).toBe(true)
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
        const anchor = yield* hub.publish({ type: "anchor", properties: { sessionID: "s" } })
        yield* hub.publish({ type: "a", properties: { sessionID: "s" } })
        // As above: wait for a beat rather than a wall clock, so the live "b"
        // is published into a stream that is already listening.
        const beating = yield* Deferred.make<void>()
        const collected = yield* Effect.forkChild(
          hub.stream({ bare: true, after: anchor.payload.id }).pipe(
            Stream.tap((chunk) =>
              chunk.startsWith(Events.heartbeatComment) ? Deferred.succeed(beating, undefined) : Effect.void
            ),
            Stream.takeUntil((chunk) => chunk.includes(`"type":"b"`)),
            Stream.runCollect
          )
        )
        yield* Deferred.await(beating)
        yield* hub.publish({ type: "b", properties: {} })
        return yield* Fiber.join(collected)
      })
    )
    const bareEvents = dataLines(bare).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    const bareTypes = bareEvents.map((event) => event["type"])
    expect(bareTypes[0]).toBe("server.connected")
    expect(bareTypes[1]).toBe("a")
    expect(bareTypes.at(-1)).toBe("b")
    expect(bareTypes.slice(2, -1)).toContain("server.heartbeat")
    expect(bareTypes.slice(2, -1).every((type) => type === "server.heartbeat")).toBe(true)
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
