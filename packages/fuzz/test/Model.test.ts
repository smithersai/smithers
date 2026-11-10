import { assert, it } from "@effect/vitest"
import { Cause, Effect } from "effect"
import * as Model from "../src/internal/arbitrary/model.ts"

it.effect("an empty shrink cause propagates instead of inventing a value", () =>
  Effect.gen(function*() {
    const result = yield* Effect.exit(Model.onTypedFailure(() => Effect.succeed(1))(Cause.empty))
    assert.strictEqual(result._tag, "Failure")
    if (result._tag === "Failure") assert.deepStrictEqual(result.cause, Cause.empty)
  }))
