/**
 * A durable wait taken from inside an action, on the flow's own instance.
 *
 * `wrapActionResult` counts the action regions open on one instance, and a
 * suspension waits for that count to fall before it lets the flow park: a
 * sibling action still in flight holds work the journal has not recorded yet,
 * and suspending out from under it would lose that work.
 *
 * An *enclosing* region is not a sibling. It cannot settle until the region
 * inside it returns, so waiting for it to settle is waiting for the caller to
 * finish waiting. That is the shape every harness cell call has — each
 * `ctx.call` is an action, and the `wait` flow it dispatches awaits a durable
 * clock under the run's own instance — and it is what two `r96repl` SWE-bench
 * runs died of: `clock-scheduled`, a fired clock, one
 * `{"decision":"wake-scheduled","reason":"clock"}`, and then nothing at all,
 * with the run row still `running` and carrying no waiting reason, because the
 * round that should have parked never ended.
 *
 * The wait ran inside an `Effect.onExit` finalizer, so the block was
 * uninterruptible: no timeout, no cancellation and no operator resume could
 * reach it. Each case here therefore settles its round on a fiber of its own
 * and reports "never settled" rather than hanging the suite.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Crypto } from "@smthrs/crypto"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const Host = Flow.make("nested-suspension/host", {
  payload: {},
  body: () => Node.succeed(undefined)
})

const gate = DurableDeferred.make("nested-suspension/gate", { success: Schema.String })

/**
 * The round's settlement, or the fact that it never produced one.
 *
 * The round runs on a fiber of its own because a round blocked inside an exit
 * finalizer cannot be interrupted: waiting for it inline would hang the suite
 * instead of failing it.
 */
const settlement = <A, E, R>(round: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const settled = Deferred.makeUnsafe<A | "never settled">()
    yield* Effect.forkDetach(
      Effect.flatMap(round, (value) => Deferred.succeed(settled, value)),
      { startImmediately: true }
    )
    return yield* Deferred.await(settled).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.succeed<A | "never settled">("never settled")
      })
    )
  })

describe("an action that awaits a durable deferred on the flow's own instance", () => {
  it.live("suspends the flow instead of blocking the round forever", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "nested-suspension")
      const result = yield* withCrypto(
        Effect.gen(function*() {
          // The context a harness flow binding captures: the run's own
          // instance, handed back to the handler that arms the durable wait.
          const services = yield* Effect.context<
            Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
          >()
          return yield* settlement(
            Flow.intoResult(
              Action.make({
                name: "nested-suspension/await",
                success: Schema.String,
                tier: "irreversible",
                idempotencyKey: "nested-suspension-await",
                execute: Effect.provide(DurableDeferred.await(gate), services)
              })
            )
          )
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(layerMemory)
        )
      )

      expect(typeof result === "string" ? result : result._tag).toBe("Suspended")
      expect(instance.suspended).toBe(true)
    }))

  for (const wrapper of ["into", "raceAll"] as const) {
    it.live(`suspends through ${wrapper} on the flow's own instance`, () =>
      Effect.gen(function*() {
        const instance = makeInstance(Host, `nested-suspension/${wrapper}`)
        const result = yield* withCrypto(
          Effect.gen(function*() {
            const services = yield* Effect.context<
              Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
            >()
            const wait = DurableDeferred.await(gate)
            const wrapped = wrapper === "into"
              ? DurableDeferred.into(wait, DurableDeferred.make("nested-suspension/result", { success: Schema.String }))
              : DurableDeferred.raceAll({
                name: "nested-suspension/race",
                success: Schema.String,
                error: Schema.Never,
                effects: [
                  wait,
                  DurableDeferred.await(DurableDeferred.make("nested-suspension/other", {
                    success: Schema.String
                  }))
                ]
              })
            return yield* settlement(Flow.intoResult(Action.make({
              name: `nested-suspension/${wrapper}`,
              success: Schema.String,
              tier: "irreversible",
              idempotencyKey: `nested-suspension-${wrapper}`,
              execute: Effect.provide(wrapped, services)
            })))
          }).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance),
            Effect.provide(layerMemory)
          )
        )

        expect(typeof result === "string" ? result : result._tag).toBe("Suspended")
        expect(instance.suspended).toBe(true)
        expect(instance.actionState.count).toBe(0)
      }))
  }

  it.live("still holds a suspension for a sibling action that is still running", () =>
    Effect.gen(function*() {
      // The behaviour the enclosing-region exemption must not cost: two actions
      // run concurrently, one suspends, and the round does not settle until the
      // other has finished and been recorded.
      const instance = makeInstance(Host, "sibling-suspension")
      const order: Array<string> = []
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const services = yield* Effect.context<
            Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
          >()
          return yield* settlement(
            Flow.intoResult(
              Effect.all(
                [
                  Action.make({
                    name: "sibling-suspension/await",
                    success: Schema.String,
                    tier: "irreversible",
                    idempotencyKey: "sibling-suspension-await",
                    execute: Effect.provide(DurableDeferred.await(gate), services)
                  }),
                  Action.make({
                    name: "sibling-suspension/slow",
                    success: Schema.String,
                    tier: "irreversible",
                    idempotencyKey: "sibling-suspension-slow",
                    // Yields rather than sleeps: the point is that the
                    // suspending sibling waits for work that is still being
                    // scheduled, not for wall clock.
                    execute: Effect.forEach(
                      [0, 1, 2, 3, 4, 5, 6, 7],
                      () => Effect.yieldNow,
                      { discard: true }
                    ).pipe(
                      Effect.andThen(Effect.sync(() => {
                        order.push("slow settled")
                        return "slow"
                      }))
                    )
                  })
                ],
                { concurrency: 2 }
              )
            ).pipe(Effect.tap(() => Effect.sync(() => order.push("round settled"))))
          )
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(layerMemory)
        )
      )

      expect(typeof result === "string" ? result : result._tag).toBe("Suspended")
      expect(order).toEqual(["slow settled", "round settled"])
    }))
})

describe("concurrent nested regions", () => {
  it.live("settles sibling regions whose nested regions suspend together", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "concurrent-nested-suspension")
      const ready = yield* Deferred.make<void>()
      let entered = 0
      const nested = Flow.wrapActionResult(
        Effect.gen(function*() {
          if (++entered === 2) yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(ready)
          return new Flow.Suspended()
        }),
        Flow.isResult
      )
      const outer = Flow.wrapActionResult(nested, Flow.isResult)
      const result = yield* settlement(
        Effect.all([outer, outer], { concurrency: 2 }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
      )
      expect(result).not.toBe("never settled")
      expect(instance.actionState.count).toBe(0)
    }))
})
