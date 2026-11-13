/**
 * Span failures with their text withheld.
 *
 * An OTLP exporter writes a failed span's error into the span's status message
 * and its `exception` event: the error's name, message and stack. A failure's
 * message is often someone else's text: a model provider's error can quote a
 * prompt or a credential, and a defect carries its own message and stack. A
 * span that ends through {@link tracer} or {@link withSpan} gives the exporter
 * a stand-in for each failure instead: the failure's bounded identifier tag,
 * or else its class name, and its `code` when the failure is tagged and the
 * code is a lowercase token. A stand-in's stack is that one line plus the
 * source locations Effect recorded for the span, never the original's.
 *
 * Only the span's copy changes. The failure itself reaches the caller as it
 * was raised, so a caller still reads the original message and branches on
 * the same error.
 *
 * @since 1.0.0
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Stream from "effect/Stream"
import * as Tracer from "effect/Tracer"

/** The stand-in a span ends with in place of one failure. */
class Withheld extends Error {}

/** A class name such as `TypeError`. Anything else could be text, and is not exported. */
const className = /^[A-Za-z_$][\w$]*$/

/** The same bounded identifier pattern used for interpreter defect tags. */
const defectTag = /^[A-Za-z0-9_@$./:-]{1,200}$/

/** A code such as `rate_limited`: a schema literal, never free text. */
const token = /^[a-z][a-z0-9_]{0,63}$/

const fieldOf = (value: unknown, field: "_tag" | "code"): string | undefined => {
  const found = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[field] : undefined
  return typeof found === "string" ? found : undefined
}

/**
 * The stand-in for one failure: its tag, else its class name, as the name;
 * a tagged failure's token code, else `redacted`, as the message; and a stack
 * that is only those two.
 */
const standIn = (value: unknown): Error => {
  if (value instanceof Withheld) return value
  const rawTag = fieldOf(value, "_tag")
  const tag = rawTag !== undefined && defectTag.test(rawTag) ? rawTag : undefined
  const name = tag ?? (value instanceof Error && className.test(value.name) ? value.name : "Error")
  const code = tag === undefined ? undefined : fieldOf(value, "code")
  const message = code !== undefined && token.test(code) ? code : "redacted"
  const error = new Withheld(message)
  Object.defineProperty(error, "name", { value: name, configurable: true, writable: true })
  error.stack = `${name}: ${message}`
  return error
}

/**
 * An exit as a span records it: every failure and defect replaced by its
 * stand-in, each keeping the annotations Effect recorded for it. A success
 * and an interruption pass unchanged.
 *
 * @category tracing
 * @since 1.0.0
 */
export const exit = <A, E>(result: Exit.Exit<A, E>): Exit.Exit<A, unknown> => {
  if (Exit.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) return result
  return Exit.failCause(Cause.fromReasons(result.cause.reasons.map((reason): Cause.Reason<unknown> => {
    switch (reason._tag) {
      case "Fail":
        return Cause.makeFailReason(standIn(reason.error)).annotate(Cause.reasonAnnotations(reason))
      case "Die":
        return Cause.makeDieReason(standIn(reason.defect)).annotate(Cause.reasonAnnotations(reason))
      case "Interrupt":
        return reason
    }
  })))
}

const withholding = new WeakSet<Tracer.Tracer>()

/**
 * The caller's tracer, with every span it opens ending on {@link exit} of
 * the exit it is given. Wrapping it again returns it unchanged.
 *
 * @category tracing
 * @since 1.0.0
 */
export const tracer = (inner: Tracer.Tracer): Tracer.Tracer => {
  if (withholding.has(inner)) return inner
  const outer = Tracer.make({
    ...inner,
    span(options) {
      const span = inner.span(options)
      const end = span.end.bind(span)
      span.end = (endTime, result) => end(endTime, exit(result))
      return span
    }
  })
  withholding.add(outer)
  return outer
}

/**
 * Runs an effect on {@link tracer}, so every span it opens, including the
 * one a traced function opens around it, withholds its failure text.
 *
 * @category tracing
 * @since 1.0.0
 */
export const effect = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.updateService(self, Tracer.Tracer, tracer)

/**
 * Runs a stream on {@link tracer}.
 *
 * @category tracing
 * @since 1.0.0
 */
export const stream = <A, E, R>(self: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
  Stream.updateService(self, Tracer.Tracer, tracer)

/**
 * A function returning an effect, whose every call runs on {@link tracer}.
 * Wrap the traced function itself, `fn(Effect.fn("name")(body))`, so its
 * span opens on the wrapped tracer and Effect still records the definition
 * site where it is written.
 *
 * @category tracing
 * @since 1.0.0
 */
export const fn = <Args extends ReadonlyArray<any>, A, E, R>(
  traced: (...args: Args) => Effect.Effect<A, E, R>
): (...args: Args) => Effect.Effect<A, E, R> =>
(...args) => effect(traced(...args))

/**
 * `Effect.withSpan`, with only this one span withholding its failure text.
 * Spans the wrapped effect opens are traced as the caller's tracer traces
 * them.
 *
 * @category tracing
 * @since 1.0.0
 */
export const withSpan = (
  name: string,
  options?: Tracer.SpanOptions
) =>
<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.tracer,
    (inner) => effect(Effect.withSpan(Effect.provideService(self, Tracer.Tracer, inner), name, options))
  )
