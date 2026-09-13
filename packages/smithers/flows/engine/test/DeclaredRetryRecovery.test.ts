import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

describe("declared retry recovery", () => {
  for (const terminal of ["exhausted", "expired"] as const) {
    it.effect(`runs typed graph recovery after ${terminal} and replays it without redispatch`, () =>
      withCrypto(
        Effect.gen(function*() {
          let attempts = 0
          const operation = Action.make(`DeclaredRetryRecovery/${terminal}/operation`, {
            payload: {},
            success: Schema.String,
            error: Schema.String,
            retryPolicy: RetryPolicy.make({
              initialMs: 1,
              factor: 1,
              maxMs: 1,
              ...(terminal === "exhausted" ? { maxAttempts: 3 } : { expirationMs: 3 })
            })
          })
          const flow = Flow.make(`DeclaredRetryRecovery/${terminal}/flow`, {
            payload: {},
            success: Schema.String,
            // A schema-filtered catch retains the error channel: it may refine
            // rather than exhaust the declared error type.
            error: Schema.String,
            body: Node.capture({ action: operation.name, implementationVersion: "recovery/v1" }, () =>
              operation.call({}).pipe(Node.catch({
                error: Schema.String,
                onFailure: () =>
                  Node.succeed("recovered")
              })))
          })
          const runtime = Interpreter.layerWithImplementations(
            flow,
            operation.toLayer(() =>
              Effect.suspend(() => {
                attempts++
                return Effect.fail(`failure-${attempts}`)
              })
            )
          ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
          yield* Effect.gen(function*() {
            const fiber = yield* flow.execute({}, { executionId: terminal }).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            yield* TestClock.adjust(10)
            expect(yield* Fiber.join(fiber)).toBe("recovered")
            expect(attempts).toBe(terminal === "exhausted" ? 3 : 4)
            expect(yield* flow.execute({}, { executionId: terminal })).toBe("recovered")
            expect(attempts).toBe(terminal === "exhausted" ? 3 : 4)
          }).pipe(Effect.provide(runtime))
        })
      ))
  }
})
