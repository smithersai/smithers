/**
 * Bounded retry helpers.
 *
 * Retry is an execution concern, so the declaration side records the policy
 * (attempt count, backoff ladder, non-retryable tags) as identity while
 * {@link retryEffect} performs it. The ladder IS `@smthrs/flow`
 * `RetryPolicy`'s, so a pattern policy and an engine policy are the same three
 * numbers rather than two spellings of them.
 *
 * @see https://smithers.sh/docs/concepts/retries
 * @see https://smithers.sh/docs/reference/api/patterns
 * @see https://smithers.sh/docs/reference/api/patterns#identity-and-ownership
 *
 * @since 0.1.0
 */
import * as Flow from "@smthrs/flow/Flow"
import type * as RetryPolicy from "@smthrs/flow/RetryPolicy"
import * as Node from "@smthrs/plan/Node"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Decorate from "./internal/Decorate.ts"
import * as Pattern from "./Pattern.ts"
import { PatternError } from "./PatternError.ts"

/**
 * An un-jittered exponential backoff ladder.
 *
 * The delay before attempt `n + 1` is
 * `min(initialMs * factor^(n - 1), maxMs)`. There is no jitter: a plan built
 * twice must describe the same waits.
 *
 * These are the three ladder fields of `@smthrs/flow` `RetryPolicy`, not a
 * copy of them, so a pattern ladder and the ladder the engine spends are one
 * declaration.
 *
 * @category models
 * @since 0.1.0
 */
export type Backoff = Pick<RetryPolicy.RetryPolicy, "initialMs" | "factor" | "maxMs">

/**
 * Retry declaration options.
 *
 * `attempts` is the TOTAL attempt count, which is `RetryPolicy`'s
 * `maxAttempts`. `nonRetryable` lists error `_tag` values that end the sequence
 * on their first occurrence, whatever the attempt budget says.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly attempts: number
  readonly backoff?: Backoff | undefined
  readonly nonRetryable?: RetryPolicy.RetryPolicy["nonRetryable"]
}

const validate = (options: Options): void => {
  if (!Number.isSafeInteger(options.attempts) || options.attempts < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry attempts must be a positive safe integer, received ${options.attempts}`
    })
  }
  const backoff = options.backoff
  if (backoff === undefined) return
  if (!Number.isFinite(backoff.initialMs) || backoff.initialMs <= 0) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry backoff initialMs must be a positive finite number, received ${backoff.initialMs}`
    })
  }
  if (!Number.isFinite(backoff.factor) || backoff.factor < 1) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry backoff factor must be at least 1, received ${backoff.factor}`
    })
  }
  if (!Number.isFinite(backoff.maxMs) || backoff.maxMs < backoff.initialMs) {
    throw new PatternError({
      code: "invalid_decorator",
      message: `Retry backoff maxMs must be at least initialMs, received ${backoff.maxMs}`
    })
  }
}

// Both call sites read `nonRetryable` only after proving it is present, so the
// parameter is the array rather than the options: a `?? []` fallback here would
// be code no caller can reach.
const tags = (nonRetryable: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(nonRetryable)].sort()

// Own fields only: a decorator is applied later than `make`, and a retried
// effect reads its ladder later than `retryEffect`, so neither may read the
// caller's option object or its backoff record again.
const copied = (options: Options): Options => ({
  attempts: options.attempts,
  backoff: options.backoff === undefined ? undefined : {
    initialMs: options.backoff.initialMs,
    factor: options.backoff.factor,
    maxMs: options.backoff.maxMs
  },
  nonRetryable: options.nonRetryable === undefined ? undefined : [...options.nonRetryable]
})

const captures = (options: Options): Readonly<Record<string, unknown>> => ({
  attempts: options.attempts,
  ...(options.backoff === undefined ? {} : {
    backoff: {
      initialMs: options.backoff.initialMs,
      factor: options.backoff.factor,
      maxMs: options.backoff.maxMs
    }
  }),
  ...(options.nonRetryable === undefined ? {} : { nonRetryable: tags(options.nonRetryable) })
})

const label = (options: Options): string => {
  const parts = [`attempts=${options.attempts}`]
  if (options.backoff !== undefined) {
    parts.push(`backoff=${options.backoff.initialMs}x${options.backoff.factor}<=${options.backoff.maxMs}`)
  }
  if (options.nonRetryable !== undefined) parts.push(`nonRetryable=${tags(options.nonRetryable).join("|")}`)
  return parts.join(", ")
}

const declaration = (inner: Flow.Any, options: Options): Flow.Any => {
  validate(options)
  const envelope = Decorate.envelopeOf(inner)
  return Flow.make(`withRetry(${Decorate.displayName(inner)}, ${label(options)})`, {
    ...(inner.description === undefined ? {} : { description: inner.description }),
    payload: inner.payloadSchema,
    success: inner.successSchema,
    error: inner.errorSchema,
    capabilities: Decorate.capabilitiesOf(inner),
    ...(envelope === undefined ? {} : { effects: envelope }),
    body: Node.capture(captures(options), (payload: unknown) => Decorate.call(inner, payload))
  })
}

/**
 * Builds a bounded retry decorator.
 *
 * The returned declaration preserves the wrapped flow's graph. Use
 * {@link retryEffect} at the Effect execution boundary; retry cannot be
 * truthfully encoded as a success-only `Node.andThen` chain.
 *
 * `make` snapshots the options at the call, so a later edit to the caller's
 * object does not change the decorator it returned.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): Pattern.Decorator => {
  const snapshot = copied(options)
  return (inner) => declaration(inner, snapshot)
}

/**
 * Wraps a flow in a declaration-identifiable retry decorator.
 *
 * @category combinators
 * @since 0.1.0
 */
export const withRetry = (inner: Flow.Any, options: Options): Flow.Any => Pattern.decorate(inner, make(options))

const ladder = (backoff: Backoff): Schedule.Schedule<Duration.Duration> =>
  Schedule.modifyDelay(
    Schedule.exponential(Duration.millis(backoff.initialMs), backoff.factor),
    ({ duration }) => Effect.succeed(Duration.millis(Math.min(Duration.toMillis(duration), backoff.maxMs)))
  )

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined

/**
 * Retries typed Effect failures up to the declared total attempt count,
 * waiting the declared backoff between attempts and stopping immediately on a
 * non-retryable tag.
 *
 * Effect schedules never recover fiber interruption, so cancellation
 * propagates without consuming or elaborating another attempt.
 *
 * @category combinators
 * @since 0.1.0
 */
export const retryEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  caller: Options
): Effect.Effect<A, E, R> => {
  const options = copied(caller)
  validate(options)
  const retryable = options.nonRetryable === undefined
    ? undefined
    : new Set(tags(options.nonRetryable))
  if (options.attempts === 1) return effect
  return Effect.retry(effect, {
    times: options.attempts - 1,
    ...(options.backoff === undefined ? {} : { schedule: ladder(options.backoff) }),
    ...(retryable === undefined ? {} : {
      while: (error: E) => {
        const tag = tagOf(error)
        return tag === undefined || !retryable.has(tag)
      }
    })
  })
}
