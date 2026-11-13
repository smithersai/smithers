import { Control, type ControlSchema } from "@smthrs/control"
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as RunEventStream from "../src/cli/RunEventStream.ts"
import * as CliError from "../src/CliError.ts"
import * as BoundedEvents from "../src/internal/BoundedEvents.ts"

const event = (payload = ""): ControlSchema.ControlEvent => ({
  sequence: 1,
  kind: "control.test",
  occurredAt: 0,
  payload
})
const sized = (bytes: number) =>
  event(
    "é".repeat(Math.floor((bytes - BoundedEvents.encodedBytes(event())) / 2)) +
      "a".repeat((bytes - BoundedEvents.encodedBytes(event())) % 2)
  )

const read = (values: Iterable<ControlSchema.ControlEvent>, follow = false, live = false) => {
  let delivered = 0
  let closed = false
  const source = Stream.fromIterable(values).pipe(Stream.ensuring(Effect.sync(() => {
    closed = true
  })))
  const result = Effect.gen(function*() {
    const control = yield* Control.Control
    return yield* RunEventStream.events("run-limit", follow).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          delivered++
        })
      ),
      Stream.runDrain,
      Effect.provideService(
        Control.Control,
        Control.make({
          ...control,
          watch: (request) => request.follow ? live ? source : Stream.never : live ? Stream.empty : source,
          list: () =>
            Effect.succeed({
              _tag: "runs",
              items: [{
                runId: "run-limit",
                flowId: "test",
                status: live ? "running" : "completed",
                createdAt: 0,
                updatedAt: 0
              }]
            })
        })
      ),
      Effect.result
    )
  }).pipe(Effect.provide(Control.layerNoop))
  return Effect.runPromise(result).then((result) => ({ result, delivered, closed }))
}

describe("run log resource bounds", () => {
  it.each([false, true])("rejects an oversized event before delivery, follow=%s", async (follow) => {
    const observed = await read([sized(BoundedEvents.maximumEventBytes + 1)], follow)
    expect(observed.result).toMatchObject({
      _tag: "Failure",
      failure: expect.any(CliError.ResourceLimitError)
    })
    expect(observed.result).toMatchObject({
      failure: { operation: "logs", subject: "run-limit", limit: BoundedEvents.maximumEventBytes, unit: "bytes" }
    })
    expect(observed.delivered).toBe(0)
    expect(observed.closed).toBe(true)
  })

  it("rejects an oversized event from the live follow stream", async () => {
    const observed = await read([sized(BoundedEvents.maximumEventBytes + 1)], true, true)
    expect(observed.result).toMatchObject({
      _tag: "Failure",
      failure: { limit: BoundedEvents.maximumEventBytes, unit: "bytes" }
    })
    expect(observed.delivered).toBe(0)
    expect(observed.closed).toBe(true)
  })

  it.each([false, true])("accepts the exact UTF-8 event bound, follow=%s", async (follow) => {
    const value = sized(BoundedEvents.maximumEventBytes)
    expect(BoundedEvents.encodedBytes(value)).toBe(BoundedEvents.maximumEventBytes)
    const observed = await read([value], follow)
    expect(observed.result._tag).toBe("Success")
    expect(observed.delivered).toBe(1)
    expect(observed.closed).toBe(true)
  })

  it("rejects event 50,001 without delivering it", async () => {
    const value = event()
    const observed = await read(Array.from({ length: BoundedEvents.maximumEvents + 1 }, () => value))
    expect(observed.result).toMatchObject({
      _tag: "Failure",
      failure: { limit: BoundedEvents.maximumEvents, unit: "events" }
    })
    expect(observed.delivered).toBe(BoundedEvents.maximumEvents)
    expect(observed.closed).toBe(true)
  })

  it("accepts exactly 50,000 events", async () => {
    const observed = await read(Array.from({ length: BoundedEvents.maximumEvents }, () => event()))
    expect(observed.result._tag).toBe("Success")
    expect(observed.delivered).toBe(BoundedEvents.maximumEvents)
  })

  it("accepts exactly 16 MiB, then refuses the first additional byte", async () => {
    const values = Array.from({ length: 32 }, () => sized(BoundedEvents.maximumBytes / 32))
    const exact = await read(values)
    expect(exact.result._tag).toBe("Success")
    expect(exact.delivered).toBe(32)
    const overflow = await read([...values, event()])
    expect(overflow.result).toMatchObject({
      _tag: "Failure",
      failure: { limit: BoundedEvents.maximumBytes, unit: "bytes" }
    })
    expect(overflow.delivered).toBe(32)
    expect(overflow.closed).toBe(true)
  })

  it("follows beyond both finite history bounds without retaining prior events", async () => {
    const value = event()
    const values = [
      ...Array.from({ length: BoundedEvents.maximumEvents }, () => value),
      ...Array.from({ length: 32 }, () => sized(BoundedEvents.maximumBytes / 32))
    ]
    const observed = await read(values, true)
    expect(observed.result._tag).toBe("Success")
    expect(observed.delivered).toBe(values.length)
    expect(observed.closed).toBe(true)
  })
})
