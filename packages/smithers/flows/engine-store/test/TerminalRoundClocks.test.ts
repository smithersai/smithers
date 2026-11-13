import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Exit, Option, Schema } from "effect"
import * as DeferredClockFold from "../src/DeferredClockFold.ts"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "round-clocks", pid: 1, nonce: "round-clocks-owner" }

describe("terminal rounds close their clocks", () => {
  it.effect("activation consumes a clock wake and an event wake once but retains both results", () =>
    Effect.gen(function*() {
      const runId = "round-clock-consumption"
      const flow = Flow.make("RoundClocks/consumption", {
        payload: {},
        success: Schema.String,
        body: opaqueHandlerBody
      })
      const state = yield* DurableEngineState.DurableEngineState
      const driver = yield* RunDriver.make({
        owner,
        journalSource: "clock-consumption",
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
      })
      let first = true
      const address = { flowName: flow._tag, executionId: runId, deferredName: "DurableClock/fallback" }
      const event = { ...address, deferredName: "WaitFor/external" }
      yield* driver.register(flow, () =>
        Effect.gen(function*() {
          if (first) {
            first = false
            const instance = yield* FlowRuntime.FlowInstance
            instance.waiting = { reason: "event" }
            return yield* Flow.suspend(instance)
          }
          const pending = yield* state.completedDeferreds(flow._tag, runId)
          expect(pending.map((wake) => wake.deferredName)).toEqual([])
          expect(Option.getOrThrow(yield* state.deferred(address)).exit).toEqual(Exit.succeed("clock"))
          expect(Option.getOrThrow(yield* state.deferred(event)).exit).toEqual(Exit.succeed("event"))
          return "done"
        }))
      yield* driver.execute(flow, { executionId: runId, payload: {}, discard: false })
      const persistence = yield* DeferredPersistence.make({
        owner,
        journalSource: "clock-consumption",
        scheduleResume: () => Effect.void
      })
      yield* persistence.deferredDone({ ...address, exit: Exit.succeed("clock") })
      yield* persistence.deferredDone({ ...event, exit: Exit.succeed("event") })
      yield* driver.resume(flow, runId, { poll: true })
      yield* driver.execute(flow, { executionId: runId, payload: {}, discard: false, follow: true })
      const completed = yield* (yield* RunStore.RunStore).get(runId)
      expect(completed.status, completed.stateJson).toBe("completed")
      expect(yield* state.hasDueWake(runId, Number.MAX_SAFE_INTEGER)).toBe(false)
      const rebuilt = yield* DeferredClockFold.rebuild()
      expect(rebuilt.deferreds).toBe(2)
      expect(yield* state.completedDeferreds(flow._tag, runId)).toEqual([])
      expect(yield* state.hasDueWake(runId, Number.MAX_SAFE_INTEGER)).toBe(false)
      expect(Option.getOrThrow(yield* state.deferred(address)).exit).toEqual(Exit.succeed("clock"))
    }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))

  for (const ending of ["handoff", "exhausted", "invalid"] as const) {
    it.effect(`closes pending clocks when a round is ${ending}`, () =>
      Effect.gen(function*() {
        const runId = `round-clocks-${ending}`
        const flow = Flow.make(`RoundClocks/${ending}`, {
          payload: {},
          success: Schema.String,
          ...(ending === "exhausted" ? { maxRounds: 1 } : {}),
          body: opaqueHandlerBody
        })
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const observedStore = ending === "invalid" ?
          RunStore.makeNoop({
            ...store,
            get: (id) => store.get(id).pipe(Effect.map((row) => id === runId ? { ...row, roundOrdinal: -1 } : row))
          }) :
          store
        const driver = yield* RunDriver.make({
          owner,
          journalSource: "round-clocks",
          isAlive: () => Effect.succeed(true),
          engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
        }).pipe(Effect.provideService(RunStore.RunStore, observedStore))
        const address = { flowName: flow._tag, executionId: runId, clockName: "pending" }
        yield* driver.register(flow, () =>
          Effect.gen(function*() {
            yield* state.scheduleClock({
              ...address,
              deferredName: "pending-result",
              dueAtMs: (yield* Clock.currentTimeMillis) + 60_000,
              completedAtMs: null
            }, owner)
            const instance = yield* FlowRuntime.FlowInstance
            instance.handoff = new Flow.Handoff({ flow: "RoundClocks/next", payload: {} })
            return "handoff"
          }))
        yield* driver.execute(flow, { executionId: runId, payload: {}, discard: false })
        expect((yield* store.get(runId)).status).toBe(ending === "handoff" ? "completed" : "failed")
        expect(Option.getOrThrow(yield* state.clock(address)).completedAtMs).not.toBeNull()
        expect(yield* state.dueClocks((yield* Clock.currentTimeMillis) + 120_000)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(TestStores.layerAt(":memory:")), withCrypto))
  }
})
