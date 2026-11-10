/**
 * VIP-44: `executeEncoded` stores results through the injected
 * `RpcSerialization`'s `codecFor`; `RpcSerialization.json` is the default.
 */
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import { Cause, Context, Effect, Exit, Schema, SchemaGetter } from "effect"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as fc from "fast-check"

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

class SuccessDecoder extends Context.Service<SuccessDecoder, { readonly prefix: string }>()(
  "ActionSerialization/SuccessDecoder"
) {}
class ErrorDecoder extends Context.Service<ErrorDecoder, { readonly offset: number }>()(
  "ActionSerialization/ErrorDecoder"
) {}

const serviceSuccess = Schema.String.pipe(Schema.decodeTo(Schema.String, {
  decode: SchemaGetter.transformEffect((value: string) => Effect.map(SuccessDecoder, ({ prefix }) => prefix + value)),
  encode: SchemaGetter.transformEffect((value: string) => Effect.as(ErrorDecoder, value))
}))
const serviceError = Schema.Number.pipe(Schema.decodeTo(Schema.Number, {
  decode: SchemaGetter.transformEffect((value: number) => Effect.map(ErrorDecoder, ({ offset }) => offset + value)),
  encode: SchemaGetter.transformEffect((value: number) => Effect.as(SuccessDecoder, value))
}))

describe("stored exit schema types", () => {
  it("preserves success, error and decoder requirements", () => {
    const schemas = Action.exitSchemasFor(RpcSerialization.json, {
      successSchema: serviceSuccess,
      errorSchema: serviceError
    })
    expectTypeOf<(typeof schemas.exitSchema)["Type"]>().toEqualTypeOf<Exit.Exit<string, number>>()
    expectTypeOf<(typeof schemas.exitSchemaPartial)["Type"]>().toEqualTypeOf<Exit.Exit<string, number>>()
    expectTypeOf<(typeof schemas.exitSchemaPartial)["DecodingServices"]>().toEqualTypeOf<
      SuccessDecoder | ErrorDecoder
    >()
    expectTypeOf<(typeof schemas.exitSchemaPartial)["EncodingServices"]>().toEqualTypeOf<
      SuccessDecoder | ErrorDecoder
    >()
    expectTypeOf<(typeof schemas.exitSchemaPartial.value)["EncodingServices"]>().toEqualTypeOf<ErrorDecoder>()
    expectTypeOf<(typeof schemas.exitSchemaPartial.error)["EncodingServices"]>().toEqualTypeOf<SuccessDecoder>()
    expectTypeOf<(typeof schemas.exitSchemaPartial)["Encoded"]>().toEqualTypeOf<Exit.Exit<unknown, unknown>>()
    const decoded = Schema.decodeUnknownEffect(schemas.exitSchemaPartial)(Exit.succeed("value"))
    expectTypeOf<Effect.Services<typeof decoded>>().toEqualTypeOf<SuccessDecoder | ErrorDecoder>()
    expectTypeOf<typeof decoded>().not.toExtend<Parameters<typeof Effect.runPromise>[0]>()
  })

  it("keeps typed success and error decoders distinct across cache hits", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.integer(), fc.integer(), (prefix, value, offset, error) => {
        for (
          const serialization of [
            RpcSerialization.json,
            RpcSerialization.ndjson,
            RpcSerialization.jsonRpc(),
            RpcSerialization.ndJsonRpc()
          ]
        ) {
          const schemas = Action.exitSchemasFor(serialization, {
            successSchema: serviceSuccess,
            errorSchema: serviceError
          })
          const swapped = Action.exitSchemasFor(serialization, {
            successSchema: serviceError,
            errorSchema: serviceSuccess
          })
          const success = Effect.runSync(
            Schema.decodeUnknownEffect(schemas.exitSchemaPartial)(Exit.succeed(value)).pipe(
              Effect.provideService(SuccessDecoder, { prefix }),
              Effect.provideService(ErrorDecoder, { offset })
            )
          )
          const failure = Effect.runSync(
            Schema.decodeUnknownEffect(schemas.exitSchemaPartial)(Exit.fail(error)).pipe(
              Effect.provideService(SuccessDecoder, { prefix }),
              Effect.provideService(ErrorDecoder, { offset })
            )
          )
          const swappedSuccess = Effect.runSync(
            Schema.decodeUnknownEffect(swapped.exitSchemaPartial)(Exit.succeed(error)).pipe(
              Effect.provideService(SuccessDecoder, { prefix }),
              Effect.provideService(ErrorDecoder, { offset })
            )
          )
          const swappedFailure = Effect.runSync(
            Schema.decodeUnknownEffect(swapped.exitSchemaPartial)(Exit.fail(value)).pipe(
              Effect.provideService(SuccessDecoder, { prefix }),
              Effect.provideService(ErrorDecoder, { offset })
            )
          )
          expect(success).toEqual(Exit.succeed(prefix + value))
          expect(Exit.isFailure(failure) && failure.cause.reasons.find(Cause.isFailReason)?.error).toBe(offset + error)
          expect(swappedSuccess).toEqual(Exit.succeed(offset + error))
          expect(Exit.isFailure(swappedFailure) && swappedFailure.cause.reasons.find(Cause.isFailReason)?.error)
            .toBe(prefix + value)
        }
      }),
      { numRuns: 50 }
    )
  })
})
