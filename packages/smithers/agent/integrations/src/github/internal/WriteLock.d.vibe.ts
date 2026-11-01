/**
 * Process-local admission for a keyed GitHub read-and-write sequence.
 * @since 1.0.0
 */
import { Effect } from "effect";
/**
 * Waiters count as users, so cancellation never replaces an occupied gate.
 * @since 1.0.0
 * @category concurrency
 */
export declare const withWriteLock: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
