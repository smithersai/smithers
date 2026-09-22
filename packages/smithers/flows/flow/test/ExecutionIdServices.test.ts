import { expect, expectTypeOf, it } from "@effect/vitest"
import { DurableDeferred, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Schema, SchemaGetter } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"

class Encoder extends Context.Service<Encoder, { readonly prefix: string }>()("ExecutionIdServices/Encoder") {}

const encoded = Schema.String.pipe(Schema.decodeTo(Schema.String, {
  decode: SchemaGetter.transform((value: string) => value),
  encode: SchemaGetter.transformEffect((value: string) => Effect.map(Encoder, ({ prefix }) => prefix + value))
}))
const flow = Flow.make("ExecutionIdServices/flow", {
  payload: { value: encoded },
  body: () => Node.succeed(undefined)
})
const gate = DurableDeferred.make("ExecutionIdServices/gate")
const payload = { value: "same" }
const id = flow.executionId(payload)
const minted = Flow.derived.mint(flow, payload)
const token = DurableDeferred.tokenFromPayload(gate, { flow, payload })
const curriedToken = DurableDeferred.tokenFromPayload({ flow, payload })(gate)

it("advertises payload encoding services on every execution identity surface", () => {
  expectTypeOf<Effect.Services<typeof id>>().toEqualTypeOf<Crypto.Crypto | Encoder>()
  expectTypeOf<Effect.Services<typeof minted>>().toEqualTypeOf<Crypto.Crypto | Encoder>()
  expectTypeOf<Effect.Services<typeof token>>().toEqualTypeOf<Crypto.Crypto | Encoder>()
  expectTypeOf<Effect.Services<typeof curriedToken>>().toEqualTypeOf<Crypto.Crypto | Encoder>()
})

it.effect("uses the supplied payload encoder consistently for ids and tokens", () =>
  withCrypto(
    Effect.gen(function*() {
      const first = yield* id
      expect(yield* minted).toBe(first)
      expect(DurableDeferred.TokenParsed.fromString(yield* token).executionId).toBe(first)
      expect(DurableDeferred.TokenParsed.fromString(yield* curriedToken).executionId).toBe(first)
      const other = yield* id.pipe(Effect.provideService(Encoder, { prefix: "other:" }))
      expect(other).not.toBe(first)
    }).pipe(
      Effect.provideService(Encoder, { prefix: "one:" }),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    )
  ))

// A caller must not be allowed to run the derived codec without its service.
const missingEncoder = () => {
  // @ts-expect-error Encoder must still be provided after cryptography.
  Effect.runPromise(withCrypto(id))
  // @ts-expect-error The token helper carries the same service obligation.
  Effect.runPromise(withCrypto(token))
}
void missingEncoder
