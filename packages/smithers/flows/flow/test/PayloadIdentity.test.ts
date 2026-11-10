/**
 * VIP-44's shared payload identity: every site that hashes or compares a flow
 * payload goes through `Flow.payloadSnapshot` or `Flow.payloadPreimage`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Context, Effect, Exit, Layer, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const Release = Schema.Struct({
  tags: Schema.ReadonlySet(Schema.String),
  owners: Schema.ReadonlyMap(Schema.String, Schema.Number)
})

/** An encoder the host injects: a real one, or a faulty one for the unhappy path. */
class Encoder extends Context.Service<Encoder, {
  readonly encode: (value: string) => Effect.Effect<string, SchemaIssue.Issue>
}>()("test/PayloadIdentity/Encoder") {}

const Injected = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformEffect({
      decode: (value) => Effect.succeed(value),
      encode: (value) =>
        Effect.gen(function*() {
          return yield* (yield* Encoder).encode(value)
        })
    })
  )
)
const WithInjected = Schema.Struct({ tags: Schema.ReadonlySet(Injected) })

const upper = Layer.succeed(Encoder)({ encode: (value) => Effect.succeed(value.toUpperCase()) })
const faulty = Layer.succeed(Encoder)({
  encode: (value) => Effect.fail(new SchemaIssue.InvalidValue({ message: "encoder unavailable" }, value))
})

describe("Flow.payloadSnapshot", () => {
  it.effect("sorts every set and map before the payload codec", () =>
    Effect.gen(function*() {
      const left = yield* Flow.payloadSnapshot(Release, {
        tags: new Set(["b", "a"]),
        owners: new Map([["y", 2], ["x", 1]])
      })
      const right = yield* Flow.payloadSnapshot(Release, {
        tags: new Set(["a", "b"]),
        owners: new Map([["x", 1], ["y", 2]])
      })
      expect(left).toEqual({ tags: ["a", "b"], owners: [["x", 1], ["y", 2]] })
      expect(right).toEqual(left)
    }))

  it.effect("encodes a collection-free payload exactly as the JSON codec does", () =>
    Effect.gen(function*() {
      const Plain = Schema.Struct({ count: Schema.NumberFromString, at: Schema.Date })
      const value = { count: 3, at: new Date(0) }
      expect(yield* Flow.payloadSnapshot(Plain, value)).toEqual(
        yield* Schema.encodeEffect(Schema.toCodecJson(Plain))(value)
      )
    }))

  it.effect("runs the schema's own encoding services", () =>
    Effect.gen(function*() {
      expect(yield* Flow.payloadSnapshot(WithInjected, { tags: new Set(["b", "a"]) })).toEqual({ tags: ["A", "B"] })
    }).pipe(Effect.provide(upper)))

  it.effect("fails with the schema error a faulty encoding service raises", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(Flow.payloadSnapshot(WithInjected, { tags: new Set(["a"]) }))
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("encoder unavailable")
    }).pipe(Effect.provide(faulty)))

  it.effect("refuses a value its codec cannot encode, such as an invalid Date", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Flow.payloadSnapshot(Schema.Struct({ at: Schema.Date }), { at: new Date(Number.NaN) })
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("Flow.payloadPreimage", () => {
  it.effect("keeps a collection-free payload as written, so released ids are unchanged", () =>
    Effect.gen(function*() {
      const value = { count: 3 }
      expect(yield* Flow.payloadPreimage(Schema.Struct({ count: Schema.NumberFromString }), value)).toBe(value)
    }))

  it.effect("hashes a payload that holds a collection as its sorted snapshot", () =>
    Effect.gen(function*() {
      expect(yield* Flow.payloadPreimage(Release, { tags: new Set(["b", "a"]), owners: new Map() })).toEqual({
        tags: ["a", "b"],
        owners: []
      })
    }))
})

describe("the recorded plan's root input", () => {
  const Echo = Action.make("PayloadIdentity/echo", { payload: { value: Schema.String }, success: Schema.String })
  const Tagged = Flow.make("PayloadIdentity/tagged", {
    payload: { tags: Schema.ReadonlySet(Injected) },
    success: Schema.String,
    body: ({ tags }) => Echo.call({ value: [...tags].join(",") })
  })
  const layer = (encoder: Layer.Layer<Encoder>) =>
    layerWired(
      Layer.mergeAll(
        Echo.toLayer(({ value }) => Effect.succeed(value)),
        Interpreter.layer(Tagged).pipe(Layer.provide(encoder))
      )
    )

  it.effect("runs a flow whose payload holds a set", () =>
    Effect.gen(function*() {
      const value = yield* withCrypto(
        Tagged.execute({ tags: new Set(["a", "b"]) }, { executionId: "root-set" }).pipe(Effect.provide(layer(upper)))
      )
      expect(value).toBe("a,b")
    }).pipe(Effect.provide(upper)))

  it.effect("refuses, typed, a root payload a faulty encoding service cannot encode", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(
        Effect.exit(
          Tagged.execute({ tags: new Set(["a"]) }, { executionId: "root-faulty" }).pipe(Effect.provide(layer(faulty)))
        )
      )
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("Cannot encode payload")
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("encoder unavailable")
    }).pipe(Effect.provide(faulty)))
})
