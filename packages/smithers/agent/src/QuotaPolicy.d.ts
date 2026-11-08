/**
 * Quota-aware waits: turning a provider's refusal into a deadline the run waits
 * out, rather than a failure that ends it.
 *
 * A `rate_limited` or `quota_exceeded` answer is not a defect report. It is the
 * provider telling the caller when to come back, and the difference matters to
 * every long run: a step that fails on a refusal loses everything the run had
 * done, while a step that waits keeps it and costs the operator nothing but
 * clock. Old smithers made that distinction with `classifyQuotaError` and a
 * `waiting-quota` park, and excluded a parked attempt from the retry budget on
 * the grounds that waiting for a window is not a failed attempt.
 *
 * This module is the classification half. It answers one question — "is this
 * refusal a wait, and until when?" — and nothing else: the park itself belongs
 * to `AgentAction`, which is the only place that knows it is inside a flow with
 * a durable clock to sleep on.
 *
 * Four things decide the deadline, in order of how much the provider actually
 * said:
 *
 * 1. `resetAtEpochMillis`, the instant the provider named;
 * 2. `retryAfterMillis`, the delay it named;
 * 3. a delay parsed out of the message text, for the providers that put it
 *    only there;
 * 4. and {@link Config.defaultWaitMillis}, when the refusal names nothing.
 *
 * {@link Config.maxWaitMillis} is the ceiling. Above it the classifier answers
 * `None` and the original `ModelError` propagates, because a run that parks for
 * a day is indistinguishable from a run that hung, and an operator who wants
 * that wait can declare it.
 *
 * The service is injected rather than assumed. A composition that wants every
 * refusal to stay a failure must say so explicitly with
 * {@link layerUnclassified}; omitting the decision is a type error.
 *
 * @since 0.1.0
 */
import { ModelError } from "@smthrs/model/ModelError";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
/**
 * Where a park's deadline came from.
 *
 * Journaled with the park, because the four sources are worth very different
 * amounts of trust: `reset` and `retry-after` are the provider's own numbers,
 * `text` is this module reading prose, and `default` is a guess bounded by
 * configuration. An operator reading a run that waited an hour needs to know
 * which one it was.
 *
 * @category models
 * @since 0.1.0
 */
export declare const ParkSource: Schema.Literals<readonly ["reset", "retry-after", "text", "default"]>;
/**
 * Where a park's deadline came from.
 *
 * @category models
 * @since 0.1.0
 */
export type ParkSource = typeof ParkSource.Type;
/**
 * One classified refusal: when to ask again, and on whose authority.
 *
 * It is a schema and not just an interface because the decision is RECORDED: a
 * park is computed from the wall clock, and a replayed body must wait out the
 * deadline the first pass chose rather than compute a new one from the instant
 * the replay happens to run at.
 *
 * @category models
 * @since 0.1.0
 */
export declare const Park: Schema.Struct<{
    /** The absolute epoch instant the run may ask again. */
    readonly wakeAt: Schema.Number;
    readonly source: Schema.Literals<readonly ["reset", "retry-after", "text", "default"]>;
}>;
/**
 * One classified refusal.
 *
 * @category models
 * @since 0.1.0
 */
export type Park = typeof Park.Type;
/**
 * Decides whether a failure is a quota wait.
 *
 * `now` is passed in rather than read: the classifier is pure, so a caller
 * inside a flow takes the instant from the injected clock and a test states it
 * outright.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
    /** @throws {never} */
    readonly classify: (error: unknown, nowMillis: number) => Option.Option<Park>;
}
declare const QuotaClassifier_base: Context.ServiceClass<QuotaClassifier, "@smthrs/agent/QuotaPolicy/QuotaClassifier", Service>;
/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export declare class QuotaClassifier extends QuotaClassifier_base {
}
/**
 * How long a refusal that names no deadline parks for.
 *
 * A minute: long enough that a run is not re-asking into a window that is
 * still closed, short enough that a wrong guess costs a minute.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const defaultWaitMillis = 60000;
/**
 * The longest wait a refusal may buy before it stays a failure.
 *
 * An hour. Above it the answer is not "wait" but "this run cannot proceed
 * today", and that is a decision for whoever is watching the run rather than
 * for the step.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const maxWaitMillis = 3600000;
/**
 * What a composition may change about the default classification.
 *
 * @category models
 * @since 0.1.0
 */
export interface Config {
    /** A non-finite fallback deadline cannot park. */
    readonly defaultWaitMillis?: number | undefined;
    /** NaN refuses parking because no maximum can be enforced. */
    readonly maxWaitMillis?: number | undefined;
}
/**
 * Builds a classifier from an implementation of its one method.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const make: (implementation: Service) => Service;
/**
 * A classifier that classifies nothing, so every refusal stays a failure.
 *
 * This is an explicit safety-policy decision, not a default. It gives up
 * durable quota parking: provider refusals fail the run immediately. The
 * recorder's independent capacity-refusal floor still prevents those failures
 * from becoming durable values.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const makeUnclassified: () => Service;
/**
 * Explicitly provides {@link makeUnclassified}.
 *
 * This gives up durable quota parking. It does not permit quota or overload
 * failures to enter the sealed step cache.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerUnclassified: () => Layer.Layer<QuotaClassifier>;
/**
 * The delay a refusal's message names, in milliseconds.
 *
 * `undefined` means the text named none, which is not the same as naming zero:
 * a caller falls back to its configured default rather than asking again
 * immediately.
 *
 * @category classification
 * @since 0.1.0
 * @throws {never}
 */
export declare const parseDelay: (message: string) => number | undefined;
export { isTerminalRefusal } from "@smthrs/model/ModelError";
/**
 * The `ModelError` a failure is, or wraps.
 *
 * A refusal reaches a model-backed step already wrapped: the cell controller
 * turns anything that is not a `HarnessError` into one with the original in
 * `cause`, so the classification has to look through that layer. It walks the
 * `cause` chain rather than checking one level, and it accepts a plain object
 * with the right shape as well as a class instance, because a failure that has
 * been through a journal round trip is decoded, not reconstructed.
 *
 * @category classification
 * @since 0.1.0
 * @throws {never}
 */
export declare const modelErrorOf: (error: unknown) => Option.Option<ModelError>;
/**
 * The production classifier.
 *
 * @category constructors
 * @since 0.1.0
 * @throws {never}
 */
export declare const makeDefault: (config?: Config) => Service;
/**
 * Provides {@link makeDefault}.
 *
 * @category layers
 * @since 0.1.0
 */
export declare const layerDefault: (config?: Config) => Layer.Layer<QuotaClassifier>;
/**
 * The journal event one park writes.
 *
 * @category records
 * @since 0.1.0
 */
export declare const quotaParkedEvent = "flows.agent.quota-parked.v1";
/**
 * The most times one step parks before its refusal is reported.
 *
 * A window that has reopened and closed again eight times over one step is not
 * a window this run is going to get through, and an unbounded park loop is a
 * run that never ends. The bound is per ask, so a step that parks, answers, and
 * is corrected starts again from zero.
 *
 * @category constants
 * @since 0.1.0
 */
export declare const defaultMaxParks = 8;
/**
 * Reads the classifier a composition explicitly provided.
 *
 * There is deliberately no fallback. Every production composition must choose
 * quota parking or explicitly choose {@link layerUnclassified}.
 *
 * @category accessors
 * @since 0.1.0
 */
export declare const current: Effect.Effect<Service, never, QuotaClassifier>;
