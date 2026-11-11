import { describe, expect } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect } from "./Harness.ts"

describe("compatible action cache declarations", () => {
  for (const retained of [false, true]) {
    effect(
      retained
        ? "replays an old result after an explicitly compatible optional-field extension"
        : "keeps schema changes as cache misses by default",
      () =>
        Effect.gen(function*() {
          const runtime = yield* FlowRuntime.FlowRuntime
          const flow = Flow.make("CacheDeclaration/test", {
            payload: {},
            success: Schema.Unknown,
            body: () => Node.succeed(undefined)
          })
          const prior = Schema.Struct({ value: Schema.Number })
          let fresh = 0
          const old = Action.make({
            name: "cache-declaration",
            idempotencyKey: "same",
            success: prior,
            execute: Effect.succeed({ value: 7 })
          })
          const current = Action.make({
            name: "cache-declaration",
            idempotencyKey: "same",
            success: Schema.Struct({ value: Schema.Number, note: Schema.optional(Schema.String) }),
            annotations: retained
              ? Context.make(Action.CacheDeclaration, { success: prior, error: Schema.Never })
              : Context.empty(),
            execute: Effect.sync(() => {
              fresh++
              return { value: 8, note: "new" }
            })
          })
          yield* runtime.register(flow, () =>
            Effect.gen(function*() {
              yield* old
              return yield* current
            }))
          const result = yield* flow.execute({}, { executionId: "cache-declaration" })
          expect(result).toEqual(retained ? { value: 7 } : { value: 8, note: "new" })
          expect(fresh).toBe(retained ? 0 : 1)
        }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
    )
  }
})
