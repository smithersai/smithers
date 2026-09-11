import type { Entry } from "@smthrs/journal/JournalEvent"
import { describe, expect, it } from "vitest"
import * as Projection from "../src/history/Projection.ts"

const entry = (seq: number, eventType = "example.output", payload: unknown = { value: seq }): Entry =>
  ({ runId: "run-1", seq, eventType, payload, meta: { lineageId: "fixture/root" } }) as unknown as Entry

describe("history replay projection", () => {
  it("reports events, sealed results, counts and the last decided state in sequence order", () => {
    const projection = Projection.make(true)
    const entries = [
      entry(1, "flows.engine.run-decision", { state: { step: 1 } }),
      entry(2),
      entry(3),
      entry(4, "flows.engine.run-decision", { state: { step: 2 } })
    ]
    const state = entries.reduce(
      (current, next) => projection.reduce(current, next, next.seq % 2 === 0 ? `sealed-${next.seq}` : undefined),
      projection.initial
    )

    expect(projection.finish(state)).toEqual({
      entryCount: 4,
      eventTypes: { "flows.engine.run-decision": 2, "example.output": 2 },
      state: { step: 2 },
      events: entries,
      sealed: [{ seq: 2, result: "sealed-2" }, { seq: 4, result: "sealed-4" }]
    })
    const withoutEvents = Projection.make(false)
    const counted = entries.reduce(
      (current, next) => withoutEvents.reduce(current, next, undefined),
      withoutEvents.initial
    )
    expect(withoutEvents.finish(counted)).toMatchObject({ entryCount: 4, events: [] })
  })

  it("keeps every intermediate state valid after the fold continues from it", () => {
    const projection = Projection.make(true)
    const prefix = projection.reduce(projection.initial, entry(1), "one")
    const left = projection.reduce(prefix, entry(2), "left")
    const right = projection.reduce(prefix, entry(3), "right")

    expect(projection.finish(prefix).sealed).toEqual([{ seq: 1, result: "one" }])
    expect(projection.finish(left).events.map((event) => event.seq)).toEqual([1, 2])
    expect(projection.finish(right).sealed).toEqual([{ seq: 1, result: "one" }, { seq: 3, result: "right" }])
    expect(projection.finish(projection.initial)).toEqual({ entryCount: 0, eventTypes: {}, events: [], sealed: [] })
  })

  it("replays a long sealed history in time linear in its length", () => {
    // Copying the accumulated prefix on every entry is about ten billion
    // element copies here; sharing the prefix finishes in milliseconds.
    const count = 100_000
    const projection = Projection.make(true)
    const started = performance.now()
    let state = projection.initial
    for (let seq = 1; seq <= count; seq++) state = projection.reduce(state, entry(seq), seq)
    const summary = projection.finish(state)
    const elapsed = performance.now() - started

    expect(summary.entryCount).toBe(count)
    expect(summary.events.map((event) => event.seq)).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    expect(summary.sealed.at(-1)).toEqual({ seq: count, result: count })
    expect(elapsed).toBeLessThan(2_000)
  })
})
