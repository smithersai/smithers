/**
 * Retries effects while preserving durable action identity.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
/**
 * Retries an effect with `Effect.retry` while updating `CurrentAttempt` for
 * each attempt.
 *
 * @category error handling
 * @since 0.1.0
 */
export declare const retry: {
    <E, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(options: O): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Retry.Return<R, E, A, O>;
    <A, E, R, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(self: Effect.Effect<A, E, R>, options: O): Effect.Retry.Return<R, E, A, O>;
};
