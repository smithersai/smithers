/**
 * The stopwatch of one model call.
 *
 * A route starts one when a call starts and marks each stage as it passes;
 * the reading is the `ModelEvent.Timing` the call's settle event carries. It
 * reads Effect's `Clock`, so a test clock controls every value, and it reads
 * it through the clock's synchronous accessor: a call emits thousands of
 * deltas, and the last one is only known to be the last after the fact, so
 * each is timed as it passes.
 *
 * A stage that was never marked is absent from the reading. Nothing here
 * estimates one.
 *
 * @since 1.0.0
 * @internal
 */
import type * as Clock from "effect/Clock";
import type { ModelEvent, Timing } from "../ModelEvent.js";
import type * as RequestExecutor from "../RequestExecutor.js";
/**
 * One call's stopwatch: a mark per stage, and the reading so far.
 *
 * @category models
 * @since 1.0.0
 */
export interface CallTiming {
    /** The request was validated and encoded to the bytes that are sent. */
    readonly prepared: (requestBytes: number) => void;
    /** The credential was resolved and the request signed. */
    readonly signed: () => void;
    /** An HTTP try left, or failed; see `RequestExecutor.TryEvent`. */
    readonly onTry: (event: RequestExecutor.TryEvent) => void;
    /** The response status and headers arrived. */
    readonly headers: () => void;
    /** A framed provider event arrived. */
    readonly frame: () => void;
    /** A normalized event left the protocol. */
    readonly event: (event: ModelEvent) => void;
    /** The response stream closed; the first mark stands. */
    readonly closed: () => void;
    /** What has been marked so far. */
    readonly read: () => Timing;
}
/**
 * Starts the stopwatch: `clock` now is the instant every offset counts from.
 *
 * @category constructors
 * @since 1.0.0
 */
export declare const start: (clock: Clock.Clock) => CallTiming;
/**
 * A reading as span attributes, `smithers.model.<stage>` in snake case:
 * `smithers.model.headers_ms`, `smithers.model.first_output_ms`. The failed
 * tries are their codes in order, `smithers.model.failed_tries`. The start
 * instant is left out: a span has its own.
 *
 * @category conversions
 * @since 1.0.0
 */
export declare const attributes: (timing: Timing) => Record<string, unknown>;
