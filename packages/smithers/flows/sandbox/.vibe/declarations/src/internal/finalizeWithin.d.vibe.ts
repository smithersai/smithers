/**
 * Bounds provider cleanup independently of the caller's clock.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect";
/**
 * Gives one cleanup operation five seconds, then warns with its resource name.
 * Observe a detached fiber: racing the operation itself would await its
 * interruption, including any uninterruptible transport acquisition or release.
 * Interruption is requested without waiting when observation ends.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const finalizeWithin: <R>(cleanup: Effect.Effect<void, never, R>, resource: string) => Effect.Effect<void, never, R>;
