/**
 * The scaffolding every flow suite shares: the Effect test wrappers and the
 * bounded poll loop that waits for an execution to settle.
 */
import { it } from "@effect/vitest"
import type { Flow, FlowRuntime } from "@smthrs/flow"
import { type Duration, Effect, Option } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"

/** Registers an Effect test that runs with concrete Node cryptography. */
export const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

/** Registers an Effect test that runs with concrete cryptography over a fresh `TestClock`. */
export const effectOnTestClock = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body().pipe(Effect.provide(TestClock.layer()))))

/** Whether a polled result is the execution's completion. */
export const isComplete = <A, E>(result: Flow.Result<A, E>): boolean => result._tag === "Complete"

/**
 * Polls until the result satisfies `predicate`, yielding one scheduler turn
 * (and advancing the test clock by `advance`, when given) between polls, for
 * at most `turns` turns. Returns the last poll either way.
 */
export const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>,
  predicate: (result: Flow.Result<A, E>) => boolean,
  options: { readonly turns: number; readonly advance?: Duration.Input }
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let turn = 0; turn < options.turns && (Option.isNone(result) || !predicate(result.value)); turn++) {
      yield* Effect.yieldNow
      if (options.advance !== undefined) yield* TestClock.adjust(options.advance)
      result = yield* poll
    }
    return result
  })
