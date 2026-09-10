import { PersistenceError } from "@smthrs/control/ControlError"
import { FireSummary, TriggerSummary } from "@smthrs/control/ControlSchema"
import * as Port from "@smthrs/control/DispatchReader"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as DispatchReader from "../src/DispatchReader.ts"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import * as TriggerStore from "../src/TriggerStore.ts"

const hour = 60 * 60 * 1_000

const hourly: Trigger = {
  id: "hourly",
  flowId: "review",
  input: { source: "schedule" },
  cron: "0 * * * *",
  timezone: "UTC",
  overlap: "buffer-one",
  catchUp: "one",
  maxCatchUp: 3,
  enabled: true
}

const daily: Trigger = {
  id: "daily",
  flowId: "lint",
  input: null,
  cron: "0 9 * * *",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: false
}

const run = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestTriggers.layer), Effect.provide(TestClock.layer())))

const triggers = { _tag: "triggers" as const }
const fires = { _tag: "fires" as const }

describe("DispatchReader", () => {
  it("summarizes a fresh trigger with five upcoming occurrences and no scheduler heartbeat", async () => {
    const summaries = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(hourly)
        yield* store.register(daily)
        const reader = yield* DispatchReader.make
        return yield* reader.list(triggers)
      })
    )
    expect(summaries.map((summary) => summary.triggerId)).toEqual(["daily", "hourly"])
    const first = summaries.find((summary) => summary.triggerId === "hourly")
    const second = summaries.find((summary) => summary.triggerId === "daily")
    expect(first).toEqual({
      triggerId: "hourly",
      flowId: "review",
      input: { source: "schedule" },
      cron: "0 * * * *",
      timezone: "UTC",
      overlap: "buffer-one",
      catchUp: "one",
      maxCatchUp: 3,
      enabled: true,
      revision: 1,
      nextOccurrencesMs: [hour, 2 * hour, 3 * hour, 4 * hour, 5 * hour]
    })
    expect(second).toMatchObject({ triggerId: "daily", enabled: false, nextOccurrencesMs: expect.any(Array) })
    expect(second).not.toHaveProperty("timezone")
    expect(second?.nextOccurrencesMs).toHaveLength(DispatchReader.nextOccurrenceCount)
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty("schedulerLastTickMs")
      expect(summary).not.toHaveProperty("activeRunId")
      expect(summary).not.toHaveProperty("lastFiredAtMs")
      expect(summary).not.toHaveProperty("pendingAtMs")
      expect(Schema.decodeUnknownSync(TriggerSummary)(summary)).toEqual(summary)
    }
  })

  it("lists occurrences strictly after the store clock, in increasing order", async () => {
    const next = await run(
      Effect.gen(function*() {
        yield* TestClock.adjust(hour + 1)
        return yield* DispatchReader.nextOccurrences(
          hourly,
          yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        )
      })
    )
    expect(next).toEqual([2 * hour, 3 * hour, 4 * hour, 5 * hour, 6 * hour])
    for (let index = 1; index < next.length; index++) {
      expect(next[index]).toBeGreaterThan(next[index - 1] as number)
    }
  })

  it("carries the heartbeat, the launched run, the cursor, and the buffered occurrence; hides a reservation", async () => {
    const result = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const reader = yield* DispatchReader.make
        const registered = yield* store.register(hourly)
        const claim = { triggerId: hourly.id, expectedRevision: registered.revision }
        yield* store.claimFire({ ...claim, occurrence: hour })
        const reserved = yield* reader.list(triggers)
        yield* store.recordResult({
          triggerId: hourly.id,
          occurrence: hour,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(hourly.id)).activeRunId!
        })
        yield* store.claimFire({ ...claim, occurrence: 2 * hour })
        yield* TestClock.adjust(2 * hour + 1)
        yield* store.heartbeat("box-1")
        const running = yield* reader.list(triggers)
        return { reserved, running }
      })
    )
    expect(result.reserved[0]).not.toHaveProperty("activeRunId")
    expect(result.reserved[0]).not.toHaveProperty("lastFiredAtMs")
    expect(result.running[0]).toMatchObject({
      activeRunId: "run-1",
      lastFiredAtMs: 2 * hour,
      pendingAtMs: 2 * hour,
      schedulerLastTickMs: 2 * hour + 1,
      nextOccurrencesMs: [3 * hour, 4 * hour, 5 * hour, 6 * hour, 7 * hour]
    })
  })

  it("answers the fire ledger newest first and pushes the request filters into the store", async () => {
    const result = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const reader = yield* DispatchReader.make
        const registered = yield* store.register(hourly)
        const claim = { triggerId: hourly.id, expectedRevision: registered.revision }
        yield* store.claimFire({ ...claim, occurrence: hour })
        yield* store.recordResult({
          triggerId: hourly.id,
          occurrence: hour,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(hourly.id)).activeRunId!
        })
        yield* store.claimFire({ ...claim, occurrence: 2 * hour })
        yield* store.recordResult({
          triggerId: hourly.id,
          occurrence: hour,
          outcome: "failed",
          runId: "run-1",
          error: "exit 1"
        })
        yield* store.claimFire({ ...claim, occurrence: 3 * hour })
        return {
          all: yield* reader.fires(fires),
          byRun: yield* reader.fires({ ...fires, filters: { runId: "run-1" } }),
          buffered: yield* reader.fires({ ...fires, filters: { triggerId: hourly.id, outcome: "buffered" } }),
          none: yield* reader.fires({ ...fires, filters: { triggerId: "absent" } })
        }
      })
    )
    expect(result.all).toEqual([
      { triggerId: "hourly", occurrenceAtMs: 3 * hour, outcome: null },
      { triggerId: "hourly", occurrenceAtMs: 2 * hour, outcome: "buffered" },
      { triggerId: "hourly", occurrenceAtMs: hour, outcome: "failed", runId: "run-1", error: "exit 1" }
    ])
    expect(result.byRun).toEqual([result.all[2]])
    expect(result.buffered).toEqual([result.all[1]])
    expect(result.none).toEqual([])
    for (const fire of result.all) {
      expect(Schema.decodeUnknownSync(FireSummary)(fire)).toEqual(fire)
    }
  })

  it("reports a store it cannot read as a persistence failure naming the listing", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function*() {
        const reader = yield* DispatchReader.make
        return yield* Effect.all([Effect.flip(reader.list(triggers)), Effect.flip(reader.fires(fires))])
      }).pipe(Effect.provide(TriggerStore.layerNoop()))
    )
    expect(errors[0]).toBeInstanceOf(PersistenceError)
    expect(errors[0]).toMatchObject({ operation: "triggers", message: "lastHeartbeat is unavailable" })
    expect(errors[1]).toMatchObject({ operation: "fires", message: "history is unavailable" })
  })

  it("provides the control plane's port as a layer over the store", async () => {
    const summaries = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(daily)
        const reader = yield* Port.DispatchReader
        return yield* reader.list(triggers)
      }).pipe(Effect.provide(DispatchReader.layer))
    )
    expect(summaries.map((summary) => summary.triggerId)).toEqual(["daily"])
  })
})
