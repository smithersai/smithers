import * as Effect from "effect/Effect"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as TestTriggers from "../src/test/TestTriggers.ts"
import type { Trigger } from "../src/Trigger.ts"
import * as TriggerStore from "../src/TriggerStore.ts"
import { storeConformance } from "./StoreConformance.ts"

const trigger: Trigger = {
  id: "daily",
  flowId: "flow",
  input: {},
  cron: "0 0 * * *",
  overlap: "skip",
  catchUp: "none",
  maxCatchUp: 0,
  enabled: true
}

const run = <A, E>(effect: Effect.Effect<A, E, TriggerStore.TriggerStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestTriggers.layer)))

storeConformance("TestTriggers", TestTriggers.layer)

describe("TestTriggers", () => {
  it("keeps one record per active trigger instead of parallel maps", () => {
    // The run id, its occurrence and the lease timestamp used to live in three
    // maps every claim, expiry, launch and clear path had to update together.
    const source = readFileSync(new URL("../src/test/TestTriggers.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/activeOccurrences|activeClaimedAt\b(?!:)/)
    expect(source.match(/readonly active: ReadonlyMap<string, Active>/g)).toHaveLength(1)
  })

  it("lists every trigger and keeps the fire cursor across a re-registration", async () => {
    const state = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.register({ ...trigger, id: "other" })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 5, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 5,
          outcome: "launched",
          runId: "run-5",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        const replaced = yield* store.register({ ...trigger, flowId: "next" })
        return { all: yield* store.list(), enabled: yield* store.listEnabled(), replaced }
      })
    )
    expect(state.all.map((row) => row.triggerId).sort()).toEqual(["daily", "other"])
    expect(state.enabled).toHaveLength(2)
    expect(state.replaced).toMatchObject({ revision: 2, flowId: "next", lastFiredAt: 5 })
  })

  it("keeps the cursor monotonic when an older occurrence settles", async () => {
    const cursor = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 10, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 10,
          outcome: "launched",
          runId: "run-10",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 20, expectedRevision: registered.revision })
        yield* store.recordResult({ triggerId: trigger.id, occurrence: 10, outcome: "completed" })
        return yield* store.get(trigger.id)
      })
    )
    expect(cursor._tag === "Some" ? cursor.value.lastFiredAt : undefined).toBe(20)
  })

  it("clears an active run only for the run id that still holds it", async () => {
    const state = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        const registered = yield* store.register(trigger)
        yield* store.claimFire({ triggerId: trigger.id, occurrence: 1, expectedRevision: registered.revision })
        yield* store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "launched",
          runId: "run-1",
          reservationId: (yield* store.inspect(trigger.id)).activeRunId!
        })
        yield* store.clearActive(trigger.id, "run-2")
        const stale = yield* store.activeRun(trigger.id)
        yield* store.clearActive(trigger.id, "run-1")
        const cleared = yield* store.activeRun(trigger.id)
        const refused = yield* Effect.flip(store.recordResult({
          triggerId: trigger.id,
          occurrence: 1,
          outcome: "completed",
          runId: "run-9"
        }))
        expect(refused.code).toBe("stale_owner")
        return { stale, cleared, missing: yield* store.get("absent") }
      })
    )
    expect(state.stale).toMatchObject({ _tag: "Some", value: "run-1" })
    expect(state.cleared).toMatchObject({ _tag: "None" })
    expect(state.missing).toMatchObject({ _tag: "None" })
  })

  it("coalesces buffered occurrences forward into the one slot", async () => {
    const pending = await run(
      Effect.gen(function*() {
        const store = yield* TriggerStore.TriggerStore
        yield* store.register(trigger)
        yield* store.setPending({ triggerId: trigger.id, occurrence: 20 })
        yield* store.setPending({ triggerId: trigger.id, occurrence: 10 })
        return { buffered: (yield* store.inspect(trigger.id)).pendingAt }
      })
    )
    expect(pending.buffered).toBe(20)
  })
})
