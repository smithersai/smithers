/**
 * Durable timers for flow sleeps.
 *
 * `make` creates a `DurableClock` with a name, duration, and deferred wake-up
 * signal. `sleep` ignores zero durations, runs short sleeps through an
 * in-memory action, and schedules longer sleeps through the `FlowRuntime`
 * before awaiting the durable deferred tied to the clock.
 *
 * @since 0.1.0
 */
import type { Crypto } from "@smthrs/crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as DurableDeferred from "./DurableDeferred.vibe";
import { FlowInstance } from "./FlowRuntime/FlowInstance.vibe";
import { FlowRuntime } from "./FlowRuntime/FlowRuntime.vibe";
declare const TypeId = "@smthrs/flow/DurableClock";
/**
 * Represents a durable flow timer with a name, duration, and deferred
 * completed when the timer wakes.
 *
 * @category models
 * @since 0.1.0
 */
export interface DurableClock {
    readonly [TypeId]: typeof TypeId;
    readonly name: string;
    readonly duration: Duration.Duration;
    readonly deferred: DurableDeferred.DurableDeferred<typeof Schema.Void>;
}
/**
 * Declares one durable clock after validating its finite nonnegative duration.
 *
 * Throws a `RangeError` for a malformed, infinite or negative duration, or one
 * longer than `Number.MAX_SAFE_INTEGER` milliseconds: a durable store records
 * a clock's due time as a safe integer.
 *
 * @category constructors
 * @since 0.1.0
 */
export declare const make: (options: {
    readonly name: string;
    readonly duration: Duration.Input;
}) => DurableClock;
/**
 * Waits inside a flow, using an in-memory action for durations at or
 * below the threshold and scheduling a durable clock for longer durations.
 *
 * Throws a `RangeError` for the same durations {@link make} refuses, and for
 * a malformed, infinite or negative threshold. A durable sleep that would
 * wake after epoch millisecond `Number.MAX_SAFE_INTEGER` dies with a
 * `RangeError` instead of arming its clock.
 *
 * @category sleeping
 * @since 0.1.0
 */
export declare const sleep: (options: {
    readonly name: string;
    readonly duration: Duration.Input;
    /**
     * If the duration is less than or equal to this threshold, the clock will
     * be executed in memory.
     *
     * @default 60 seconds
     */
    readonly inMemoryThreshold?: Duration.Input | undefined;
}) => Effect.Effect<void, never, Crypto.Crypto | FlowRuntime | FlowInstance>;
export {};
