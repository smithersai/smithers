import type * as Effect from "effect/Effect"
import type * as FastCheck from "fast-check"

export declare const effectProperty: (
  test: (name: string, body: () => Effect.Effect<void, unknown>) => unknown
) => <Values extends [unknown, ...unknown[]]>(
  name: string,
  arbitraries: { [K in keyof Values]: FastCheck.Arbitrary<Values[K]> },
  property: (values: Values) => Effect.Effect<void, unknown>,
  options: { readonly fastCheck: FastCheck.Parameters<NoInfer<Values>> }
) => unknown
