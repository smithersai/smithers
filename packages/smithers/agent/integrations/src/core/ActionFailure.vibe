/**
 * The failure a durable action reports.
 *
 * {@link IntegrationError} is a class. A durable action has to write its
 * failure to the journal and read it back after a restart, so the action
 * boundary needs a schema instead. {@link Failure} is that schema: the reason,
 * a message already safe to persist, whether another attempt could clear it,
 * and how long the server asked to wait first. Nothing else crosses, because
 * nothing else in an `IntegrationError` survives encoding.
 *
 * The flow engine makes every retry decision, and it reads two things off a
 * failure: its tag, against the retry policy's `nonRetryable` list, and an own
 * `retryAfterMillis`, which replaces the policy's backoff. So the
 * classification crosses as exactly those two. A failure another attempt may
 * clear is a {@link RetryableIntegrationFailure}, carrying the server's wait
 * when it named one; every other failure is an {@link IntegrationFailure}, which
 * a write-back action's retry policy lists as non-retryable. The client decides
 * which, once; the engine only reads the tag.
 *
 * @since 1.0.0
 */

import { RetryPolicy } from "@smthrs/flow"
import { Schema } from "effect"
import { IntegrationError, isIntegrationError, isReason, reasons } from "./IntegrationError.ts"

/**
 * The classification, as a schema.
 *
 * Built from `IntegrationError`'s own reason list, so a reason added there is
 * decodable here without a second edit.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Reason = Schema.Literals(reasons)

/**
 * Whether `value` is a provider message id.
 *
 * The clients only ever record a positive safe integer, so anything else in a
 * `deliveredMessageIds` list came from a forged or foreign error. Exported
 * because a provider refinement has to agree with the conversion about what
 * a delivered id is: a list one accepts and the other rejects is how a throw
 * gets back into `Effect.mapError`.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isMessageId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0

/**
 * A provider message id, as a schema.
 *
 * The same rule {@link isMessageId} applies, at the journal boundary. A row is
 * data on disk that a later process decodes, so the field's documented type has
 * to be enforced on the way back in as well as on the way out: without this a
 * corrupt row hands a caller a "message id" of NaN, which is what
 * `Schema.Number` decodes the string "NaN" to.
 *
 * @category schemas
 * @since 1.0.0
 */
export const MessageId = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * Whether `value` is a wait the engine can honor: a non-negative safe integer
 * number of milliseconds.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isRetryAfterMillis = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/**
 * A server-named wait, as a schema: the rule {@link isRetryAfterMillis}
 * applies, enforced again when a journal row is decoded.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RetryAfterMillis = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const fields = {
  reason: Reason,
  message: Schema.String,
  /** Whether another attempt could clear it. True exactly for a {@link RetryableIntegrationFailure}. */
  retryable: Schema.Boolean,
  /**
   * The write may already have been applied.
   *
   * Set when a provider lost the answer to a POST, PATCH, PUT, DELETE, or
   * GraphQL mutation. It is the difference between "this did not happen" and
   * "nobody knows", and an operator deciding whether to run the step again
   * needs it, so it crosses the journal rather than living only on the
   * client error.
   */
  outcomeUnknown: Schema.optional(Schema.Boolean),
  /**
   * What a partially completed step already delivered.
   *
   * An external send over the length limit is several messages inside one
   * step. When it fails partway through, these are the ids the chat already
   * shows, so a resend decision is made against what the reader has rather
   * than against a guess.
   */
  deliveredMessageIds: Schema.optional(Schema.Array(MessageId)),
  /**
   * How long the server asked to wait before another attempt: its
   * `Retry-After`, or for a rate limit its `x-ratelimit-reset`, capped at one
   * minute. The engine's `RetryPolicy.decide` reads this field under this name
   * and waits it instead of the policy's backoff, capped by the policy's
   * `maxMs`.
   */
  retryAfterMillis: Schema.optional(RetryAfterMillis)
}

/**
 * The tag of {@link IntegrationFailure}, which a retry policy lists in
 * `nonRetryable`.
 *
 * @category constants
 * @since 1.0.0
 */
export const integrationFailureTag = "/integrations/IntegrationFailure"

/**
 * A provider failure another attempt cannot clear, in the form a durable
 * action encodes.
 *
 * A refusal (a 404, a 422, a revoked credential), a decode failure, a
 * configuration error, and a write whose outcome is unknown to a step that
 * cannot reconcile it. A write-back action's retry policy lists its tag as
 * non-retryable, so the engine reports it at once.
 *
 * @category errors
 * @since 1.0.0
 */
export class IntegrationFailure extends Schema.TaggedError<IntegrationFailure>()(integrationFailureTag, fields) {}

/**
 * A provider failure another attempt may clear: a rate limit, a 5xx or a lost
 * connection on a request that is safe to repeat, or a lost write in a step
 * that reads before it writes. The engine's retry policy repeats it, waiting
 * {@link RetryableIntegrationFailure.retryAfterMillis} when the server named a
 * wait. A step whose attempts run out reports the last one.
 *
 * @category errors
 * @since 1.0.0
 */
export class RetryableIntegrationFailure extends Schema.TaggedError<RetryableIntegrationFailure>()(
  "/integrations/RetryableIntegrationFailure",
  fields
) {}

/**
 * Every failure an integration action reports: the schema its `error` declares.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Failure = Schema.Union([IntegrationFailure, RetryableIntegrationFailure])

/**
 * The decoded form of {@link Failure}.
 *
 * @category models
 * @since 1.0.0
 */
export type Failure = IntegrationFailure | RetryableIntegrationFailure

/**
 * The retry policy for a durable step that calls this package's clients, and
 * the only retry such a call gets: the clients never repeat a request.
 *
 * At most three attempts. Between them the engine waits half a second, then a
 * second, or the `retryAfterMillis` the server named, up to a minute. An
 * {@link IntegrationFailure} is never repeated. The attempt count is durable,
 * so a process that dies between attempts resumes on the next one. A step
 * declares it beside `error: Failure` and maps its client errors with
 * {@link fromIntegrationError}; the GitHub write-back actions do exactly that.
 *
 * @category constants
 * @since 1.0.0
 */
export const retryPolicy: RetryPolicy.RetryPolicy = RetryPolicy.make({
  initialMs: 500,
  factor: 2,
  maxMs: 60_000,
  maxAttempts: 3,
  nonRetryable: [integrationFailureTag]
})

/**
 * The longest provider text a failure persists.
 *
 * The message is journaled, so an unbounded provider description would be
 * written to the run database on every failed attempt. The cap is generous
 * enough for any classification a caller reads and short enough that the
 * journal row stays a row.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_MESSAGE_LENGTH = 512

const capped = (message: string): string =>
  message.length <= MAX_MESSAGE_LENGTH ? message : `${message.slice(0, MAX_MESSAGE_LENGTH - 1)}…`

/**
 * What a value that cannot describe itself is journaled as.
 *
 * `String(value)` is not total: a null-prototype object has no `toString`, and
 * a `toString` a caller wrote can throw. Neither may take down the conversion.
 */
const UNDESCRIBABLE = "an integration failure that cannot be described"

/**
 * The persisted text for a failure that is not an {@link IntegrationError}.
 *
 * `summary` rather than `message`, because `SmithersError` appends its
 * documentation URL to `message` and the other providers journal the summary.
 * Reading the same field everywhere keeps one failed send from looking
 * different depending on which client raised it.
 *
 * Every read here runs on a value from outside this package, so every read is
 * guarded: a `summary` getter is caller code, and stringifying an arbitrary
 * object runs its `toString`.
 */
const fallbackMessage = (error: unknown): string => {
  try {
    if (typeof error === "object" && error !== null && "summary" in error) {
      const summary = (error as { readonly summary?: unknown }).summary
      if (typeof summary === "string") return summary
    }
    if (error instanceof Error) return typeof error.message === "string" ? error.message : UNDESCRIBABLE
    return String(error)
  } catch {
    return UNDESCRIBABLE
  }
}

/**
 * What {@link fromIntegrationError} needs to know about the step.
 *
 * @category models
 * @since 1.0.0
 */
export interface ConversionOptions {
  /**
   * The step reads before it writes, so repeating it after a lost write finds
   * that write rather than making it twice. A failure whose outcome is unknown
   * is then retryable at the step, though the request alone was not.
   */
  readonly reconciles?: boolean | undefined
}

/**
 * Converts a client failure into the schema-backed form.
 *
 * A retryable failure, or a lost write in a step that `reconciles`, becomes a
 * {@link RetryableIntegrationFailure} carrying the server's `retryAfterMillis`;
 * anything else becomes an {@link IntegrationFailure}.
 *
 * A failure that is not an {@link IntegrationError} came from outside the
 * clients, so it is reported as a non-retryable `delivery-failed` rather than
 * guessed at. The conversion is total: an error that only claims the
 * `IntegrationError` name, one that is a real `IntegrationError` but carries a
 * reason or summary this build cannot encode, and a value that cannot even be
 * stringified all take the unclassified branch rather than failing schema
 * validation inside `Effect.mapError`, where the throw would become a defect.
 * Reads after the refinement are guarded too, because a getter can pass one
 * read and throw on the next.
 *
 * @category conversions
 * @since 1.0.0
 */
export const fromIntegrationError = (error: unknown, options?: ConversionOptions): Failure => {
  const unclassified = (): IntegrationFailure =>
    new IntegrationFailure({
      reason: "delivery-failed",
      message: capped(fallbackMessage(error)),
      retryable: false
    })

  // `instanceof` is not enough on its own. `reason` and `summary` are typed but
  // never validated, so a real `IntegrationError` built by a JavaScript caller
  // can carry a reason `Reason` refuses, which the failure then throws on at
  // construction.
  try {
    if (!isIntegrationError(error)) return unclassified()
    const reason = error.reason
    const summary = error.summary
    const details = error.details
    if (!isReason(reason) || typeof summary !== "string") return unclassified()
    const outcomeUnknown = details?.["outcomeUnknown"] === true
    const retryable = details?.["retryable"] === true || (options?.reconciles === true && outcomeUnknown)
    const delivered = details?.["deliveredMessageIds"]
    const wait = details?.["retryAfterMillis"]
    const failure = {
      reason,
      message: capped(summary),
      retryable,
      ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
      // Only when there is something to say, and only when every member really
      // is a message id. An empty list on every failure is noise in a row that
      // is written on every failed attempt, and `Schema.Number` encodes a
      // non-finite member as the string "NaN", so a row claiming a message id of
      // NaN is worse than one claiming none.
      ...(Array.isArray(delivered) && delivered.length > 0 && delivered.every(isMessageId)
        ? { deliveredMessageIds: delivered }
        : {}),
      ...(retryable && isRetryAfterMillis(wait) ? { retryAfterMillis: wait } : {})
    }
    return retryable ? new RetryableIntegrationFailure(failure) : new IntegrationFailure(failure)
  } catch {
    return unclassified()
  }
}

/**
 * Converts the schema-backed form back into a client failure.
 *
 * A caller that catches an action failure and wants the class back, to reuse
 * {@link isRetryable} or the control-plane mappings, gets it here.
 *
 * @category conversions
 * @since 1.0.0
 */
export const toIntegrationError = (failure: Failure): IntegrationError =>
  new IntegrationError(failure.reason, failure.message, {
    retryable: failure.retryable,
    ...(failure.outcomeUnknown === undefined ? {} : { outcomeUnknown: failure.outcomeUnknown }),
    ...(failure.deliveredMessageIds === undefined ? {} : { deliveredMessageIds: failure.deliveredMessageIds }),
    ...(failure.retryAfterMillis === undefined ? {} : { retryAfterMillis: failure.retryAfterMillis })
  })
