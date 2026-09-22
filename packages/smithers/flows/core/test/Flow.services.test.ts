import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Flow as Durable, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Context, Effect, Schema, SchemaGetter } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Layer from "effect/Layer"
import { expect, expectTypeOf, it } from "vitest"
import * as Flow from "../src/Flow.ts"

class Decoder extends Context.Service<Decoder, { readonly suffix: string }>()("CoreServices/Decoder") {}
class Encoder extends Context.Service<Encoder, { readonly prefix: string }>()("CoreServices/Encoder") {}
class Handler extends Context.Service<Handler, { readonly result: string }>()("CoreServices/Handler") {}

const encoded = Schema.String.pipe(Schema.decodeTo(Schema.String, {
  decode: SchemaGetter.transformEffect((value: string) => Effect.map(Decoder, ({ suffix }) => value + suffix)),
  encode: SchemaGetter.transformEffect((value: string) => Effect.map(Encoder, ({ prefix }) => prefix + value))
}))
const scalar = Flow.make({ name: "services/scalar", input: encoded, output: Schema.String })
const struct = Flow.make({ name: "services/struct", input: Schema.Struct({ value: encoded }), output: Schema.String })
const scalarId = scalar.flow.executionId({ input: "same" })
const structId = struct.flow.executionId({ value: "same" })
const implemented = scalar.action!.toLayer(() => Effect.map(Handler, ({ result }) => result))
const interpreter = Interpreter.layer(struct.flow)

it("retains concrete codec and handler services through both payload shapes", () => {
  expectTypeOf<Effect.Services<typeof scalarId>>().toEqualTypeOf<Crypto.Crypto | Encoder>()
  expectTypeOf<Effect.Services<typeof structId>>().toEqualTypeOf<Crypto.Crypto | Encoder>()
  expectTypeOf<Layer.Services<typeof implemented>>().toEqualTypeOf<
    FlowRuntime.FlowRuntime | Decoder | Encoder | Handler
  >()
  expectTypeOf<Decoder extends Layer.Services<typeof interpreter> ? true : false>().toEqualTypeOf<true>()
  expectTypeOf<Encoder extends Layer.Services<typeof interpreter> ? true : false>().toEqualTypeOf<true>()
})

it("uses the supplied encoder through the wrapper's public identity surface", async () => {
  const id = (prefix: string) =>
    Effect.runPromise(scalarId.pipe(
      Effect.provide(Durable.layerExecutionIds(Durable.derived)),
      Effect.provideService(Encoder, { prefix }),
      Effect.provide(NodeCrypto.layer)
    ))
  expect(await id("first:")).not.toBe(await id("second:"))
})

const missingEncoder = () => {
  // @ts-expect-error Encoding a wrapped input still requires its service.
  Effect.runPromise(scalarId.pipe(Effect.provide(NodeCrypto.layer)))
}
void missingEncoder
