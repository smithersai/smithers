/** Retain fast-check generators, shrinking, seeds and examples across Effect RCs. */
import * as Effect from "effect/Effect"
import * as FastCheck from "fast-check"

export const effectProperty = (test) => (name, arbitraries, property, options) =>
  test(name, () => Effect.gen(function*() {
    const context = yield* Effect.context()
    yield* Effect.promise((signal) => FastCheck.assert(
      FastCheck.asyncProperty(...arbitraries, (...values) =>
        Effect.runPromiseWith(context)(Effect.scoped(property(values)), { signal })),
      options.fastCheck
    ))
  }))
