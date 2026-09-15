import { describe, expect, it } from "@effect/vitest"
import { DurableClock, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("StateLockOrder/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const owner: Ownership.OwnerId = { hostId: "lock-order", pid: 1, nonce: "owner" }
const engine = Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
const executionId = "lock-order-run"
const deferredName = "lock-order-deferred"

/**
 * Which side of the race a fiber is, so the barriers below can hold each one
 * at the exact point its own lock order becomes observable.
 */
const Role = Context.Reference<"driver" | "persist" | "bystander">(
  "@smthrs/engine-store/test/StateLockOrder/Role",
  { defaultValue: () => "bystander" as const }
)

/**
 * Wraps the real engine state with two barriers and nothing else.
 *
 * The persistence fiber stops at the boundary where it is about to take the
 * engine state's gate, whichever lock it already holds there; the driver
 * fiber announces that it HOLDS the state gate from inside its own state
 * transaction. Releasing the persistence fiber only then is what makes the
 * interleaving deterministic rather than load dependent: with the journal
 * transaction taken first by persistence, the two fibers hold one lock each
 * and want the other.
 */
const withBarriers = (
  real: DurableEngineState.Service,
  atBoundary: Deferred.Deferred<void>,
  driverHoldsState: Deferred.Deferred<void>
): DurableEngineState.Service => {
  const pausePersistence = Deferred.succeed(atBoundary, undefined).pipe(
    Effect.andThen(Deferred.await(driverHoldsState))
  )
  return {
    ...real,
    transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: { readonly onCommit: (commit: Effect.Effect<void>) => void }
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(Role, (role) =>
        role === "persist"
          ? Effect.andThen(pausePersistence, real.transaction(effect, options))
          : role === "driver"
          ? real.transaction(
            Effect.andThen(Deferred.succeed(driverHoldsState, undefined), effect),
            options
          )
          : real.transaction(effect, options)),
    scheduleClock: (row, scheduleOwner) =>
      Effect.flatMap(Role, (role) =>
        role === "persist"
          ? Effect.andThen(pausePersistence, real.scheduleClock(row, scheduleOwner))
          : real.scheduleClock(row, scheduleOwner))
  }
}

/**
 * The lock order is only observable on the memory engine state: the SQL
 * implementation's transaction IS a writer transaction, so it and the journal
 * take the one writer lock and an inversion cannot exist. The memory
 * implementation has a gate of its own, which the package contract requires to
 * be semantically equal to the SQL one, so every engine-store fiber must take
 * that gate BEFORE the journal's write transaction and never the other way
 * around.
 */
describe("engine state and journal lock order (memory)", () => {
  for (const persistence of ["deferred completion", "clock schedule"] as const) {
    it.live(`settles a cancellation racing a ${persistence}`, () =>
      withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const journal = yield* Journal.Journal
          const atBoundary = yield* Deferred.make<void>()
          const driverHoldsState = yield* Deferred.make<void>()
          const real = DurableEngineState.makeMemory()
          const state = withBarriers(real, atBoundary, driverHoldsState)
          const resumes: Array<string> = []
          const driver = yield* RunDriver.make({ owner, journalSource: "lock-order", engine }).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, state)
          )
          const persisted = yield* DeferredPersistence.make({
            owner,
            journalSource: "lock-order",
            scheduleResume: (_flowName, runId, reason) =>
              Effect.sync(() => {
                resumes.push(`${runId}:${reason}`)
              })
          }).pipe(
            Effect.provideService(DurableEngineState.DurableEngineState, state),
            Effect.provideService(Journal.Journal, journal)
          )
          yield* store.create(executionId, JSON.stringify({ version: 1, flowName: flow._tag, payload: {} }))
          // Far beyond the case, so the armed timer never fires into the race.
          const clock = DurableClock.make({ name: "lock-order-clock", duration: "1 hour" })
          const work = persistence === "deferred completion"
            ? persisted.deferredDone({
              flowName: flow._tag,
              executionId,
              deferredName,
              exit: Exit.void
            })
            : persisted.scheduleClock(flow, { executionId, clock })
          const persistFiber = yield* work.pipe(
            Effect.provideService(Role, "persist"),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Deferred.await(atBoundary)
          const driverFiber = yield* driver.interrupt(flow, executionId).pipe(
            Effect.provideService(Role, "driver"),
            Effect.forkChild({ startImmediately: true })
          )
          // A wall-clock bound, not a synchronization device: the barriers above
          // already fixed the interleaving, and both fibers are pure storage
          // work that finishes in milliseconds. A lock-order inversion parks
          // them forever, so the bound is how the case REPORTS a deadlock
          // instead of hanging the suite until the runner's timeout.
          const settled = yield* Effect.all([
            Fiber.await(persistFiber),
            Fiber.await(driverFiber)
          ]).pipe(Effect.timeoutOption("30 seconds"))
          if (Option.isNone(settled)) {
            // Break the cycle so the failure is reportable: the persistence
            // fiber's wait for the state gate is interruptible, and rolling its
            // journal transaction back frees the writer the driver is blocked on.
            yield* Fiber.interrupt(persistFiber)
            yield* Fiber.await(driverFiber)
          }
          expect(Option.isSome(settled)).toBe(true)
          if (Option.isNone(settled)) return
          expect(settled.value.map(Exit.isSuccess)).toEqual([true, true])
          expect((yield* store.get(executionId)).cancelRequestedAtMs).not.toBeNull()
          if (persistence === "deferred completion") {
            expect(
              Option.isSome(yield* state.deferred({ flowName: flow._tag, executionId, deferredName }))
            ).toBe(true)
            expect(resumes).toEqual([`${executionId}:deferred`])
          } else {
            expect(
              Option.isSome(
                yield* state.clock({ flowName: flow._tag, executionId, clockName: clock.name })
              )
            ).toBe(true)
          }
        })).pipe(Effect.provide(TestStores.layerAt(":memory:")))
      ))
  }
})
