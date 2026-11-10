/**
 * VIP-44: `executeEncoded` stores results through the injected
 * `RpcSerialization`'s `codecFor`; `RpcSerialization.json` is the default.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import { Cause, Effect, Exit, Schema } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"

/** The schema-binary serializer, read out of its layer. */
const schemaBinary = Effect.runSync(
  Effect.gen(function*() {
    return yield* RpcSerialization.RpcSerialization
  }).pipe(Effect.provide(RpcSerialization.layerSchemaBinary()))
)

const Bytes = Action.make({
  name: "ActionSerialization/bytes",
  success: Schema.Uint8Array,
  execute: Effect.succeed(Uint8Array.of(1, 2))
})

const Refusing = Action.make({
  name: "ActionSerialization/refusing",
  error: Schema.Struct({ at: Schema.Date }),
  execute: Effect.fail({ at: new Date(0) })
})

/** An inline action's encoded execution; these bodies need none of the services its type names. */
const runEncoded = (action: { readonly executeEncoded: Effect.Effect<any, any, any> }) =>
  action.executeEncoded as Effect.Effect<unknown, unknown>

describe("Action.executeEncoded", () => {
  it.effect("encodes with RpcSerialization.json when none is provided", () =>
    Effect.gen(function*() {
      expect(yield* runEncoded(Bytes)).toBe("AQI=")
    }))

  it.effect("encodes with the codecFor of the RpcSerialization in context", () =>
    Effect.gen(function*() {
      const encoded = yield* runEncoded(Bytes).pipe(
        Effect.provideService(Action.StoredSerialization, schemaBinary)
      )
      expect(encoded).not.toBe("AQI=")
      const decoded = yield* Schema.decodeUnknownEffect(
        Action.exitSchemasFor(schemaBinary, Bytes).exitSchemaPartial
      )(Exit.succeed(encoded))
      expect(Exit.isSuccess(decoded) && decoded.value).toEqual(Uint8Array.of(1, 2))
    }))

  it.effect("encodes a typed failure with the injected codec too", () =>
    Effect.gen(function*() {
      const json = yield* Effect.exit(runEncoded(Refusing))
      expect(Exit.isFailure(json) && json.cause.reasons.find(Cause.isFailReason)?.error).toEqual({
        at: "1970-01-01T00:00:00.000Z"
      })
      const binary = yield* Effect.exit(
        runEncoded(Refusing).pipe(Effect.provideService(Action.StoredSerialization, schemaBinary))
      )
      expect(Exit.isFailure(binary) && binary.cause.reasons.find(Cause.isFailReason)?.error).not.toEqual({
        at: "1970-01-01T00:00:00.000Z"
      })
    }))
})

describe("Action.exitSchemasFor", () => {
  it("is the action's own exit schemas under RpcSerialization.json", () => {
    const schemas = Action.exitSchemasFor(RpcSerialization.json, Bytes)
    expect(schemas.exitSchema).toBe(Bytes.exitSchema)
    expect(schemas.exitSchemaPartial).toBe(Bytes.exitSchemaPartial)
    expect(Action.exitSchemasFor(RpcSerialization.ndjson, Bytes)).toBe(schemas)
  })
})
