import { expect, expectTypeOf, it } from "@effect/vitest"
import { DurableDeferred, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Schema, SchemaGetter } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
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
  expectTypeOf<Effect.Services<typeof id>>().toEqualTypeOf<
    (EffectDigest.Digest | SecureRandom.SecureRandom) | Encoder
  >()
  expectTypeOf<Effect.Services<typeof minted>>().toEqualTypeOf<
    (EffectDigest.Digest | SecureRandom.SecureRandom) | Encoder
  >()
  expectTypeOf<Effect.Services<typeof token>>().toEqualTypeOf<
    (EffectDigest.Digest | SecureRandom.SecureRandom) | Encoder
  >()
  expectTypeOf<Effect.Services<typeof curriedToken>>().toEqualTypeOf<
    (EffectDigest.Digest | SecureRandom.SecureRandom) | Encoder
  >()
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
  const derivedId = withCrypto(id)
  const derivedToken = withCrypto(token)
  expectTypeOf<typeof derivedId>().not.toExtend<Parameters<typeof Effect.runPromise>[0]>()
  expectTypeOf<typeof derivedToken>().not.toExtend<Parameters<typeof Effect.runPromise>[0]>()
}
void missingEncoder
