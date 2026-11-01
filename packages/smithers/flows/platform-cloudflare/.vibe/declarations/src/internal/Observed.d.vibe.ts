/**
 * Telemetry for an operation whose failure may quote a provider: its span
 * ends with the outcome alone, and only the failure's tag is recorded.
 *
 * @since 1.0.0-rc.17
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
/**
 * The stable name of what a cause failed with, for a log line or a span
 * attribute: an error's tag, never its message.
 *
 * @category telemetry
 * @since 1.0.0-rc.17
 */
export declare const failureType: (cause: Cause.Cause<unknown>) => string;
/**
 * Runs `effect` in a span named `span`, then records its outcome: the success
 * value, or `failed` with the failure's tag, as the span attribute
 * `attribute`, the counter `counter`'s `outcome`, and the log line `log`,
 * which also says how long it took (`durationMs`). The span ends with the
 * outcome alone; the failure is returned outside it, so a provider's error
 * text never reaches the exported span.
 *
 * @category telemetry
 * @since 1.0.0-rc.17
 */
export declare const observed: <A extends string, E, R>(effect: Effect.Effect<A, E, R>, options: {
    readonly span: string;
    readonly attributes: Record<string, unknown>;
    readonly attribute: string;
    readonly counter: Metric.Metric<number, Metric.CounterState<number>>;
    readonly log: string;
}) => Effect.Effect<A, E, R>;
