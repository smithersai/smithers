/**
 * A stopped mutation must not lose the failure of its own cleanup.
 *
 * `signal` claims its run key before admission and releases the claim when the
 * mutation fails or is interrupted. Effect 4.0.4 removes a typed failure from
 * an interrupted fiber's cause once the unwind passes a recovery handler, so a
 * `PersistenceError` from that release vanished and the caller saw a plain
 * interruption over a claim that was never released.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { PersistenceError } from "../src/ControlError.vibe"
import { ControlRuntime } from "../src/ControlRuntime.vibe"
import { live, memoryRuntime } from "./TestStack.ts"

const start = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
  const token = yield* runtime.lookupApproval(card.approval.target)
  yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
  if (launched._tag !== "Started") return yield* Effect.die("expected launch")
  return launched.run.runId
})

const admitFailure = new PersistenceError({ operation: "admitSignal", message: "the signal store is unavailable" })
const releaseFailure = new PersistenceError({ operation: "releaseRunKey", message: "the run key store is unavailable" })

describe("an interrupted signal", () => {
  it("surfaces a failed run key release beside the interruption", async () => {
    const admitting = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    let released = 0
    const runtime = Layer.effect(
      ControlRuntime,
      Effect.map(ControlRuntime, (service) => ({
        ...service,
        // Admission is still in flight when the caller stops the mutation, then
        // fails; the claim's release fails too. Whether the stop lands inside
        // the write or after it, both failures are the caller's to see.
        admitSignal: () =>
          Deferred.succeed(admitting, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.andThen(Effect.fail(admitFailure))
          ),
        releaseRunKey: () =>
          Effect.suspend(() => {
            released++
            return Effect.fail(releaseFailure)
          })
      }))
    ).pipe(Layer.provide(memoryRuntime()))

    const exit = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runId = yield* start
        const fiber = yield* control.signal({
          runId,
          signal: { name: "ready", payload: null },
          idempotencyKey: "stopped"
        })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(admitting)
        const stopping = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(stopping)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(live({ runtime })), Effect.scoped)
    )

    expect(released).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false)
      const reported = exit.cause.reasons.flatMap((reason) =>
        reason._tag === "Die" ? [reason.defect] : reason._tag === "Fail" ? [reason.error] : []
      )
      expect(reported).toContainEqual(releaseFailure)
    }
  })
})
