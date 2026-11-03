import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Flow, type FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Metric from "effect/Metric"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WakeBus from "../src/WakeBus.ts"
import { executeAndDrain } from "./ExecuteAndDrain.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

// Guards in the run driver that the rest of the suite reaches without
// pinning: each test fails when its guard is dropped.

const GuardFlow = Flow.make("RunDriverGuards/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const owner: Ownership.OwnerId = { hostId: "guard-host", pid: 7, nonce: "guard" }

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const stateJson = (extra: Readonly<Record<string, unknown>> = {}) =>
  JSON.stringify({ version: 1, flowName: GuardFlow._tag, payload: {}, capabilityCeilings: [], ...extra })

const makeDriver = (options: Partial<RunDriver.Dependencies> = {}) =>
  RunDriver.make({
    owner,
    journalSource: "run-driver-guards",
    isAlive: () => Effect.succeed(false),
    engine: Effect.succeed(fakeEngine),
    ...options
  })

const provideStores = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory)
  )

const provideSqlStores = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore | DurableEngineState.DurableEngineState>
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.provideMerge(DurableEngineState.layer, TestStores.layerAt(":memory:")))
  )

/** The total of every series of a counter or histogram `id`. */
const total = (snapshot: ReadonlyArray<Metric.Metric.Snapshot>, id: string): number =>
  snapshot
    .filter((entry) => entry.id === id)
    .reduce((sum, entry) => sum + (entry.state as { readonly count: number }).count, 0)

const decisionsFor = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* JournalRecords.entries(runId, undefined, 100)
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => (entry.payload as { decision: string }).decision)
  })

const origin = { door: "flow", actor: "unknown", admittedAtMs: 0 }

describe("RunDriver guards", () => {
  it.effect("asks the liveness check nothing about a claim still inside its lease", () =>
    Effect.gen(function*() {
      const asked: Array<Ownership.OwnerId> = []
      const crashed = { hostId: owner.hostId, pid: 404, nonce: "crashed" }
      const row = yield* withCrypto(provideStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        // A probe that would give up any claimant it is asked about.
        const driver = yield* makeDriver({
          isAlive: (claimant) =>
            Effect.sync(() => {
              asked.push(claimant)
              return false
            })
        })
        yield* store.create("unasked-claim", stateJson())
        yield* store.claim(
          "unasked-claim",
          { status: "pending", owner: null, heartbeatAtMs: null },
          crashed,
          yield* Clock.currentTimeMillis
        )
        yield* TestClock.adjust(29_000)
        yield* driver.register(GuardFlow, () => Effect.succeed("driven"))
        yield* driver.resume(GuardFlow, "unasked-claim")
        return yield* store.get("unasked-claim")
      })))
      expect(asked).toEqual([])
      expect(row.claim).toEqual(crashed)
    }))

  it.effect("schedules no pending admission whose registration changed while it was admitted", () =>
    Effect.gen(function*() {
      const calls = { first: 0, second: 0 }
      // The pending sweep reads admissions from the SQL engine state.
      const statuses = yield* withCrypto(provideSqlStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const first = yield* Scope.make()
        const second = yield* Scope.make()
        yield* Effect.addFinalizer(() =>
          Scope.close(first, Exit.void).pipe(Effect.andThen(Scope.close(second, Exit.void)))
        )
        let replace = true
        const driver: RunDriver.Service = yield* makeDriver({
          // The flow's registration changes hands while the sweep asks.
          canExecute: () => {
            if (!replace) return Effect.succeed(true)
            replace = false
            return Scope.close(first, Exit.void).pipe(
              Effect.andThen(
                driver.register(GuardFlow, () =>
                  Effect.sync(() => {
                    calls.second++
                    return "second"
                  })).pipe(Scope.provide(second))
              ),
              Effect.as(true)
            )
          }
        })
        yield* store.create("replaced", stateJson())
        yield* driver.register(GuardFlow, () =>
          Effect.sync(() => {
            calls.first++
            return "first"
          })).pipe(Scope.provide(first))
        // Old enough for the pending sweep, then one sweep tick at a time.
        yield* TestClock.adjust(Ownership.heartbeatStaleAfter)
        const tick = Effect.gen(function*() {
          yield* TestClock.adjust(Ownership.heartbeatInterval)
          for (let turn = 0; turn < 1_000; turn++) yield* Effect.yieldNow
        })
        yield* tick
        const afterSwap = (yield* store.get("replaced")).status
        const callsAfterSwap = { ...calls }
        yield* tick
        return { afterSwap, callsAfterSwap, settled: (yield* store.get("replaced")).status }
      })))
      // The tick that changed the registration drives nothing; the next one
      // asks again under the registration now serving the flow.
      expect(statuses.afterSwap).toBe("pending")
      expect(statuses.callsAfterSwap).toEqual({ first: 0, second: 0 })
      expect(statuses.settled).toBe("completed")
      expect(calls).toEqual({ first: 0, second: 1 })
    }))

  it.effect("counts a run started only when it opens a lineage", () =>
    Effect.gen(function*() {
      const snapshot = yield* withCrypto(provideStores(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(GuardFlow, () => Effect.succeed("driven"))
        yield* driver.execute(GuardFlow, { executionId: "opens-lineage", payload: {}, discard: true })
        yield* driver.execute(GuardFlow, {
          executionId: "joins-lineage",
          payload: {},
          discard: true,
          round: { ...FlowEngine.Round.initial("opens-lineage"), ordinal: 1 }
        })
        return yield* Metric.snapshot
      }))).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
      expect(total(snapshot, "flows_runs_started")).toBe(1)
    }))

  it.effect("measures the delay to a first step only for a lineage's first round", () =>
    Effect.gen(function*() {
      const snapshot = yield* withCrypto(provideStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* driver.register(GuardFlow, () => Effect.succeed("driven"))
        yield* store.create("first-round", stateJson({ origin }), { lineageId: "first-round", roundOrdinal: 0 })
        yield* store.create("later-round", stateJson({ origin }), { lineageId: "first-round", roundOrdinal: 1 })
        yield* driver.resume(GuardFlow, "first-round")
        yield* driver.resume(GuardFlow, "later-round")
        expect((yield* store.get("later-round")).status).toBe("completed")
        return yield* Metric.snapshot
      }))).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
      expect(total(snapshot, "flows_run_first_step_ms")).toBe(1)
    }))

  it.effect("consumes only the parent wakes at activation and leaves the run's own completions to its body", () =>
    Effect.gen(function*() {
      const seen = yield* withCrypto(provideStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()
        yield* store.create("own-signal", stateJson())
        for (const deferredName of ["signal", "@smthrs/engine/parent-settled/child"]) {
          yield* state.completeDeferred({
            flowName: GuardFlow._tag,
            executionId: "own-signal",
            deferredName,
            exit: { _tag: "Success", value: null },
            completedAtMs: 0
          })
        }
        let listed: ReadonlyArray<string> = []
        yield* driver.register(
          GuardFlow,
          () =>
            Effect.map(state.completedDeferreds(GuardFlow._tag, "own-signal"), (rows) => {
              listed = rows.map((row) => row.deferredName)
              return "driven"
            })
        )
        yield* driver.resume(GuardFlow, "own-signal")
        return listed
      })))
      expect(seen).toEqual(["signal"])
    }))

  it.effect("records a parent edge once however often its child is admitted under it", () =>
    Effect.gen(function*() {
      const decisions = yield* withCrypto(provideStores(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* driver.register(GuardFlow, () => Effect.succeed("driven"))
        yield* store.create("edge-parent", stateJson())
        const parent = FlowEngine.makeInstance(GuardFlow, "edge-parent")
        for (let admission = 0; admission < 2; admission++) {
          yield* driver.execute(GuardFlow, { executionId: "edge-child", payload: {}, discard: true, parent })
        }
        return yield* decisionsFor("edge-child")
      })))
      expect(decisions.filter((decision) => decision === "parent-recorded")).toHaveLength(1)
    }))

  it.effect("announces nothing for a cancellation whose transition lost its fence", () =>
    Effect.gen(function*() {
      const wakes: Array<string> = []
      const row = yield* withCrypto(provideStores(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const fenceLost = RunStore.makeNoop({
          ...base,
          transitionOwned: (runId, claimant, status, state, guard) =>
            status === "cancelled"
              ? base.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, state, guard)
              : base.transitionOwned(runId, claimant, status, state, guard)
        })
        const driver = yield* makeDriver({
          wakeBus: WakeBus.makeNoop({ wake: (runId) => Effect.sync(() => void wakes.push(runId)) })
        }).pipe(Effect.provideService(RunStore.RunStore, fenceLost))
        const running = yield* Deferred.make<void>()
        yield* driver.register(GuardFlow, () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never)))
        const fiber = yield* executeAndDrain(driver, GuardFlow, {
          executionId: "lost-cancel",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(running)
        yield* driver.interrupt(GuardFlow, "lost-cancel")
        yield* Fiber.await(fiber)
        return yield* base.get("lost-cancel")
      })))
      expect(row.status).toBe("running")
      expect(wakes).not.toContain("lost-cancel")
    }))
})
