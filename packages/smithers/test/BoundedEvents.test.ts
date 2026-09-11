import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as BoundedEvents from "../src/internal/BoundedEvents.ts"

const context = { operation: "test history", subject: "run test" }

const limits = (values: ReadonlyArray<unknown>, overrides: Partial<BoundedEvents.Limits> = {}): BoundedEvents.Limits => ({
  maxEvents: values.length,
  maxBytes: values.reduce<number>((total, value) => total + BoundedEvents.encodedBytes(value), 0),
  maxEventBytes: Math.max(...values.map(BoundedEvents.encodedBytes), 1),
  ...overrides
})

describe("bounded CLI histories", () => {
  it("accepts exactly the event and encoded-byte bounds", async () => {
    const values = [{ sequence: 1 }, { sequence: 2, payload: "é" }]

    expect(await Effect.runPromise(BoundedEvents.collect(Stream.fromIterable(values), context, limits(values))))
      .toEqual(values)
  })

  it("fails on the first event beyond the count bound", async () => {
    const values = [{ sequence: 1 }, { sequence: 2 }]
    const failure = await Effect.runPromise(
      Effect.flip(BoundedEvents.collect(Stream.fromIterable(values), context, limits(values, { maxEvents: 1 })))
    )

    expect(failure).toBeInstanceOf(CliError.ResourceLimitError)
    expect(failure).toMatchObject({ unit: "events", limit: 1 })
    expect(failure.message).toContain("test history")
  })

  it("distinguishes a total-byte excess from one oversized event", async () => {
    const values = [{ payload: "a" }, { payload: "b" }]
    const total = limits(values)
    const aggregate = await Effect.runPromise(
      Effect.flip(BoundedEvents.collect(
        Stream.fromIterable(values),
        context,
        { ...total, maxBytes: total.maxBytes - 1 }
      ))
    )
    const single = await Effect.runPromise(
      Effect.flip(BoundedEvents.collect(
        Stream.fromIterable(values.slice(0, 1)),
        context,
        { ...total, maxEventBytes: BoundedEvents.encodedBytes(values[0]) - 1 }
      ))
    )

    expect(aggregate).toMatchObject({ unit: "bytes", limit: total.maxBytes - 1 })
    expect(single).toMatchObject({ unit: "bytes", limit: BoundedEvents.encodedBytes(values[0]) - 1 })
  })

  it("retains one budget across incremental polls", async () => {
    const values = [{ sequence: 1 }, { sequence: 2 }]
    const buffer = BoundedEvents.empty<{ readonly sequence: number }>()
    const bounded = limits(values, { maxEvents: 1 })
    await Effect.runPromise(BoundedEvents.collectInto(Stream.make(values[0]!), buffer, context, bounded))
    const failure = await Effect.runPromise(
      Effect.flip(BoundedEvents.collectInto(Stream.make(values[1]!), buffer, context, bounded))
    )

    expect(buffer.values).toEqual([values[0]])
    expect(failure).toMatchObject({ unit: "events", limit: 1 })
  })
})
