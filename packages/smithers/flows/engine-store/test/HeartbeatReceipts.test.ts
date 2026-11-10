/** External liveness receipts follow the real driver's fenced pulses, not output. */
import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as EngineStore from "../src/EngineStore.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as Migrations from "../src/Migrations.vibe"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const FlowUnderTest = Flow.make("HeartbeatReceipts/Test", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})
const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

it.effect("a blocked receipt never blocks lease renewal, overlaps, or outlives cancellation", () =>
  withCrypto(
    Effect.scoped(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const started = yield* Deferred.make<void>()
      const receiptStarted = yield* Deferred.make<void>()
      const receiptEnded = yield* Deferred.make<void>()
      let calls = 0
      const driver = yield* RunDriver.make({
        owner: { hostId: "receipts", pid: 1, nonce: "one" },
        journalSource: "heartbeat-receipts",
        engine: Effect.succeed({} as FlowRuntime.FlowRuntime["Service"])
      })
      yield* driver.register(FlowUnderTest, () =>
        Effect.gen(function*() {
          const instance = yield* FlowRuntime.FlowInstance
          instance.heartbeat = Effect.gen(function*() {
            expect(Option.getOrThrow(yield* Effect.serviceOption(FlowRuntime.FlowInstance)).executionId).toBe("receipt")
            calls++
            yield* Deferred.succeed(receiptStarted, undefined)
            return yield* Effect.never
          }).pipe(Effect.ensuring(Deferred.succeed(receiptEnded, undefined)))
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }))
      yield* driver.execute(FlowUnderTest, { executionId: "receipt", payload: {}, discard: true })
      yield* Deferred.await(started)
      const first = yield* store.get("receipt")
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      yield* Deferred.await(receiptStarted)
      yield* TestClock.adjust(Ownership.heartbeatInterval)
      const next = yield* store.get("receipt")
      expect(next.heartbeatAtMs).toBeGreaterThan(first.heartbeatAtMs!)
      expect(next.status).toBe("running")
      expect(calls).toBe(1)
      yield* driver.interrupt(FlowUnderTest, "receipt")
      yield* Deferred.await(receiptEnded)
      yield* TestDatabase.until(store.get("receipt").pipe(Effect.map((row) => row.status === "cancelled")))
      expect((yield* store.get("receipt")).status).toBe("cancelled")
      yield* TestClock.adjust(Duration.seconds(5))
      expect(calls).toBe(1)
    })).pipe(Effect.provide(services), Effect.provide(TestClock.layer()))
  ))

for (const outcome of ["completed", "failed", "timeout"] as const) {
  it.effect(`public interpreter heartbeat hook survives ${outcome} receipts and clears at completion`, () =>
    withCrypto(
      Effect.scoped(Effect.gen(function*() {
        const engine = yield* EngineStore.make({ owner: { hostId: "hook" }, journalSource: "heartbeat-hook" })
        const release = yield* Deferred.make<void>()
        const started = yield* Deferred.make<void>()
        const seen = yield* Deferred.make<void>()
        let heartbeatInstance: FlowRuntime.FlowInstance["Service"] | undefined
        let receipts = 0
        const Hold = Action.make("HeartbeatReceipts/Hold", { payload: {}, success: Schema.String })
        const Held = Flow.make("HeartbeatReceipts/Held", {
          payload: {},
          success: Schema.String,
          body: Node.capture({}, () => Hold.call({}))
        })
        const registration = Interpreter.layerWithImplementations(
          Held,
          Hold.toLayer(() =>
            Effect.gen(function*() {
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
              return "done"
            })
          ),
          {
            onHeartbeat: (executionId) =>
              Effect.gen(function*() {
                expect(executionId).toBe("hook")
                heartbeatInstance = Option.getOrThrow(yield* Effect.serviceOption(FlowRuntime.FlowInstance))
                expect(heartbeatInstance.heartbeat).toBeDefined()
                receipts++
                yield* Deferred.succeed(seen, undefined)
                if (outcome === "failed") return yield* Effect.die(new Error("faulty receipt service"))
                if (outcome === "timeout") return yield* Effect.never
              })
          }
        )
        yield* Effect.gen(function*() {
          const running = yield* Held.execute({}, { executionId: "hook" }).pipe(Effect.forkChild)
          yield* Deferred.await(started)
          yield* TestClock.adjust(Ownership.heartbeatInterval)
          yield* Deferred.await(seen)
          if (outcome === "timeout") yield* TestClock.adjust(Ownership.heartbeatWriteTolerance)
          yield* TestClock.adjust(Ownership.heartbeatInterval)
          expect(receipts).toBeGreaterThanOrEqual(2)
          yield* Deferred.succeed(release, undefined)
          expect(yield* Fiber.join(running)).toBe("done")
          expect(heartbeatInstance!.heartbeat).toBeUndefined()
        }).pipe(Effect.provide(registration), Effect.provideService(FlowRuntime.FlowRuntime, engine))
      })).pipe(
        Effect.provide(StepBoundary.layerUnsupported),
        Effect.provide(Jj.layerNoop({})),
        Effect.provide(TestStores.layerAt(":memory:")),
        Effect.provide(TestClock.layer())
      )
    ))
}
