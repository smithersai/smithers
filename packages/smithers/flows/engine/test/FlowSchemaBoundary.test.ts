/**
 * Flow declarations are runtime contracts, including for handlers registered
 * directly with the engine rather than through the body interpreter.
 */
import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"
import { effect } from "./Harness.ts"

const InvalidSuccess = Flow.make("SchemaBoundary/invalid-success", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("unused")
})

const InvalidFailure = Flow.make("SchemaBoundary/invalid-failure", {
  payload: {},
  success: Schema.String,
  error: Schema.Never,
  body: () => Node.succeed("unused")
})

const NestedSuccess = Schema.Struct({
  outputs: Schema.Array(Schema.Struct({ path: Schema.NonEmptyString }))
})

const ValidSuccess = Flow.make("SchemaBoundary/valid-success", {
  payload: {},
  success: NestedSuccess,
  body: () => Node.succeed({ outputs: [{ path: "unused" }] })
})

const layers = (): ReadonlyArray<readonly [string, Layer.Layer<FlowRuntime.FlowRuntime>]> => [
  ["memory", FlowEngine.layerMemory],
  ["durable", layerDurable(makeLog())]
]

const assertDefect = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
}

describe("flow schema boundary", () => {
  for (const [runtime, layer] of layers()) {
    effect(`${runtime} accepts a valid value with nested checks`, () =>
      Effect.gen(function*() {
        const value = { outputs: [{ path: "out" }] }
        const result = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(ValidSuccess, () => Effect.succeed(value))
          return yield* ValidSuccess.execute(
            {},
            { executionId: `${runtime}-valid-nested-success` }
          )
        })).pipe(Effect.provide(layer))

        expect(result).toEqual(value)
      }))

    effect(`${runtime} rejects a success outside the declared schema`, () =>
      Effect.gen(function*() {
        const exit = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(
            InvalidSuccess,
            () => Effect.succeed(42 as unknown as string)
          )
          return yield* Effect.exit(
            InvalidSuccess.execute({}, { executionId: `${runtime}-invalid-success` })
          )
        })).pipe(Effect.provide(layer))

        assertDefect(exit)
      }))

    effect(`${runtime} rejects a failure outside the declared schema`, () =>
      Effect.gen(function*() {
        const exit = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(
            InvalidFailure,
            () => Effect.fail("outside-contract" as never)
          )
          return yield* Effect.exit(
            InvalidFailure.execute({}, { executionId: `${runtime}-invalid-failure` })
          )
        })).pipe(Effect.provide(layer))

        assertDefect(exit)
      }))

    effect(`${runtime} exposes only schema-valid completion values through poll`, () =>
      Effect.gen(function*() {
        const polled = yield* Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(
            InvalidSuccess,
            () => Effect.succeed(42 as unknown as string)
          )
          const executionId = yield* InvalidSuccess.execute(
            {},
            { discard: true, executionId: `${runtime}-invalid-poll` }
          )
          let result = yield* InvalidSuccess.poll(executionId)
          for (let index = 0; index < 100 && Option.isNone(result); index++) {
            yield* Effect.yieldNow
            result = yield* InvalidSuccess.poll(executionId)
          }
          return result
        })).pipe(Effect.provide(layer))

        expect(Option.isSome(polled)).toBe(true)
        if (Option.isSome(polled)) {
          expect(polled.value._tag).toBe("Complete")
          if (polled.value._tag === "Complete") assertDefect(polled.value.exit)
        }
      }))
  }
})
