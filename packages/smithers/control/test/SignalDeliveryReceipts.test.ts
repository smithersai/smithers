import { Effect, Layer, Result } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.vibe"
import { NoMatchingWait } from "../src/ControlError.vibe"
import * as ControlExecutor from "../src/ControlExecutor.vibe"
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

describe("signal receipt replay", () => {
  it("marks an unavailable engine execution explicitly without inventing a wait or changing the control row", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start
        expect(yield* control.list({ _tag: "runs" })).toMatchObject({
          items: [{ runId, status: "accepted", executionObservation: "missing" }]
        })
        expect((yield* runtime.getRun(runId)).executionObservation).toBeUndefined()
        expect((yield* runtime.getRun(runId)).waitingReason).toBeUndefined()
      }).pipe(
        Effect.provide(live({
          executor: ControlExecutor.makeNoop({
            readExecution: () => Effect.succeed({ _tag: "Missing" as const })
          })
        })),
        Effect.scoped
      )
    ))

  for (const outcome of ["delivered", "no-match", "unknown"] as const) {
    it(`never reapplies a command after ${outcome === "unknown" ? "terminal settlement" : outcome}`, () => {
      let calls = 0
      const executor = ControlExecutor.makeNoop({
        deliverSignal: () =>
          Effect.sync(() => {
            calls++
            return outcome
          })
      })
      return Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control
          const runtime = yield* ControlRuntime
          const input = { runId: yield* start, signal: { name: "ready", payload: null }, idempotencyKey: "stable" }
          const first = yield* Effect.result(control.signal(input))
          if (outcome === "unknown") {
            const [command] = yield* runtime.pendingSignals
            yield* runtime.settleSignal(command!.commandId, "terminal")
          }
          const replay = yield* Effect.result(control.signal(input))
          expect(calls).toBe(1)
          if (outcome === "no-match") {
            expect(Result.isFailure(first) && first.failure).toBeInstanceOf(NoMatchingWait)
            expect(Result.isFailure(replay) && replay.failure).toBeInstanceOf(NoMatchingWait)
          } else {
            expect(first).toMatchObject({ _tag: "Success", success: { _tag: "Accepted" } })
            expect(replay).toMatchObject({ _tag: "Success", success: { _tag: "AlreadyApplied" } })
          }
        }).pipe(Effect.provide(live({ executor })), Effect.scoped)
      )
    })
  }

  it("leaves delivery pending when no executor is installed", () =>
    Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        const runId = yield* start
        expect(
          (yield* control.signal({ runId, signal: { name: "ready", payload: null }, idempotencyKey: "unhosted" }))._tag
        ).toBe("Accepted")
        expect((yield* runtime.pendingSignals).map((command) => command.state)).toEqual(["pending"])
      }).pipe(Effect.provide(live({ executor: "absent" })), Effect.scoped)
    ))

  it("returns a concurrent winner's receipt without admitting or delivering again", () => {
    let calls = 0
    const runtime = Layer.effect(
      ControlRuntime,
      Effect.map(ControlRuntime, (service) => ({
        ...service,
        claimRunKey: () =>
          Effect.succeed({
            _tag: "Raced" as const,
            receipt: { _tag: "Accepted" as const, receiptId: "winner", runId: "run-1" }
          })
      }))
    ).pipe(Layer.provide(memoryRuntime()))
    return Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const service = yield* ControlRuntime
        const runId = yield* start
        expect(
          (yield* control.signal({ runId, signal: { name: "ready", payload: null }, idempotencyKey: "raced" }))._tag
        ).toBe("AlreadyApplied")
        expect(yield* service.pendingSignals).toEqual([])
        expect(calls).toBe(0)
      }).pipe(
        Effect.provide(live({
          runtime,
          executor: ControlExecutor.makeNoop({
            deliverSignal: () =>
              Effect.sync(() => {
                calls++
                return "delivered" as const
              })
          })
        })),
        Effect.scoped
      )
    )
  })

  it("does not invent a delivery when a legacy receipt has no command record", () => {
    let calls = 0
    const runtime = Layer.effect(
      ControlRuntime,
      Effect.map(ControlRuntime, (service) => ({
        ...service,
        signalCommand: () => Effect.succeed(undefined)
      }))
    ).pipe(Layer.provide(memoryRuntime()))
    return Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control
        const input = { runId: yield* start, signal: { name: "ready", payload: null }, idempotencyKey: "legacy" }
        yield* control.signal(input)
        expect((yield* control.signal(input))._tag).toBe("AlreadyApplied")
        expect(calls).toBe(0)
      }).pipe(
        Effect.provide(live({
          runtime,
          executor: ControlExecutor.makeNoop({
            deliverSignal: () =>
              Effect.sync(() => {
                calls++
                return "delivered" as const
              })
          })
        })),
        Effect.scoped
      )
    )
  })
})
