import { it } from "@effect/vitest"
import type { Flow, FlowRuntime } from "@smthrs/flow"
import { Effect, Option } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"

/** Declares a TestClock-driven test with concrete Node cryptography. */
export const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

/** Declares a wall-clock test with concrete Node cryptography. */
export const liveEffect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.live(name, () => withCrypto(body()))

/** Polls a result until the predicate holds, bounded by `turns` scheduler turns. */
export const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>,
  predicate: (result: Flow.Result<A, E>) => boolean,
  options: { readonly turns: number }
): Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R> =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let index = 0; index < options.turns && (Option.isNone(result) || !predicate(result.value)); index++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })
