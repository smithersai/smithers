/**
 * Defines data-shaped retry policies for durable action retries.
 *
 * A `RetryPolicy` is a plain value — initial interval, backoff factor, cap,
 * optional maximum attempts, optional jitter, and optional non-retryable
 * error tags — so the next retry delay can be derived from a persisted
 * attempt count instead of fiber-local `Schedule` state. `nextDelay` mirrors
 * Temporal's `ExponentialRetryPolicy.ComputeNextDelay` formula, and `decide`
 * is the engine's single retry decision point: the core default a pluggable
 * `resolveRetry` resolution can later dispatch in front of.
 *
 * The historical terminal-failure schemas below use the `@smthrs/flow/` tags settled for
 * 1.0.0-rc.0. The release candidate makes no compatibility promise to 0.x
 * journals, and these tags freeze at the RC. Current action dispatch preserves
 * the final declared failure when a retry policy is spent.
 *
 * See `docs/guides/retry-a-failing-action.md`; its "Infrastructure
 * interrupts" section covers the interrupt retry schedule.
 *
 * @since 0.1.0
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
/**
 * Data-shaped retry policy schema. Decoding enforces the same relational
 * contract as {@link make}; persisted data cannot bypass constructor checks.
 *
 * @category models
 * @since 0.1.0
 */
export declare const RetryPolicy: Schema.Struct<{
    readonly initialMs: Schema.Number;
    readonly factor: Schema.Number;
    readonly maxMs: Schema.Number;
    readonly maxAttempts: Schema.optional<Schema.Number>;
    readonly expirationMs: Schema.optional<Schema.Number>;
    readonly jitterRatio: Schema.optional<Schema.Number>;
    readonly nonRetryable: Schema.optional<Schema.$Array<Schema.String>>;
    readonly retryable: Schema.optional<Schema.$Array<Schema.Struct<{
        readonly tag: Schema.String;
        readonly code: Schema.optional<Schema.String>;
    }>>>;
}>;
/**
 * The value form of a {@link RetryPolicy}.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryPolicy = typeof RetryPolicy.Type;
/**
 * Creates a `RetryPolicy` value after checking every numeric bound.
 * `initialMs` must be greater than zero: a zero initial interval would
 * compute a zero delay for every attempt, which {@link nextDelay} reads as
 * exhausted, so the policy would never retry. `jitterRatio` must be between
 * zero and one, inclusive, and `jitterRatio: 0` disables jitter.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (options: {
    readonly initialMs: number;
    readonly factor: number;
    readonly maxMs: number;
    readonly maxAttempts?: number | undefined;
    readonly expirationMs?: number | undefined;
    readonly jitterRatio?: number | undefined;
    readonly nonRetryable?: ReadonlyArray<string> | undefined;
    readonly retryable?: ReadonlyArray<{
        readonly tag: string;
        readonly code?: string | undefined;
    }> | undefined;
}) => RetryPolicy;
/**
 * The default engine retry policy.
 *
 * Uses a 200ms initial delay growing by 1.5x, capped at 30s, and never gives
 * up: it declares neither `maxAttempts` nor `expirationMs`. Bound long-lived
 * retries with `make({ ..., expirationMs })` when a wall-clock give-up is
 * required.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const defaultRetryPolicy: RetryPolicy;
/**
 * Bounded infrastructure retry: 5 seconds doubling to 5 minutes, for 2 hours.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const transient: RetryPolicy;
/**
 * A retry decision: wait `delayMs` before the next attempt.
 *
 * @category models
 * @since 0.1.0
 */
export interface RetryAfter {
    readonly _tag: "RetryAfter";
    readonly delayMs: number;
}
/**
 * A retry decision: stop retrying.
 *
 * @category models
 * @since 0.1.0
 */
export interface GiveUp {
    readonly _tag: "GiveUp";
    readonly reason: "nonRetryable" | "exhausted" | "expired";
}
/**
 * The outcome of the engine's retry decision point.
 *
 * @category models
 * @since 0.1.0
 */
export type RetryDecision = RetryAfter | GiveUp;
/**
 * Creates a `RetryAfter` decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const retryAfter: (delayMs: number) => RetryDecision;
/**
 * Creates a `GiveUp` decision.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const giveUp: (reason: GiveUp["reason"]) => RetryDecision;
declare const RetryPolicyExpired_base: Schema.Class<RetryPolicyExpired, Schema.TaggedStruct<"@smthrs/flow/RetryPolicyExpired", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"retry_policy_expired">>;
    readonly actionName: Schema.String;
    readonly attempt: Schema.Number;
    readonly expirationMs: Schema.Number;
    readonly lastError: Schema.optional<Schema.Unknown>;
}>, Cause.YieldableError>;
/**
 * A historical retry sequence crossed its `expirationMs` wall-clock bound.
 * Current dispatch preserves the final declared failure instead of emitting this defect.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class RetryPolicyExpired extends RetryPolicyExpired_base {
}
declare const RetryAttemptsExhausted_base: Schema.Class<RetryAttemptsExhausted, Schema.TaggedStruct<"@smthrs/flow/RetryAttemptsExhausted", {
    readonly code: Schema.withConstructorDefault<Schema.Literal<"retry_attempts_exhausted">>;
    readonly actionName: Schema.String;
    readonly attempt: Schema.Number;
    readonly maxAttempts: Schema.Number;
    readonly lastError: Schema.optional<Schema.Unknown>;
}>, Cause.YieldableError>;
/**
 * A historical retry sequence exhausted its `maxAttempts` bound.
 * Current dispatch preserves the final declared failure instead of emitting this defect.
 *
 * @category errors
 * @since 0.1.0
 */
export declare class RetryAttemptsExhausted extends RetryAttemptsExhausted_base {
}
/**
 * Computes the delay before attempt `attempt + 1` from the persisted attempt
 * count, mirroring Temporal's `ComputeNextDelay`
 * (`common/backoff/retrypolicy.go`).
 *
 * `attempt` is the 1-based attempt that just failed. Returns `None` when the
 * policy gives up: `maxAttempts` reached, a non-positive computed interval,
 * a cap below the initial interval, or — when the policy declares
 * `expirationMs` and the caller supplies `elapsedMs` — an elapsed duration
 * past the expiration bound. Otherwise the delay is capped to the remaining
 * expiration window, expiring only when that window cannot fit the smaller of the
 * initial interval and the computed interval.
 *
 * Jitter is deterministic-friendly: `options.random` is a `[0, 1]` sample
 * supplied by the caller and defaults to `1`, which leaves the delay at its
 * un-jittered value. Use {@link nextDelayEffect} to sample the `Random`
 * service instead. A sample outside `[0, 1]`, or a persisted `jitterRatio`
 * above one, gives up rather than returning a delay the policy never
 * declared. A sample of zero under `jitterRatio: 1` is a delay of zero, which
 * retries immediately.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const nextDelay: (policy: RetryPolicy, attempt: number, options?: {
    readonly random?: number | undefined;
    readonly elapsedMs?: number | undefined;
}) => Option.Option<number>;
/**
 * Computes the next retry delay, sampling the `Random` service for jitter.
 *
 * Deterministic under `Random.withSeed`. Policies without a `jitterRatio`
 * never touch the service.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const nextDelayEffect: (policy: RetryPolicy, attempt: number, options?: {
    readonly elapsedMs?: number | undefined;
}) => Effect.Effect<Option.Option<number>>;
/**
 * Extracts the stable identity tag of an error for non-retryable matching:
 * an own string `_tag` when present, otherwise the first own `name` descriptor
 * found while walking a bounded prototype chain. That first descriptor decides
 * the result: only a string data value is a tag.
 *
 * Descriptors keep accessors inert instead of running author code through a
 * property read. A bounded walk also terminates when a hostile proxy reports a
 * cyclic prototype chain; any proxy trap that throws leaves the error untagged.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const errorTag: (error: unknown) => string | undefined;
/**
 * Classifies a cause for host diagnostics using only its squashed error's
 * stable tag or name, falling back to `unknown` when neither is available.
 * Messages, stacks and other payload fields are never included.
 *
 * @category attempts
 * @since 1.0.0
 */
export declare const failureType: (cause: Cause.Cause<unknown>) => string;
/**
 * Error tags that are non-retryable by type, under every policy (issue #156).
 *
 * These failures are integrity verdicts that must reach the driver without an
 * action-level retry hiding the first detection. Their persistence seams
 * take a quarantine state action before raising them, so a later dispatch can
 * heal, but the detecting dispatch remains a non-retryable failure. No
 * per-callsite or per-policy opt-out exists; the tags are matched by string so
 * the classification does not invert the package dependency direction.
 *
 * `AttemptEvidenceQuarantined` (issue #171) is the succeeded-attempt-row
 * counterpart: the corrupt boundary evidence is removed while the completed
 * outcome stays durable. It reaches the driver unretried, which parks the
 * first detection in the `quarantine` waiting state; the next explicit resume
 * returns the recorded outcome without re-executing the action.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const defaultNonRetryable: ReadonlyArray<string>;
/**
 * Whether an error is classified non-retryable: by type (see
 * {@link defaultNonRetryable}), by the policy's `nonRetryable` tags, or, when
 * the policy declares `retryable`, by matching none of its entries. An entry
 * matches an error with its tag and, when the entry names one, its `code`.
 * Without `retryable`, an error the first two do not name retries.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const isNonRetryable: (policy: RetryPolicy, error: unknown) => boolean;
/**
 * The pure core of the engine's single retry decision point.
 *
 * Non-retryable classification is evaluated here and nowhere else. This is
 * the default a pluggable `resolveRetry` resolution falls back to when no
 * plugin claims the decision.
 *
 * A failure that carries its own `retryAfterMillis`, a finite non-negative
 * number of milliseconds such as a provider's `Retry-After` on a
 * `ModelError`, retries after that delay instead of the policy's backoff,
 * capped by `maxMs` and by what remains of `expirationMs`.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const decide: (policy: RetryPolicy, options: {
    readonly attempt: number;
    readonly error: unknown;
    readonly random?: number | undefined;
    readonly elapsedMs?: number | undefined;
}) => RetryDecision;
/**
 * Effect form of {@link decide}, sampling the `Random` service for jitter.
 *
 * This is the engine-facing decision function: keep calls to it behind a
 * single decision point so a plugin hook dispatch can later be inserted in
 * front of it without touching call sites.
 *
 * @category attempts
 * @since 0.1.0
 */
export declare const decideEffect: (policy: RetryPolicy, options: {
    readonly attempt: number;
    readonly error: unknown;
    readonly elapsedMs?: number | undefined;
}) => Effect.Effect<RetryDecision>;
/**
 * The engine's retry decision as an Effect `Schedule`, for work that no
 * durable step can hold because it is bound to its caller's scope, such as a
 * connection a page keeps open: `Effect.retry` and `Stream.retry` take it.
 *
 * Each failure is the schedule's input and is decided by {@link decideEffect},
 * as the engine decides an action's: the schedule waits the decided delay, or
 * ends when the policy gives up, so the retry fails with that failure. Its
 * output is the attempt that just failed, one for the first. `elapsedMs`
 * counts from the first failure. Nothing is persisted: the count lives as
 * long as the retry, and `Stream.retry` starts it over once the stream emits
 * again.
 *
 * @category attempts
 * @since 1.0.0
 */
export declare const schedule: <E>(policy: RetryPolicy) => Schedule.Schedule<number, E>;
export {};
