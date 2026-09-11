/**
 * A failed action's error is JSON-encoded into the journal. This pins the
 * engine boundary against live Error values and raw non-JSON causes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"

class AdapterError extends Schema.TaggedError<AdapterError>()("ActionErrorCause/AdapterError", {
  code: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

const journaled = (name: string, error: AdapterError) => {
  const declaration = Action.make(`ActionErrorCause/${name}/action`, {
    payload: { id: Schema.String },
    success: Schema.Void,
    error: AdapterError
  })
  const flow = Flow.make(`ActionErrorCause/${name}`, {
    payload: { id: Schema.String },
    success: Schema.Void,
    error: AdapterError,
    body: (payload) => declaration.call(payload)
  })
  const layer = Layer.mergeAll(
    declaration.toLayer(() => Effect.fail(error)),
    Interpreter.layer(flow)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return Effect.gen(function*() {
    const failure = yield* Effect.flip(flow.execute({ id: "x" }, { executionId: `${name}-run` }))
    expect(failure._tag).toBe("ActionErrorCause/AdapterError")
    return failure as AdapterError
  }).pipe(Effect.provide(layer))
}

describe("a journaled action failure carrying a non-JSON cause", () => {
  effect("keeps its code and message when the cause is an Error", () =>
    Effect.gen(function*() {
      const failure = yield* journaled(
        "error-cause",
        new AdapterError({
          code: "model_failed",
          message: "the model call failed",
          cause: new Error("provider returned 429")
        })
      )
      expect(failure.code).toBe("model_failed")
      expect(failure.message).toBe("the model call failed")
    }))

  effect("keeps its code and message when the cause holds a bigint and a function", () =>
    Effect.gen(function*() {
      const failure = yield* journaled(
        "raw-cause",
        new AdapterError({
          code: "adapter_quota_exhausted",
          message: "the quota is spent",
          cause: { status: 429, retryAfter: 30n, retry: () => undefined }
        })
      )
      expect(failure.code).toBe("adapter_quota_exhausted")
      expect(failure.message).toBe("the quota is spent")
    }))
})
