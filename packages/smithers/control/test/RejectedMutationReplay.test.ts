import { Effect, Result } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { Unauthorized } from "../src/ControlError.vibe"
import * as ControlExecutor from "../src/ControlExecutor.vibe"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import { durable } from "./DurableStack.ts"
import { live } from "./TestStack.ts"

const start = Effect.gen(function*() {
  const runtime = yield* ControlRuntime
  const { card } = yield* runtime.plan({ flowId: "system/test", input: {} })
  const token = yield* runtime.lookupApproval(card.approval.target)
  yield* runtime.resolveApproval(token, "approved", yield* runtime.stampPrincipal())
  const launched = yield* runtime.launch(card.planId, card.digest, card.envelope)
  if (launched._tag !== "Started") return yield* Effect.die("expected launch")
  return launched.run.runId
})

for (const [name, stack] of [["memory", live], ["SQLite", durable]] as const) {
  describe(`${name} rejected mutations`, () => {
    it("does not settle or reconcile a cancellation rejected with Conflict", () => {
      const settled: string[] = []
      const executor = ControlExecutor.makeNoop({
        settleCancelledPark: ({ runId }) =>
          Effect.sync(() => {
            settled.push(runId)
          })
      })
      return Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const first = yield* start
          const second = yield* start
          yield* control.cancel({ runId: first, idempotencyKey: "cancel-key" })
          settled.length = 0
          const before = yield* runtime.getRun(second)
          const receipt = yield* control.cancel({ runId: second, idempotencyKey: "cancel-key" })
          expect(receipt._tag).toBe("Conflict")
          expect(settled).toEqual([])
          expect(yield* runtime.getRun(second)).toEqual(before)
        }).pipe(Effect.provide(stack({ executor })), Effect.scoped)
      )
    })

    it("replays Unauthorized for an authorization-rejected signal without delivering again", () => {
      let deliveries = 0
      const executor = ControlExecutor.makeNoop({
        deliverSignal: () =>
          Effect.sync(() => {
            deliveries++
            return "refused" as const
          })
      })
      return Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const input = {
            runId: yield* start,
            signal: { name: "approval", payload: null },
            idempotencyKey: "signal-key"
          }
          const first = yield* Effect.result(control.signal(input))
          const replay = yield* Effect.result(control.signal(input))
          expect(Result.isFailure(first) && first.failure).toBeInstanceOf(Unauthorized)
          expect(Result.isFailure(replay) && replay.failure).toBeInstanceOf(Unauthorized)
          expect(replay).toEqual(first)
          expect(deliveries).toBe(1)
        }).pipe(Effect.provide(stack({ executor })), Effect.scoped)
      )
    })
  })
}
