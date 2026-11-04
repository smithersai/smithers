/**
 * Span failures with their text withheld.
 *
 * An OTLP exporter writes a failed span's error into the span's status message
 * and its `exception` event: the error's name, message and stack. A failure's
 * message is often someone else's text: a model provider's error can quote a
 * prompt or a credential, and a defect carries its own message and stack. A
 * span that ends through {@link tracer} or {@link withSpan} gives the exporter
 * a stand-in for each failure instead: the failure's tag, or else its class
 * name, and its `code` when the failure is tagged and the code is a lowercase
 * token. A stand-in's stack is that one line plus the source locations Effect
 * recorded for the span, never the original's.
 *
 * Only the span's copy changes. The failure itself reaches the caller as it
 * was raised, so a caller still reads the original message and branches on
 * the same error.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
/**
 * An exit as a span records it: every failure and defect replaced by its
 * stand-in, each keeping the annotations Effect recorded for it. A success
 * and an interruption pass unchanged.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const exit: <A, E>(result: Exit.Exit<A, E>) => Exit.Exit<A, unknown>;
/**
 * The caller's tracer, with every span it opens ending on {@link exit} of
 * the exit it is given. Wrapping it again returns it unchanged.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const tracer: (inner: Tracer.Tracer) => Tracer.Tracer;
/**
 * Runs an effect on {@link tracer}, so every span it opens, including the
 * one a traced function opens around it, withholds its failure text.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const effect: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
/**
 * Runs a stream on {@link tracer}.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const stream: <A, E, R>(self: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>;
/**
 * A function returning an effect, whose every call runs on {@link tracer}.
 * Wrap the traced function itself, `fn(Effect.fn("name")(body))`, so its
 * span opens on the wrapped tracer and Effect still records the definition
 * site where it is written.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const fn: <Args extends ReadonlyArray<any>, A, E, R>(traced: (...args: Args) => Effect.Effect<A, E, R>) => (...args: Args) => Effect.Effect<A, E, R>;
/**
 * `Effect.withSpan`, with only this one span withholding its failure text.
 * Spans the wrapped effect opens are traced as the caller's tracer traces
 * them.
 *
 * @category tracing
 * @since 1.0.0
 */
export declare const withSpan: (name: string, options?: Tracer.SpanOptions) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
