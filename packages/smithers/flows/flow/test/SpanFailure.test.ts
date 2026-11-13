/**
 * A failed span exports its failure's tag and token code, never its message or
 * stack: a model provider's error text can quote a prompt. Every case records
 * the exits spans end with on a native tracer, the values an exporter writes,
 * while the caller still receives the failure as it was raised.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter, SpanFailure } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema, Stream, Tracer } from "effect"
import * as fc from "fast-check"
import { effect } from "./Harness.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const sentinel = "sentinel-7c41-quoted-prompt"

class Refused extends Schema.TaggedError<Refused>()("Refused", { code: Schema.String, message: Schema.String }) {}

/** A native tracer that keeps every span it opens, and the exit each ended with. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const ended = (name: string): ReadonlyArray<string> => {
    const span = spans.find((candidate) => candidate.name === name)
    const exit = span?.status._tag === "Ended" ? span.status.exit : undefined
    return exit === undefined || Exit.isSuccess(exit)
      ? []
      : Cause.prettyErrors(exit.cause).map((error) => `${error.name}: ${error.message}`)
  }
  const stacks = (): string =>
    spans.map((span) =>
      span.status._tag === "Ended" && Exit.isFailure(span.status.exit)
        ? Cause.prettyErrors(span.status.exit.cause).map((error) => `${error.message}\n${error.stack}`).join("\n")
        : ""
    ).join("\n")
  return { tracer, ended, stacks }
}

const failed = (cause: Cause.Cause<unknown>): ReadonlyArray<string> => {
  const result = SpanFailure.exit(Exit.failCause(cause))
  return Exit.isFailure(result)
    ? Cause.prettyErrors(result.cause).map((error) => `${error.name}: ${error.message}`)
    : []
}

describe("SpanFailure.exit", () => {
  it("names each failure by its tag or class name and keeps only a tagged failure's token code", () => {
    expect(failed(Cause.fromReasons<unknown>([
      Cause.makeFailReason(new Refused({ code: "rate_limited", message: sentinel })),
      Cause.makeFailReason({ _tag: "Untoken", code: sentinel, message: sentinel }),
      Cause.makeFailReason({ _tag: "Uncoded", message: sentinel }),
      Cause.makeFailReason({ code: "rate_limited", message: sentinel }),
      Cause.makeFailReason({ _tag: 7, message: sentinel }),
      Cause.makeDieReason(new TypeError(sentinel)),
      Cause.makeDieReason(Object.assign(new Error(sentinel), { name: `Named ${sentinel}` })),
      Cause.makeDieReason(sentinel)
    ]))).toEqual([
      "Refused: rate_limited",
      "Untoken: redacted",
      "Uncoded: redacted",
      "Error: redacted",
      "Error: redacted",
      "TypeError: redacted",
      "Error: redacted",
      "Error: redacted"
    ])
  })

  it.each(["", `Refused ${sentinel}`, `Refused\n${sentinel}`, "A".repeat(201), "Refusé"])(
    "withholds an invalid tag %j from failures and defects",
    (_tag) => {
      const value = { _tag, code: "rate_limited", message: sentinel }
      const typed = Object.assign(new TypeError(sentinel), value)
      const result = SpanFailure.exit(Exit.failCause(Cause.fromReasons<unknown>([
        Cause.makeFailReason(value),
        Cause.makeDieReason(value),
        Cause.makeFailReason(typed),
        Cause.makeDieReason(typed)
      ])))
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const errors = Cause.prettyErrors(result.cause)
        expect(errors.map((error) => error.name)).toEqual(["Error", "Error", "TypeError", "TypeError"])
        expect(errors.map((error) => error.message)).toEqual(Array(4).fill("redacted"))
        expect(errors.map((error) => error.stack)).toEqual([
          "Error: redacted",
          "Error: redacted",
          "TypeError: redacted",
          "TypeError: redacted"
        ])
      }
      expect(value._tag).toBe(_tag)
      expect(typed.message).toBe(sentinel)
    }
  )

  it.each(["A", "A".repeat(200), "0_@$./:-"])("preserves a bounded identifier tag %j", (_tag) => {
    const value = { _tag, code: "rate_limited", message: sentinel }
    expect(failed(Cause.fromReasons([Cause.makeFailReason(value), Cause.makeDieReason(value)]))).toEqual([
      `${_tag}: rate_limited`,
      `${_tag}: rate_limited`
    ])
  })

  it("exports only bounded identifier tags across arbitrary strings", () => {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@$./:-"
    const tags = fc.oneof(
      fc.string({ maxLength: 250 }),
      fc.array(fc.constantFrom(...characters), { minLength: 1, maxLength: 205 }).map((parts) => parts.join(""))
    )
    fc.assert(
      fc.property(tags, (_tag) => {
        const valid = _tag.length >= 1 && _tag.length <= 200 && [..._tag].every((char) => characters.includes(char))
        const expected = valid ? `${_tag}: rate_limited` : "Error: redacted"
        const value = { _tag, code: "rate_limited", message: sentinel }
        expect(failed(Cause.fromReasons([Cause.makeFailReason(value), Cause.makeDieReason(value)]))).toEqual([
          expected,
          expected
        ])
      }),
      { numRuns: 200 }
    )
  })

  it("passes a success, an interruption and a stand-in through unchanged", () => {
    expect(SpanFailure.exit(Exit.succeed(1))).toEqual(Exit.succeed(1))
    const interrupted = Exit.failCause(Cause.interrupt(3))
    expect(SpanFailure.exit(interrupted)).toBe(interrupted)
    const once = SpanFailure.exit(Exit.failCause(Cause.fromReasons([
      Cause.makeFailReason(new Refused({ code: "transport", message: sentinel })),
      Cause.makeInterruptReason(3)
    ])))
    const twice = SpanFailure.exit(once)
    expect(Exit.isFailure(twice) && twice.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail", "Interrupt"])
    expect(Exit.isFailure(once) && Exit.isFailure(twice) && twice.cause.reasons[0]).toEqual(
      Exit.isFailure(once) && once.cause.reasons[0]
    )
  })
})

describe("SpanFailure tracing", () => {
  it.effect("withholds every span an effect, a function or a stream opens", () =>
    Effect.gen(function*() {
      const { ended, stacks, tracer } = recording()
      const refuse = Effect.fail(new Refused({ code: "rate_limited", message: sentinel }))
      const traced = SpanFailure.fn(Effect.fn("traced")(() => refuse))
      const exits = yield* Effect.all([
        Effect.exit(SpanFailure.effect(Effect.withSpan(refuse, "effect"))),
        Effect.exit(traced()),
        Effect.exit(Stream.runDrain(SpanFailure.stream(Stream.fromEffect(Effect.withSpan(refuse, "stream")))))
      ]).pipe(Effect.provideService(Tracer.Tracer, tracer))
      for (const name of ["effect", "traced", "stream"]) expect(ended(name)).toEqual(["Refused: rate_limited"])
      expect(stacks()).not.toContain(sentinel)
      // The caller still reads the failure as it was raised.
      for (const exit of exits) {
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ message: sentinel })
      }
      // Wrapping a withholding tracer again returns it unchanged.
      const outer = SpanFailure.tracer(tracer)
      expect(SpanFailure.tracer(outer)).toBe(outer)
    }))

  it.effect("withholds foreign tags from native span exports while preserving the caller's failure", () =>
    Effect.gen(function*() {
      const { ended, stacks, tracer } = recording()
      const failure = { _tag: `Provider refused ${sentinel}`, code: "rate_limited", message: sentinel }
      const exits = yield* Effect.all([
        Effect.exit(SpanFailure.effect(Effect.withSpan(Effect.fail(failure), "foreign-failure"))),
        Effect.exit(SpanFailure.effect(Effect.withSpan(Effect.die(failure), "foreign-defect")))
      ]).pipe(Effect.provideService(Tracer.Tracer, tracer))
      for (const name of ["foreign-failure", "foreign-defect"]) expect(ended(name)).toEqual(["Error: redacted"])
      expect(stacks()).not.toContain(sentinel)
      for (const exit of exits) expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(failure)
    }))

  it.effect("withholds one span's failure and leaves the spans inside it as traced", () =>
    Effect.gen(function*() {
      const { ended, tracer } = recording()
      const exit = yield* Effect.exit(
        Effect.die(new Error(sentinel)).pipe(
          Effect.withSpan("inner"),
          SpanFailure.withSpan("outer", { attributes: { step: "one" }, captureStackTrace: false })
        )
      ).pipe(Effect.provideService(Tracer.Tracer, tracer))
      expect(ended("outer")).toEqual(["Error: redacted"])
      expect(ended("inner")).toEqual([`Error: ${sentinel}`])
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ message: sentinel })
    }))
})

const Answer = Action.make("SpanFailure/Answer", {
  payload: {},
  success: Schema.String,
  error: Refused
})
const Ask = Flow.make("SpanFailure/Ask", {
  payload: {},
  success: Schema.String,
  error: Refused,
  body: () => Answer.call({})
})

describe("Action.execute and Flow.execute", () => {
  effect("end their spans on the action failure's tag and code, never its text", () =>
    Effect.gen(function*() {
      const { ended, tracer } = recording()
      const exit = yield* Effect.exit(Ask.execute({}, { executionId: "span-failure" })).pipe(
        Effect.provide(layerWired(Layer.mergeAll(
          Answer.toLayer(() => Effect.fail(new Refused({ code: "rate_limited", message: sentinel }))),
          Interpreter.layer(Ask)
        ))),
        Effect.provideService(Tracer.Tracer, tracer)
      )
      expect(ended("Action.execute")).toEqual(["Refused: rate_limited"])
      // The flow fails with the action's failure, and its span withholds it too.
      expect(ended("SpanFailure/Ask.execute")).toEqual(["Refused: rate_limited"])
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({ message: sentinel })
    }))
})
