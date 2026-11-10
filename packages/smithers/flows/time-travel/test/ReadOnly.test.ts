import { Journal } from "@smthrs/journal"
import type { Entry } from "@smthrs/journal/JournalEvent"
import { CacheStore } from "@smthrs/step-cache"
import { Effect, Layer, Option } from "effect"
import { describe, expect, it } from "vitest"
import { ReadOnlyTimeTravel, TimeTravel } from "../src/TimeTravel.vibe"

const record = {
  runId: "run",
  seq: 1,
  eventId: "event",
  sourceId: "test",
  sourceSeq: 1,
  emittedAtMs: 0,
  eventType: "test",
  payload: { number: 2 },
  meta: { lineageId: "lineage" }
} as Entry
const reader = TimeTravel.readOnly.pipe(Layer.provide([
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({ entries: () => Effect.succeed({ entries: [record], hasMore: false }) })
  ),
  CacheStore.layerNoop({ get: () => Effect.succeed(Option.none()) })
]))

describe("read-only time travel", () => {
  it("reads without a TimeTravelStore, RunStore, jj, or recovery service", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* ReadOnlyTimeTravel
        return yield* service.inspect({ runId: "run", frame: { lineageId: "lineage", seq: 1 } }, {
          initial: 0,
          reduce: (value, entry) => value + (entry.payload as { number: number }).number
        })
      }).pipe(Effect.provide(reader))
    )
    expect(result).toBe(2)
  })

  it("refuses malformed read options before reading journal evidence", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* ReadOnlyTimeTravel
        return yield* Effect.flip(service.replay({ runId: "run", frame: { lineageId: "lineage", seq: 1 } }, {
          initial: 0,
          reduce: (value) => value
        }, { pageSize: 0 }))
      }).pipe(Effect.provide(reader))
    )
    expect(result.code).toBe("invalid")
  })
})
