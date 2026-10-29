import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { RunStore } from "@smthrs/run-store"
import { Clock, Effect, Option, Schema } from "effect"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const owner = { hostId: "round-clocks", pid: 1, nonce: "round-clocks-owner" }

describe("terminal rounds close their clocks", () => {
  it.effect("activation consumes a clock wake once but retains its result and other event wakes", () =>
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
          expect(pending.map((wake) => wake.deferredName)).toEqual([event.deferredName])
          expect(Option.getOrThrow(yield* state.deferred(address)).exit).toEqual({ _tag: "Success", value: "clock" })
          return "done"
        }))
      yield* driver.execute(flow, { executionId: runId, payload: {}, discard: false })
      const completedAtMs = yield* Clock.currentTimeMillis
      yield* state.completeDeferred({ ...address, exit: { _tag: "Success", value: "clock" }, completedAtMs })
      yield* state.completeDeferred({ ...event, exit: { _tag: "Success", value: "event" }, completedAtMs })
      yield* driver.resume(flow, runId)
      yield* driver.execute(flow, { executionId: runId, payload: {}, discard: false, follow: true })
      expect((yield* (yield* RunStore.RunStore).get(runId)).status).toBe("completed")
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
