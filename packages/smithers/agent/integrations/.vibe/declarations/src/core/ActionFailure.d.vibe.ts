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
import { RetryPolicy } from "@smthrs/flow";
import { Schema } from "effect";
import { IntegrationError } from "../../../../src/core/IntegrationError.ts";
/**
 * The classification, as a schema.
 *
 * Built from `IntegrationError`'s own reason list, so a reason added there is
 * decodable here without a second edit.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Reason: Schema.Literals<readonly ["invalid-config", "invalid-signature", "decode-failed", "poll-failed", "delivery-failed", "credentials-missing", "permission-denied", "listener-conflict", "rate-limited"]>;
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
export declare const isMessageId: (value: unknown) => value is number;
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
export declare const MessageId: Schema.Number;
/**
 * Whether `value` is a wait the engine can honor: a non-negative safe integer
 * number of milliseconds.
 *
 * @category refinements
 * @since 1.0.0
 */
export declare const isRetryAfterMillis: (value: unknown) => value is number;
/**
 * A server-named wait, as a schema: the rule {@link isRetryAfterMillis}
 * applies, enforced again when a journal row is decoded.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const RetryAfterMillis: Schema.Number;
/**
 * The tag of {@link IntegrationFailure}, which a retry policy lists in
 * `nonRetryable`.
 *
 * @category constants
 * @since 1.0.0
 */
export declare const integrationFailureTag = "/integrations/IntegrationFailure";
declare const IntegrationFailure_base: Schema.Class<IntegrationFailure, Schema.TaggedStruct<"/integrations/IntegrationFailure", {
    reason: Schema.Literals<readonly ["invalid-config", "invalid-signature", "decode-failed", "poll-failed", "delivery-failed", "credentials-missing", "permission-denied", "listener-conflict", "rate-limited"]>;
    message: Schema.String;
    /** Whether another attempt could clear it. True exactly for a {@link RetryableIntegrationFailure}. */
    retryable: Schema.Boolean;
    /**
     * The write may already have been applied.
     *
     * Set when a provider lost the answer to a POST, PATCH, PUT, DELETE, or
     * GraphQL mutation. It is the difference between "this did not happen" and
     * "nobody knows", and an operator deciding whether to run the step again
     * needs it, so it crosses the journal rather than living only on the
     * client error.
     */
    outcomeUnknown: Schema.optional<Schema.Boolean>;
    /**
     * What a partially completed step already delivered.
     *
     * An external send over the length limit is several messages inside one
     * step. When it fails partway through, these are the ids the chat already
     * shows, so a resend decision is made against what the reader has rather
     * than against a guess.
     */
    deliveredMessageIds: Schema.optional<Schema.$Array<Schema.Number>>;
    /**
     * How long the server asked to wait before another attempt: its
     * `Retry-After`, or for a rate limit its `x-ratelimit-reset`, capped at one
     * minute. The engine's `RetryPolicy.decide` reads this field under this name
     * and waits it instead of the policy's backoff, capped by the policy's
     * `maxMs`.
     */
    retryAfterMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
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
export declare class IntegrationFailure extends IntegrationFailure_base {
}
declare const RetryableIntegrationFailure_base: Schema.Class<RetryableIntegrationFailure, Schema.TaggedStruct<"/integrations/RetryableIntegrationFailure", {
    reason: Schema.Literals<readonly ["invalid-config", "invalid-signature", "decode-failed", "poll-failed", "delivery-failed", "credentials-missing", "permission-denied", "listener-conflict", "rate-limited"]>;
    message: Schema.String;
    /** Whether another attempt could clear it. True exactly for a {@link RetryableIntegrationFailure}. */
    retryable: Schema.Boolean;
    /**
     * The write may already have been applied.
     *
     * Set when a provider lost the answer to a POST, PATCH, PUT, DELETE, or
     * GraphQL mutation. It is the difference between "this did not happen" and
     * "nobody knows", and an operator deciding whether to run the step again
     * needs it, so it crosses the journal rather than living only on the
     * client error.
     */
    outcomeUnknown: Schema.optional<Schema.Boolean>;
    /**
     * What a partially completed step already delivered.
     *
     * An external send over the length limit is several messages inside one
     * step. When it fails partway through, these are the ids the chat already
     * shows, so a resend decision is made against what the reader has rather
     * than against a guess.
     */
    deliveredMessageIds: Schema.optional<Schema.$Array<Schema.Number>>;
    /**
     * How long the server asked to wait before another attempt: its
     * `Retry-After`, or for a rate limit its `x-ratelimit-reset`, capped at one
     * minute. The engine's `RetryPolicy.decide` reads this field under this name
     * and waits it instead of the policy's backoff, capped by the policy's
     * `maxMs`.
     */
    retryAfterMillis: Schema.optional<Schema.Number>;
}>, import("effect/Cause").YieldableError>;
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
export declare class RetryableIntegrationFailure extends RetryableIntegrationFailure_base {
}
/**
 * Every failure an integration action reports: the schema its `error` declares.
 *
 * @category schemas
 * @since 1.0.0
 */
export declare const Failure: Schema.Union<readonly [typeof IntegrationFailure, typeof RetryableIntegrationFailure]>;
/**
 * The decoded form of {@link Failure}.
 *
 * @category models
 * @since 1.0.0
 */
export type Failure = IntegrationFailure | RetryableIntegrationFailure;
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
export declare const retryPolicy: RetryPolicy.RetryPolicy;
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
export declare const MAX_MESSAGE_LENGTH = 512;
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
    readonly reconciles?: boolean | undefined;
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
export declare const fromIntegrationError: (error: unknown, options?: ConversionOptions) => Failure;
/**
 * Converts the schema-backed form back into a client failure.
 *
 * A caller that catches an action failure and wants the class back, to reuse
 * {@link isRetryable} or the control-plane mappings, gets it here.
 *
 * @category conversions
 * @since 1.0.0
 */
export declare const toIntegrationError: (failure: Failure) => IntegrationError;
export {};
