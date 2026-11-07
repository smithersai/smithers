/**
 * The redacting logger over the rule fixtures `Redaction.test.ts` documents.
 *
 * The assertions read what the logger handed the console, because that is what
 * reaches the operator's terminal. the release policy owns this
 * deliverable and `test/faults/case22-secret-never-in-journal.test.ts` beside it proves
 * the same rules on the real binary.
 */
import { describe, expect, it } from "@effect/vitest"
import { Cause, Console, Context, Effect, Logger, References, Tracer } from "effect"
import { inspect } from "node:util"
import * as RedactedLogger from "../src/RedactedLogger.ts"
import * as Redaction from "../src/Redaction.ts"

interface Capture {
  readonly lines: Array<Array<unknown>>
  readonly console: Console.Console
}

/** A console that records every argument each writing method was handed. */
const capture = (): Capture => {
  const lines: Array<Array<unknown>> = []
  const record = (...args: ReadonlyArray<unknown>) => {
    lines.push([...args])
  }
  const ignore = () => {}
  return {
    lines,
    console: {
      assert: record,
      clear: ignore,
      // `count` and the timer methods take a caller-supplied LABEL and print
      // it, so they are recorded here like any other output method. They used
      // to be `ignore`, which is why the leak below went unseen.
      count: record,
      countReset: record,
      debug: record,
      dir: record,
      dirxml: record,
      error: record,
      group: record,
      groupCollapsed: record,
      groupEnd: ignore,
      info: record,
      log: record,
      table: record,
      time: record,
      timeEnd: record,
      timeLog: record,
      trace: record,
      warn: record
    } as Console.Console
  }
}

/**
 * Everything the console was handed for the run, as one string.
 *
 * Rendered the way a console renders: a string bare, everything else through
 * `inspect`. Not `String` for everything, which was the earlier form:
 * `String({apiKey: "sk-..."})` is `[object Object]`, so every assertion built on
 * it was blind to a credential inside a non-string argument, and a leak shipped
 * green underneath that blindness once already.
 */
const rendered = (recorded: Capture): string =>
  recorded.lines
    .map((line) => line.map((value) => typeof value === "string" ? value : inspect(value, { depth: 8 })).join(" "))
    .join("\n")

/** Runs `body` under `logger`, redacted, against a capturing console. */
const loggedWith = <E>(
  logger: Logger.Logger<unknown, void>,
  body: Effect.Effect<void, E>
): Effect.Effect<Capture, E> =>
  Effect.suspend(() => {
    const recorded = capture()
    return body.pipe(
      Effect.provide(RedactedLogger.layer()),
      Effect.provide(Logger.layer([logger])),
      Effect.provideService(Console.Console, recorded.console),
      Effect.as(recorded)
    )
  })

/** Runs `body` under the pretty logger, which is what an operator's terminal gets. */
const logged = <E>(body: Effect.Effect<void, E>): Effect.Effect<Capture, E> =>
  loggedWith(Logger.consolePretty({ colors: false, mode: "tty" }), body)

/**
 * Runs `body` under the real `Logger.tracerLogger` inside a recorded span.
 *
 * That logger is the non-console logger that actually ships: Effect installs
 * it by default alongside the console one, it never reads the fiber's
 * `Console`, and what it writes leaves the process for an OTLP collector.
 */
const traced = <E>(body: Effect.Effect<void, E>): Effect.Effect<Array<Tracer.NativeSpan>, E> =>
  Effect.suspend(() => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      }
    })
    return body.pipe(
      Effect.withSpan("probe"),
      Effect.provide(RedactedLogger.layer()),
      Effect.provide(Logger.layer([Logger.tracerLogger])),
      Effect.provideService(Tracer.Tracer, tracer),
      Effect.as(spans)
    )
  })

/** The one log event the tracer logger recorded on the probe span. */
const onlyEvent = (
  spans: ReadonlyArray<Tracer.NativeSpan>
): [name: string, startTime: bigint, attributes: Record<string, unknown>] => {
  const events = spans.flatMap((span) => span.events)
  expect(events.length).toBe(1)
  return events[0]!
}

describe("RedactedLogger", () => {
  it.effect("keeps a credential-shaped token out of the line the console prints", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(
        Effect.logInfo("calling https://example.test/deploy with Bearer sk-live-e2ecase22NEVERLOGTHIS")
      )
      const text = rendered(recorded)
      expect(text).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      // Re-pinned 2026-09-01: this expected `Bearer [REDACTED_API_KEY]`, which
      // was the rule order on this branch before the merge, where `api-key` ran
      // ahead of `bearer-token`. The rewritten `bearer-token` now runs first and
      // takes the whole `Bearer <token>` span, which strictly contains the span
      // `api-key` used to take. The credential is removed by a wider rule under
      // a different marker, which the assertion above holds unchanged.
      expect(text).toContain("Bearer [REDACTED_TOKEN]")
    }))

  it.effect("survives a cause carrying a host error the clone cannot impersonate", () =>
    Effect.gen(function*() {
      // `redactError` rebuilds an error with `Object.create` over its own
      // prototype. A DOMException keeps `name` and `code` in internal slots
      // behind prototype getters, so the clone is the impostor that killed the
      // run for `Headers` and `Event`: the clone itself succeeds, and the throw
      // arrives later from inside `Cause.pretty`. An AbortSignal's reason is a
      // DOMException, so this is an ordinary cancelled action.
      const controller = new AbortController()
      controller.abort()
      const recorded = yield* logged(
        Effect.fail(controller.signal.reason).pipe(
          Effect.catchCause((cause) => Effect.logError("action failed", cause))
        )
      )
      expect(rendered(recorded)).toContain("action failed")
    }))

  it.effect("keeps a credential out of a log span's label", () =>
    Effect.gen(function*() {
      // A span label reaches the same line by a different route: Effect
      // sanitizes it first, folding `token=` into `token_`, and `_` is a word
      // character, so a rule anchored on `\b` could never fire after it.
      const recorded = yield* logged(
        Effect.logInfo("deploying").pipe(Effect.withLogSpan("fetch token=sk-live-e2ecase22NEVERLOGTHIS"))
      )
      expect(rendered(recorded)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    }))

  it.effect("keeps a credential out of a logged function's own properties", () =>
    Effect.gen(function*() {
      // The walker returned anything that was neither a string nor an object
      // untouched, so `util.inspect` printed a function's own properties in
      // full: `[Function: deploy] { token: 'sk-...' }` on the operator's
      // terminal, on the path case 22 guards.
      const handler = Object.assign(() => undefined, { token: "sk-live-e2ecase22NEVERLOGTHIS" })
      const recorded = yield* logged(Effect.logInfo("handler installed", handler))
      expect(rendered(recorded)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    }))

  it.effect("applies the documented textual rules to a logged message", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(Effect.gen(function*() {
        yield* Effect.logInfo("use sk-proj-abcdefghij when calling")
        yield* Effect.logInfo("Authorization: Bearer abcdefghijkl")
        yield* Effect.logInfo("ANTHROPIC_API_KEY=shhh")
      }))
      const text = rendered(recorded)
      expect(text).toContain("[REDACTED_API_KEY]")
      expect(text).toContain("Bearer [REDACTED_TOKEN]")
      expect(text).toContain(`ANTHROPIC_API_KEY=${Redaction.placeholder}`)
      expect(text).not.toContain("sk-proj-abcdefghij")
      expect(text).not.toContain("Bearer abcdefghijkl")
      expect(text).not.toContain("=shhh")
    }))

  it.effect("redacts the message a logger reads directly, not only what the console prints", () =>
    Effect.gen(function*() {
      // `Logger.tracerLogger` ships in Effect's default logger set and never
      // reads the fiber's Console: it publishes the message as a span event
      // name. A wrapper that only substitutes the Console leaves the raw
      // credential on the exported span.
      const seen: Array<unknown> = []
      const direct = Logger.make<unknown, void>(({ message }) => {
        seen.push(message)
      })
      yield* Effect.logInfo("calling with Bearer sk-live-e2ecase22NEVERLOGTHIS").pipe(
        Effect.provide(Logger.layer([RedactedLogger.wrap(direct)]))
      )
      // A multi-part message arrives as an array, and every part is redacted.
      yield* Effect.logInfo("deploying with", "sk-proj-abcdefghij", { apiKey: "sk-ant-api03-abcdefgh" }).pipe(
        Effect.provide(Logger.layer([RedactedLogger.wrap(direct)]))
      )
      const text = seen.map((entry) =>
        Array.isArray(entry) ? entry.map((part) => JSON.stringify(part)).join(" ") : String(entry)
      ).join("\n")
      expect(text).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(text).not.toContain("sk-proj-abcdefghij")
      expect(text).not.toContain("sk-ant-api03-abcdefgh")
      expect(text).toContain("[REDACTED_API_KEY]")
    }))

  it.effect("redacts a message a caller passed without wrapping it in parts", () =>
    Effect.gen(function*() {
      // Effect's own logging API always delivers an array of parts, but
      // `Logger.log` takes whatever LogOptions a caller builds; a bare message
      // is redacted the same way rather than walked as a sequence. The options
      // are captured from a real log call so the fiber is a real one.
      const seen: Array<unknown> = []
      let captured: Parameters<typeof direct.log>[0] | undefined
      const direct = Logger.make<unknown, void>((options) => {
        captured = options
        seen.push(options.message)
      })
      const wrapped = RedactedLogger.wrap(direct)
      yield* Effect.logInfo("warm").pipe(Effect.provide(Logger.layer([wrapped])))
      seen.length = 0
      yield* Effect.sync(() => wrapped.log({ ...captured!, message: "bare Bearer sk-live-e2ecase22NEVERLOGTHIS" }))
      const text = JSON.stringify(seen)
      expect(text).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      // Re-pinned 2026-09-01: `bearer-token` runs ahead of `api-key` and takes
      // the whole span, so the marker is the token one. The span is named here
      // as well as the marker, which is stricter than the bare marker was.
      expect(text).toContain("bare Bearer [REDACTED_TOKEN]")
    }))

  it.effect("redacts the span event the tracer logger exports", () =>
    Effect.gen(function*() {
      const spans = yield* traced(
        Effect.logInfo("calling https://example.test/deploy with Bearer sk-live-e2ecase22NEVERLOGTHIS").pipe(
          Effect.annotateLogs({ apiKey: "sk-ant-api03-abcdefgh" })
        )
      )
      const [name, , attributes] = onlyEvent(spans)
      expect(name).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      // Re-pinned 2026-09-01: the rewritten `bearer-token` takes the span the
      // `api-key` rule used to take, so the exported event name carries the
      // token marker. The annotation below is untouched by the reorder.
      expect(name).toBe("calling https://example.test/deploy with Bearer [REDACTED_TOKEN]")
      expect(attributes.apiKey).toBe(Redaction.placeholder)
    }))

  it.effect("redacts the cause that logger renders into the span itself", () =>
    Effect.gen(function*() {
      // A failure is logged as a `Cause`, not as message parts, and the tracer
      // logger renders it with `Cause.pretty` into `effect.cause`. Nothing on
      // that path touches the console.
      const spans = yield* traced(
        Effect.logError(
          Cause.fail(new Error("POST https://example.test failed: token=sk-live-e2ecase22NEVERLOGTHIS"))
        )
      )
      const rendered = String(onlyEvent(spans)[2]["effect.cause"])
      expect(rendered).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(rendered).toContain(`token=${Redaction.placeholder}`)
      expect(rendered).toContain("POST https://example.test failed")
    }))

  it.effect("redacts real span names in the cause exported by the tracer", () =>
    Effect.gen(function*() {
      const secret = "sk-live-gridProbeCredential12345"
      const spans = yield* traced(
        Effect.fail(new Error("request failed")).pipe(
          Effect.withSpan(`fetch token=${secret}`),
          Effect.withSpan(`parent token=${secret}`),
          Effect.catchCause((cause) => Effect.logError("failed", cause))
        )
      )
      const cause = String(onlyEvent(spans)[2]["effect.cause"])
      expect(cause).toContain(`fetch token=${Redaction.placeholder}`)
      expect(cause).toContain(`parent token=${Redaction.placeholder}`)
      expect(cause).toContain("request failed")
      expect(cause).not.toContain(secret)
    }))

  it.effect("redacts stack text and parent frames on failures, defects and interruptions", () =>
    Effect.gen(function*() {
      const secret = "sk-live-gridProbeCredential12345"
      const frame = (name: string): References.StackFrame => ({
        name: `${name} token=${secret}`,
        stack: () => `at source (https://example.test/task?token=${secret})`,
        parent: {
          name: `${name} parent token=${secret}`,
          stack: () => `at https://example.test/parent?token=${secret}`,
          parent: undefined
        }
      })
      for (
        const reason of [
          Cause.makeFailReason(new Error("request failed")),
          Cause.makeDieReason(new Error("request died")),
          Cause.makeInterruptReason(42)
        ]
      ) {
        const annotations = new Map<string, unknown>([
          [Cause.StackTrace.key, frame("operation")],
          [Cause.InterruptorStackTrace.key, frame("interruptor")],
          ["requestId", "request-42"]
        ])
        const original = Cause.fromReasons([reason.annotate(Context.makeUnsafe(annotations))])
        const spans = yield* traced(Effect.logError(original))
        const cause = String(onlyEvent(spans)[2]["effect.cause"])
        expect(cause).not.toContain(secret)
        expect(cause).toContain(`operation token=${Redaction.placeholder}`)
        expect(cause).toContain(`operation parent token=${Redaction.placeholder}`)
        expect(cause).toContain(`https://example.test/task?token=${Redaction.placeholder}`)
        expect(cause).toContain(`https://example.test/parent?token=${Redaction.placeholder}`)
        if (reason._tag === "Interrupt") {
          expect(cause).toContain("at fiber (#42)")
          expect(cause).toContain(`interruptor token=${Redaction.placeholder}`)
          expect(cause).toContain(`interruptor parent token=${Redaction.placeholder}`)
        }
        yield* loggedWith(
          Logger.make(({ cause: delegated }) => {
            const copy = delegated.reasons[0]!
            expect(copy._tag).toBe(reason._tag)
            expect(copy.annotations.get("requestId")).toBe("request-42")
            expect(copy.annotations).not.toBe(original.reasons[0]!.annotations)
            for (const key of [Cause.StackTrace.key, Cause.InterruptorStackTrace.key]) {
              const copiedFrame = copy.annotations.get(key) as References.StackFrame
              expect(copiedFrame.name).not.toContain(secret)
              expect(copiedFrame.stack()).not.toContain(secret)
              expect(copiedFrame.parent!.name).not.toContain(secret)
              expect(copiedFrame.parent!.stack()).not.toContain(secret)
            }
          }),
          Effect.logError(original)
        )
        expect(Cause.pretty(original)).toContain(secret)
      }
    }))

  it.effect("handles absent and unreadable frame text without leaking or losing the log", () =>
    Effect.gen(function*() {
      const frame: References.StackFrame = {
        name: "operation token=sk-live-gridProbeCredential12345",
        stack: () => undefined,
        parent: {
          get name(): string {
            throw new Error("token=sk-live-gridProbeCredential12345")
          },
          stack: () => {
            throw new Error("token=sk-live-gridProbeCredential12345")
          },
          parent: undefined
        }
      }
      const cause = Cause.fromReasons([
        Cause.makeFailReason(new Error("request failed")).annotate(Context.makeUnsafe(
          new Map([
            [Cause.StackTrace.key, frame],
            [Cause.InterruptorStackTrace.key, undefined]
          ])
        ))
      ])
      const spans = yield* traced(Effect.logError(cause))
      const output = String(onlyEvent(spans)[2]["effect.cause"])
      expect(output).toContain(`operation token=${Redaction.placeholder}`)
      expect(output).toContain("[Unrenderable]")
      expect(output).not.toContain("sk-live-gridProbeCredential12345")
    }))

  it.effect("bounds cyclic frame parents before handing them to a logger", () =>
    Effect.gen(function*() {
      const frame: References.StackFrame = {
        name: "operation token=sk-live-gridProbeCredential12345",
        stack: () => undefined,
        get parent() {
          return frame
        }
      }
      const cause = Cause.fromReasons([
        Cause.makeInterruptReason().annotate(Context.make(Cause.InterruptorStackTrace, frame))
      ])
      yield* loggedWith(
        Logger.make(({ cause: delegated }) => {
          let current = delegated.reasons[0]!.annotations.get(Cause.InterruptorStackTrace.key) as References.StackFrame
          const seen = new Set<References.StackFrame>()
          while (current.parent !== undefined) {
            expect(current.name).toBe(`operation token=${Redaction.placeholder}`)
            expect(seen.has(current)).toBe(false)
            seen.add(current)
            expect(seen.size).toBeLessThanOrEqual(200)
            current = current.parent
          }
          expect(current.name).toBe("[Deep]")
          expect(current.stack()).toBeUndefined()
        }),
        Effect.logError(cause)
      )
    }))

  it("keeps a redacted error's name and own fields, which a rendered cause reads", () => {
    // Restated 2026-09-01: this asserted the copy was an instance of the
    // original class. It is not any more, and cannot be: the copy was built on
    // the original's prototype, and four review rounds each found one more
    // thing a prototype defines that a renderer reads and an own-key walk never
    // sees. What a rendered cause actually prints, the name, the message, the
    // stack and the own fields, is unchanged and asserted here.
    class DeployError extends Error {
      readonly _tag = "DeployError"
      readonly status: number
      constructor(message: string, status: number) {
        super(message)
        this.name = "DeployError"
        this.status = status
      }
    }
    const redacted = RedactedLogger.redactArgument(
      new DeployError("POST failed: token=sk-live-abcdefgh", 502),
      Redaction.make()
    ) as DeployError
    expect(redacted).toBeInstanceOf(Error)
    expect(Object.getPrototypeOf(redacted)).toBe(Error.prototype)
    expect(redacted._tag).toBe("DeployError")
    expect(redacted.status).toBe(502)
    expect(redacted.name).toBe("DeployError")
    expect(redacted.message).toBe(`POST failed: token=${Redaction.placeholder}`)
    expect(redacted.stack).not.toContain("sk-live-abcdefgh")
    expect(inspect(redacted)).toContain("DeployError")
  })

  it("redacts an error's own fields, reads its getters, and stops at a cycle", () => {
    // `Cause.pretty` walks `error.cause`, so a nested error is rendered too.
    // A cycle is not exotic once errors carry each other: the walk records
    // what it has seen and hands the original back rather than recurring.
    const inner = new Error("inner token=sk-live-abcdefgh")
    const outer = new Error("outer Bearer abcdefghijkl", { cause: inner }) as Error & { self?: unknown }
    outer.self = outer
    Object.defineProperty(outer, "detail", {
      get: () => "sent Bearer abcdefghijkl",
      enumerable: true,
      configurable: true
    })
    const redacted = RedactedLogger.redactArgument(outer, Redaction.make()) as Error & {
      self: unknown
      detail: string
    }
    expect(redacted.message).toBe("outer Bearer [REDACTED_TOKEN]")
    expect(redacted.cause).toBeInstanceOf(Error)
    expect((redacted.cause as Error).message).toBe(`inner token=${Redaction.placeholder}`)
    // Restated 2026-08-31: this asserted `toBe(outer)`, which made the repeat
    // reference the UNREDACTED original. A diamond (two fields naming one
    // error) then carried the credential in clear on the second field, and a
    // logger that reads the event rather than rendering it through the console
    // printed it. The memo returns the clone, so every reference is redacted
    // and the shape a reader sees is still a self-reference.
    expect(redacted.self).toBe(redacted)
    // A getter is read once and stored, so what it returned is redacted too.
    expect(redacted.detail).toBe("sent Bearer [REDACTED_TOKEN]")
  })

  it.effect("redacts a defect and passes an interrupt through", () =>
    Effect.gen(function*() {
      const spans = yield* traced(
        Effect.logError(
          Cause.combine(
            Cause.die(new Error("crashed calling with Bearer sk-live-e2ecase22NEVERLOGTHIS")),
            Cause.interrupt(1)
          )
        )
      )
      const rendered = String(onlyEvent(spans)[2]["effect.cause"])
      expect(rendered).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      // Re-pinned 2026-09-01: `bearer-token` wins the span, so the defect's
      // message reaches the span attribute under the token marker.
      expect(rendered).toContain("Bearer [REDACTED_TOKEN]")
    }))

  it("survives every exotic value a log line can carry", () => {
    // The failure mode is one thing: a value the walk cannot faithfully
    // rebuild must never throw out of the logger, because the throw happens
    // while the line is being rendered and it kills the run. Own-key counts
    // do not predict it (Event carries four own symbols AND private fields),
    // so these cover the shapes an inferred rule kept missing.
    const redactor = Redaction.make()
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const throwingGetter = {}
    Object.defineProperty(throwingGetter, "boom", {
      get: () => {
        throw new Error("nope")
      },
      enumerable: true
    })
    const deepUnderError = new Error("outer") as Error & { detail?: unknown }
    let chain: Record<string, unknown> = { token: "sk-live-abcdefgh" }
    for (let level = 0; level < 5_000; level++) chain = { chain }
    deepUnderError.detail = chain
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["Event", new Event("evt-sk-live-abcdefgh")],
      ["CustomEvent", new CustomEvent("evt", { detail: "sk-live-abcdefgh" })],
      ["Headers", new Headers({ authorization: "Bearer sk-live-abcdefgh" })],
      ["URLSearchParams", new URLSearchParams({ token: "sk-live-abcdefgh" })],
      ["AbortController", new AbortController()],
      ["Blob", new Blob(["sk-live-abcdefgh"])],
      ["unparseable RegExp after redaction", new RegExp("(?<sk_live_abcdefgh>x)")],
      ["RegExp whose class breaks", new RegExp("[q sk_livexyz1234]", "u")],
      ["URL whose host is credential-shaped", new URL("https://sk-live-abcdefgh.example.com/")],
      ["revoked proxy", revoked.proxy],
      ["throwing getter", throwingGetter],
      ["deep value under an Error", deepUnderError]
    ]
    for (const [name, value] of cases) {
      const rendered = expect(() => RedactedLogger.redactArgument(value, redactor), name).not.toThrow
      void rendered
      const out = RedactedLogger.redactArgument(value, redactor)
      expect(() => inspect(out), name).not.toThrow()
      expect(inspect(out), name).not.toContain("sk-live-abcdefgh")
      expect(inspect(out), name).not.toContain("sk_live_abcdefgh")
    }
  })

  it("keeps the line when the console itself refuses to render it", () => {
    // The delegate renders what the wrapper hands it, and a value can survive
    // redaction and still break the renderer. The line degrades to text; the
    // run does not die.
    const redactor = Redaction.make()
    const seen: Array<ReadonlyArray<unknown>> = []
    let refuse = true
    // Every method the wrapper binds must exist, so the double is the real
    // console with `log` replaced.
    const brittle = {
      ...console,
      log: (...args: ReadonlyArray<unknown>) => {
        if (refuse) {
          refuse = false
          throw new TypeError("cannot render that")
        }
        seen.push(args)
      }
    } as unknown as Console.Console
    const view = RedactedLogger.redactingConsole(brittle, redactor)
    // A BigInt survives redaction and still breaks `JSON.stringify`, so the
    // text fallback needs its own fallback.
    expect(() => view.log("token=sk-live-abcdefgh", { a: 1 }, 7n, undefined)).not.toThrow()
    expect(JSON.stringify(seen.map((entry) => entry.map((value) => String(value))))).not.toContain(
      "sk-live-abcdefgh"
    )
    expect(seen.length).toBe(1)
  })

  it("names a prototype chain it cannot rebuild rather than guessing", () => {
    // A chain that never reaches Object.prototype is not a plain object and
    // not an ordinary class instance, so it is not rebuilt.
    const redactor = Redaction.make()
    const orphan = Object.create(Object.create(null) as object) as Record<string, unknown>
    orphan["token"] = "sk-live-abcdefgh"
    expect(() => RedactedLogger.redactArgument(orphan, redactor)).not.toThrow()
    expect(inspect(RedactedLogger.redactArgument(orphan, redactor))).not.toContain("sk-live-abcdefgh")
  })

  it("survives a host object whose state lives in internal slots", () => {
    // A brand-checked class (Headers, URLSearchParams, Request, ...) keeps its
    // state in internal slots, so a clone built on its prototype with only its
    // own keys copied is an impostor that Node's inspector rejects: rendering
    // it threw from inside the logger and killed the fiber.
    const redactor = Redaction.make()
    const headers = new Headers({ authorization: "Bearer sk-live-abcdefgh" })
    const rendered = RedactedLogger.redactArgument(headers, redactor)
    expect(() => inspect(rendered)).not.toThrow()
    expect(inspect(rendered)).not.toContain("sk-live-abcdefgh")

    const params = new URLSearchParams({ token: "sk-live-abcdefgh" })
    expect(() => inspect(RedactedLogger.redactArgument(params, redactor))).not.toThrow()
    expect(inspect(RedactedLogger.redactArgument(params, redactor))).not.toContain("sk-live-abcdefgh")
  })

  it("gives an annotation the same treatment the message gets", () => {
    // Restated 2026-09-01: this asserted an annotated Date stayed a Date,
    // which was the type-preserving render. That render was removed after
    // three rounds of review found it could kill the run it was logging, so
    // the shared treatment is now the plain redacted form. The property the
    // case exists for is unchanged: both halves of one log event obey one
    // rule, and neither leaks.
    const redactor = Redaction.make()
    const annotations = RedactedLogger.redactArgument(
      { at: new Date(0), token: "sk-live-abcdefgh", nested: { authorization: "Bearer abcdefghijkl" } },
      redactor
    )
    const rendered = inspect(annotations)
    expect(rendered).not.toContain("sk-live-abcdefgh")
    expect(rendered).not.toContain("Bearer abcdefghijkl")
    expect(RedactedLogger.redactArgument({ token: "sk-live-abcdefgh" }, redactor)).toEqual(
      RedactedLogger.redactArgument({ token: "sk-live-abcdefgh" }, redactor)
    )
  })

  it("redacts a credential used as a Map key", () => {
    const redactor = Redaction.make()
    const keyed = RedactedLogger.redactArgument(new Map([["sk-live-abcdefgh", "v"]]), redactor) as Map<
      string,
      unknown
    >
    expect(inspect(keyed)).not.toContain("sk-live-abcdefgh")
  })

  it("stops at the depth cap on an Error's own members, not only beside one", () => {
    // Round 4 found the cap did not bind through an Error: the Error walk ran
    // before the check and carried no depth, so a deep value on a cause still
    // exhausted the stack and the RangeError killed the run from inside the
    // logger. The chain here is deeper than the cap and hangs off the Error.
    //
    // Re-pinned 2026-09-01: the redactor is built the way `wrap` builds it. The
    // cap moved onto the `onTooDeep` seam in the merge, and a redactor left at
    // the journal's default THROWS past `Redaction.maxDepth`; `redactArgument`
    // catches that one frame up and replaces the whole argument with
    // `[Unrenderable]`, which is the outcome the logger's `"name"` exists to
    // avoid. Building the redactor here the way the logger does is what puts
    // this case back on the logger's path.
    const redactor = Redaction.make({ onTooDeep: "name" })
    const outer = new Error("outer") as Error & { detail?: unknown }
    let chain: Record<string, unknown> = { token: "sk-live-abcdefgh" }
    for (let level = 0; level < 400; level++) chain = { chain }
    outer.detail = chain
    const redacted = RedactedLogger.redactArgument(outer, redactor) as Error & { detail?: unknown }
    // `inspect` of an Error shows its stack, so the member is read directly.
    const rendered = inspect(redacted.detail, { depth: null })
    expect(rendered).not.toContain("sk-live-abcdefgh")
    expect(rendered).toContain(Redaction.depthMarker)
  })

  it("stops at the depth cap on a long chain of nested errors", () => {
    // The Error walk recurses through Error-valued members, so a deep cause
    // chain is its own way to exhaust the stack. The cap binds there too.
    const redactor = Redaction.make()
    let nested = new Error("root token=sk-live-abcdefgh") as Error & { inner?: unknown }
    for (let level = 0; level < 250; level++) {
      const outer = new Error(`level ${level}`) as Error & { inner?: unknown }
      outer.inner = nested
      nested = outer
    }
    const rendered = inspect(RedactedLogger.redactArgument(nested, redactor), { depth: null })
    expect(rendered).not.toContain("sk-live-abcdefgh")
    expect(rendered).toContain(Redaction.depthMarker)
  })

  it.effect("names a too-deep value on the line rather than losing the line", () =>
    Effect.gen(function*() {
      // Pinned 2026-09-01, the seam between the two depth policies. The journal
      // path THROWS past `Redaction.maxDepth`, because a durable row quietly
      // truncated to a marker is worse than a refused write. On a log line that
      // throw is caught one frame up in `redactArgument`, which replaces EVERY
      // argument with `[Unrenderable]`, so one deep member would cost the
      // operator the whole line. `wrap` therefore builds its redactor with
      // `onTooDeep: "name"`: the deep member is named, the rest of the line
      // survives, and the credential under the cap is never reached at all.
      const seen: Array<unknown> = []
      const direct = Logger.make<unknown, void>((options) => {
        seen.push(options.message)
      })
      let chain: Record<string, unknown> = { token: "sk-live-abcdefgh" }
      for (let level = 0; level < Redaction.maxDepth + 2; level++) chain = { chain }
      yield* Effect.logInfo("deploying", chain).pipe(
        Effect.provide(Logger.layer([RedactedLogger.wrap(direct)]))
      )
      const text = JSON.stringify(seen)
      expect(text).not.toContain("sk-live-abcdefgh")
      expect(text).not.toContain("[Unrenderable]")
      expect(text).toContain("deploying")
      expect(text).toContain(Redaction.depthMarker)
    }))

  it("does not leak a credential an error's own name carries", () => {
    // `plainError` copied the original's `name` verbatim while running message
    // and stack through the rules. It is reached exactly for the classes whose
    // name is caller data rather than a class name, and the console path hides
    // it because the console re-runs the rules over the rendered string. The
    // tracer logger does not, so this went to OTLP in clear.
    const redactor = Redaction.make()
    class ApiError extends Error {
      readonly #token: string
      constructor(message: string, token: string) {
        super(message)
        this.#token = token
      }
      override get name(): string {
        return `ApiError(${this.#token})`
      }
    }
    const redacted = RedactedLogger.redactArgument(
      new ApiError("request refused", "sk-live-e2ecase22NEVERLOGTHIS"),
      redactor
    ) as Error
    expect(String(redacted.name)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    expect(inspect(redacted)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
  })

  it("does not leak a credential a binary view's class name carries", () => {
    // `describeBinary` interpolated the constructor name into the `[Binary]`
    // value without redacting it, on the journal WRITE path.
    const redactor = Redaction.make()
    const named = { [`token=sk-live-e2ecase22NEVERLOGTHIS`]: class extends Uint8Array {} }[
      `token=sk-live-e2ecase22NEVERLOGTHIS`
    ]!
    expect(JSON.stringify(redactor(new named([1, 2])))).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
  })

  it("keeps a caller's member on a binary view instead of routing it through __proto__", () => {
    // The binary branch built its result with `named[key] = …`, the literal
    // `__proto__` hole the object branch documents and avoids.
    const redactor = Redaction.make()
    const view = new Uint8Array([1])
    Object.defineProperty(view, "__proto__", {
      value: { kept: "important" },
      enumerable: true,
      configurable: true,
      writable: true
    })
    const result = redactor(view) as Record<string, unknown>
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype)
    expect(JSON.stringify(result)).toContain("kept")
  })

  it("names a large binary view without walking a property per byte", () => {
    // `Object.entries` on a view materialises one pair per byte before the
    // index filter discards them: 1 MB cost 312 ms on the journal write path.
    const redactor = Redaction.make()
    const started = Date.now()
    const result = redactor(Buffer.alloc(4_000_000, 7))
    expect(Date.now() - started).toBeLessThan(200)
    expect(JSON.stringify(result)).toContain("4000000 bytes")
  })

  it("does not leak a credential a binary view carries into the journal", () => {
    // `Redaction.redact` is the JOURNAL WRITE path, not only the log path:
    // SqlJournal encodes `redact(payload)` into `payload_json`. Handing a
    // binary view back untouched to avoid rendering one key per byte therefore
    // wrote a caller's own `apiKey` property into a durable row in clear.
    const redactor = Redaction.make()
    const bytes = Object.assign(new Uint8Array([1, 2, 3, 4]), {
      apiKey: "sk-live-e2ecase22NEVERLOGTHIS",
      note: "token=sk-live-e2ecase22NEVERLOGTHIS"
    })
    expect(JSON.stringify(redactor(bytes))).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    expect(JSON.stringify(redactor({ body: bytes }))).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    expect(inspect(redactor(bytes))).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
  })

  it("does not leak a credential an object key carries", () => {
    // A key is text too. The walk rewrote every value and no key, so a
    // credential used as a log annotation key, which Effect renders as
    // `key=value`, survived the rules on the operator's terminal and became an
    // OTLP span attribute NAME.
    const redactor = Redaction.make()
    const keyed = { "sk-live-e2ecase22NEVERLOGTHIS": "seat" }
    expect(JSON.stringify(redactor(keyed))).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
  })

  it("does not leak a credential carried by a function or a symbol", () => {
    // The shared walker returns anything that is neither a string nor an
    // object untouched, so a function's own properties never met a rule and
    // `util.inspect` printed them: `[Function: deploy] { token: 'sk-...' }`
    // reached the operator's terminal on the very path case 22 guards.
    const redactor = Redaction.make()
    const handler = Object.assign(() => undefined, { token: "sk-live-abcdefgh" })
    expect(inspect(RedactedLogger.redactArgument(handler, redactor))).not.toContain("sk-live-abcdefgh")
    expect(inspect(RedactedLogger.redactArgument(Symbol("sk-live-abcdefgh"), redactor))).not.toContain(
      "sk-live-abcdefgh"
    )
    class Holder {
      static readonly token = "sk-live-abcdefgh"
    }
    expect(inspect(RedactedLogger.redactArgument(Holder, redactor))).not.toContain("sk-live-abcdefgh")
  })

  it("does not leak a credential a log span carries", () => {
    // Effect's span sanitizer folds `token=` into `token_`, and `_` is a word
    // character, so the api-key rule's leading \b could never fire after it.
    // The assignment rule documents this exact hazard and already guards it.
    const redactor = Redaction.make()
    expect(String(redactor("fetch_token_sk-live-abcdefgh=0ms"))).not.toContain("sk-live-abcdefgh")
    expect(String(redactor("ANTHROPIC_sk-ant-api03-abcdefghij"))).not.toContain("sk-ant-api03-abcdefghij")
  })

  it("names a binary view rather than rebuilding it one key per byte", () => {
    // Restated 2026-09-01: the first form asserted the view was handed back as
    // itself, which put a caller's own property into a journal row in clear.
    // The size half of the finding stands, so the bytes are named instead.
    const redactor = Redaction.make()
    const bytes = Object.assign(Buffer.alloc(100_000, 7), { seat: "sk-live-e2ecase22NEVERLOGTHIS" })
    const rendered = inspect(RedactedLogger.redactArgument(bytes, redactor))
    expect(rendered).toContain(Redaction.binaryMarker)
    expect(rendered).toContain("100000 bytes")
    expect(rendered).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    expect(rendered.length).toBeLessThan(500)
  })

  it("does not leak a credential the walk cannot reach when the console refuses", () => {
    // Round 5's leak: the delegate's fallback rendered a value the rules had
    // never seen. These are the two shapes that exposed it.
    const redactor = Redaction.make()
    const seen: Array<ReadonlyArray<unknown>> = []
    const brittle = {
      ...console,
      log: (...args: ReadonlyArray<unknown>) => {
        if (seen.length === 0) {
          seen.push(args)
          throw new TypeError("cannot render that")
        }
        seen.push(args)
      }
    } as unknown as Console.Console
    const view = RedactedLogger.redactingConsole(brittle, redactor)
    const hidden = { toJSON: (): string => "Bearer sk-live-abcdefgh" }
    const leaky = Object.assign(() => "sk-live-abcdefgh", { note: "sk-live-abcdefgh" })
    expect(() => view.log(hidden, leaky)).not.toThrow()
    const printed = seen.map((entry) => entry.map((value) => inspect(value)).join(" ")).join("\n")
    expect(printed).not.toContain("sk-live-abcdefgh")
  })

  it("survives a console that refuses every call", () => {
    // The marker retry sits inside the first catch with no guard of its own.
    const redactor = Redaction.make()
    const always = {
      ...console,
      log: () => {
        throw new TypeError("always refuse")
      }
    } as unknown as Console.Console
    const view = RedactedLogger.redactingConsole(always, redactor)
    expect(() => view.log("token=sk-live-abcdefgh")).not.toThrow()
  })

  it("does not leak a credential a RegExp was built from", () => {
    // Restated 2026-09-01: this asserted the value came back as a RegExp with
    // a redacted source. Rebuilding a RegExp from redacted text can throw a
    // SyntaxError from inside the logger, so the class is no longer preserved.
    // What matters is unchanged and still asserted: the credential is gone.
    const redactor = Redaction.make()
    const rendered = inspect(RedactedLogger.redactArgument(new RegExp("sk-live-abcdefgh"), redactor))
    expect(rendered).not.toContain("sk-live-abcdefgh")
  })

  it("renders a value nested past the walk's depth instead of exhausting the stack", () => {
    const redactor = Redaction.make()
    let deep: Record<string, unknown> = { token: "sk-live-abcdefgh" }
    for (let level = 0; level < 20_000; level++) deep = { deep }
    expect(() => RedactedLogger.redactArgument(deep, redactor)).not.toThrow()
  })

  it("collapses an exotic value to its plain redacted form", () => {
    // Restated 2026-09-01: this pinned the type-preserving render (a Date
    // stayed a Date, a Map a Map, a class instance its class). That render is
    // gone: it rebuilt each value on its own prototype, and a host class keeps
    // state a property walk cannot see, so the clone threw the moment a brand
    // check read it and killed the run. The collapse is documented in
    // the release policy. The invariant this case now holds is the one that
    // matters: whatever the shape, nothing leaks and nothing throws.
    const redactor = Redaction.make()
    const values: ReadonlyArray<unknown> = [
      new Date(0),
      new Map([["apiKey", "sk-live-abcdefgh"]]),
      new Set(["token=sk-live-abcdefgh"]),
      new URL("https://example.test/?token=sk-live-abcdefgh"),
      { apiKey: "sk-live-abcdefgh", endpoint: "https://example.test" },
      ["token=sk-live-abcdefgh"]
    ]
    for (const value of values) {
      const rendered = inspect(RedactedLogger.redactArgument(value, redactor))
      expect(rendered).not.toContain("sk-live-abcdefgh")
    }
    // A plain object still renders as itself, with its credential replaced.
    expect(RedactedLogger.redactArgument({ a: ["token=sk-live-abcdefgh"] }, redactor)).toEqual({
      a: [`token=${Redaction.placeholder}`]
    })
  })

  it("redacts every reference to one error, not only the first", () => {
    // A diamond: two fields of one error naming the same child. The cycle
    // guard used to hand back the original on the second visit, so the
    // credential survived on `second` while `first` was clean.
    const base = new Error("upstream token=sk-live-abcdefgh")
    const top = new Error("deploy failed") as Error & { first?: unknown; second?: unknown }
    top.first = base
    top.second = base
    const redacted = RedactedLogger.redactArgument(top, Redaction.make()) as Error & {
      first: Error
      second: Error
    }
    expect(redacted.first.message).not.toContain("sk-live-abcdefgh")
    expect(redacted.second.message).not.toContain("sk-live-abcdefgh")
    expect(redacted.second).toBe(redacted.first)
  })

  it.effect("redacts a credential-named log annotation wholesale", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(
        Effect.logInfo("deploying").pipe(
          Effect.annotateLogs({ apiKey: "sk-ant-api03-abcdefgh", endpoint: "https://example.test" })
        )
      )
      const text = rendered(recorded)
      expect(text).not.toContain("sk-ant-api03-abcdefgh")
      expect(text).toContain(Redaction.placeholder)
      expect(text).toContain("https://example.test")
    }))

  it.effect("redacts a credential inside a logged structure without flattening it", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(
        Effect.logInfo("request", { headers: ["Authorization: Bearer abcdefghijkl"], attempt: 2 })
      )
      const structure = recorded.lines.flat().find((value) =>
        typeof value === "object" && value !== null && "attempt" in value
      )
      expect(structure).toEqual({ headers: ["Authorization: Bearer [REDACTED_TOKEN]"], attempt: 2 })
    }))

  it.effect("keeps a logged Error an Error and redacts its message and stack", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(Effect.logError("failed", new Error("POST failed: token=sk-live-abcdefgh")))
      const error = recorded.lines.flat().find((value) => value instanceof Error) as Error
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe(`POST failed: token=${Redaction.placeholder}`)
      expect(error.stack).not.toContain("sk-live-abcdefgh")
    }))

  it("rebuilds a stackless Error without inventing a stack", () => {
    const bare = new Error("token=sk-live-abcdefgh")
    Object.defineProperty(bare, "stack", { value: undefined })
    const rebuilt = RedactedLogger.redactArgument(bare, Redaction.make()) as Error
    expect(rebuilt).toBeInstanceOf(Error)
    expect(rebuilt.message).toBe(`token=${Redaction.placeholder}`)
    expect(rebuilt.stack).toBeUndefined()
  })

  it("forwards a console method that carries no output untouched", () => {
    const recorded = capture()
    const redacting = RedactedLogger.redactingConsole(recorded.console, Redaction.make())
    // `groupEnd` and `clear` take no arguments at all, so there is nothing for
    // the rules to read and the delegate is bound straight through.
    redacting.groupEnd()
    redacting.clear()
    redacting.log("Bearer abcdefghijkl")
    expect(rendered(recorded)).toBe("Bearer [REDACTED_TOKEN]")
  })

  it("redacts the label a counter or a timer prints", () => {
    // `count`, `countReset`, `time`, and `timeEnd` were bound straight to the
    // delegate as if they carried no output, but every one of them ECHOES its
    // caller-supplied label: `console.count("api_key=sk-abcdefgh")` prints
    // `api_key=sk-abcdefgh: 1`. All four put a credential on the operator's
    // terminal.
    const secrets = ["TOKEN=dummy-secret", "api_key=sk-abcdefgh", "Bearer abcdefghijkl"]
    for (const label of secrets) {
      const recorded = capture()
      const redacting = RedactedLogger.redactingConsole(recorded.console, Redaction.make())
      redacting.count(label)
      redacting.countReset(label)
      redacting.time(label)
      redacting.timeEnd(label)
      const output = rendered(recorded)
      expect(output).not.toContain("dummy-secret")
      expect(output).not.toContain("sk-abcdefgh")
      expect(output).not.toContain("abcdefghijkl")
      expect(output).not.toContain(label)
      expect(recorded.lines).toHaveLength(4)
    }
  })

  it("keeps a timer's label the same value at both ends", () => {
    // `timeLog` already redacted its label while `time` did not, so a timer
    // registered under a raw label could never be found again under the
    // redacted one. All four sharing the rules is what makes the pair match.
    const recorded = capture()
    const redacting = RedactedLogger.redactingConsole(recorded.console, Redaction.make())
    const label = "phase token=sk-abcdefgh"
    redacting.time(label)
    redacting.timeLog(label)
    redacting.timeEnd(label)
    expect(recorded.lines.map((line) => line[0])).toEqual([
      `phase token=${Redaction.placeholder}`,
      `phase token=${Redaction.placeholder}`,
      `phase token=${Redaction.placeholder}`
    ])
  })

  it("wraps a logger once", () => {
    const sink = Logger.make<unknown, void>(() => {})
    const wrapped = RedactedLogger.wrap(sink)
    expect(RedactedLogger.isRedacted(sink)).toBe(false)
    expect(RedactedLogger.isRedacted(wrapped)).toBe(true)
    expect(RedactedLogger.wrap(wrapped)).toBe(wrapped)
  })

  it.effect("honours a caller's own rule set", () =>
    Effect.gen(function*() {
      const recorded = capture()
      yield* Effect.logInfo("ship it CODENAME=osprey").pipe(
        Effect.provide(
          RedactedLogger.layer({ rules: [{ id: "codename", pattern: /CODENAME=\w+/g, replace: "CODENAME=[HIDDEN]" }] })
        ),
        Effect.provide(Logger.layer([Logger.consolePretty({ colors: false, mode: "tty" })])),
        Effect.provideService(Console.Console, recorded.console)
      )
      expect(rendered(recorded)).toContain("CODENAME=[HIDDEN]")
    }))

  it.effect("bounds the cost of a long line", () =>
    Effect.gen(function*() {
      // Four hundred thousand characters of the shapes the rules scan for,
      // interleaved so a backtracking engine would have every chance to
      // explode. A linear scan finishes in milliseconds; the budget is three
      // orders of magnitude above that so machine load cannot fail it, and it
      // is still finite, which is the whole claim.
      const line = "Bearer " + "aaaaaaaa-".repeat(40_000) + " api_key=" + "b".repeat(200_000)
      expect(line.length).toBeGreaterThan(400_000)
      const started = Date.now()
      const recorded = yield* logged(Effect.logInfo(line))
      const elapsed = Date.now() - started
      expect(elapsed).toBeLessThan(2_000)
      const text = rendered(recorded)
      expect(text).toContain("Bearer [REDACTED_TOKEN]")
      expect(text).toContain(`api_key=${Redaction.placeholder}`)
    }))

  // `packages/smithers/src/bin.ts` sends every built-in logger to `console.error`
  // through `Logger.LogToStderr` and keeps whichever logger is installed, so
  // the rules have to hold for the JSON document a machine-readable stream
  // carries as well as for the pretty line a terminal shows.
  it.effect("redacts the JSON document the structured logger writes", () =>
    Effect.gen(function*() {
      const recorded = yield* loggedWith(
        Logger.consoleJson,
        Effect.logInfo("calling https://example.test/deploy with Bearer sk-live-abcdefgh").pipe(
          Effect.annotateLogs({ apiKey: "sk-ant-api03-abcdefgh" })
        )
      )
      const document = JSON.parse(String(recorded.lines.flat()[0]))
      // Re-pinned 2026-09-01: `bearer-token` wins the span, so the structured
      // document carries the token marker in its message.
      expect(document.message).toBe("calling https://example.test/deploy with Bearer [REDACTED_TOKEN]")
      expect(document.annotations.apiKey).toBe(Redaction.placeholder)
    }))

  it.effect("leaves the logger set alone when nothing matches", () =>
    Effect.gen(function*() {
      const recorded = yield* logged(Effect.logInfo("plain operational line"))
      expect(rendered(recorded)).toContain("plain operational line")
    }))
  // ---------------------------------------------------------------------------
  // The prototype an error copy used to keep.
  //
  // Every case below plants a credential on a PROTOTYPE, not on the value. The
  // copy was built with `Object.create(Object.getPrototypeOf(error))` and its
  // own-key walk read `Reflect.ownKeys(error)`, so nothing inherited was ever
  // offered to the rules while every renderer read it. Each case is driven
  // through the shipped path, and the OTLP ones assert on tracer span output
  // rather than on a console, because `redactingConsole` redacts the console's
  // ARGUMENTS and node renders them afterwards, which hides this whole class.
  // ---------------------------------------------------------------------------

  it.effect("does not leak a credential an error's INHERITED name carries", () =>
    Effect.gen(function*() {
      // Effect reads `error.name` when it renders a cause. A subclass whose
      // prototype defines `name` needs no own property to be read, so the copy
      // inherited the credential and `effect.cause` carried it to the collector
      // in clear.
      class Refused extends Error {}
      Object.defineProperty(Refused.prototype, "name", {
        value: "sk-live-e2ecase22NEVERLOGTHIS",
        configurable: true
      })
      const spans = yield* traced(Effect.logError(Cause.fail(new Refused("request refused"))))
      const cause = String(onlyEvent(spans)[2]["effect.cause"])
      expect(cause).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(cause).toContain("request refused")
    }))

  it.effect("does not leak a credential an error's INHERITED cause carries", () =>
    Effect.gen(function*() {
      // `Cause.pretty` follows `error.cause`, and a prototype can supply one.
      class Refused extends Error {}
      ;(Refused.prototype as { cause?: unknown }).cause = new Error("sk-live-e2ecase22NEVERLOGTHIS")
      const spans = yield* traced(Effect.logError(Cause.fail(new Refused("request refused"))))
      const cause = String(onlyEvent(spans)[2]["effect.cause"])
      expect(cause).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(cause).toContain("request refused")
    }))

  it.effect("does not leak a credential an error's INHERITED toJSON returns", () =>
    Effect.gen(function*() {
      // The tracer logger names the span event with `toStringUnknown` of the
      // message, which reaches `Inspectable.toJson`, which calls `toJSON`. A
      // surviving `toJSON` was recorded as a closed leak class in commit
      // 94416d3924; keeping the prototype reopened it from the other side.
      class Refused extends Error {
        toJSON(): unknown {
          return { token: "sk-live-e2ecase22NEVERLOGTHIS" }
        }
      }
      const spans = yield* traced(Effect.logInfo(new Refused("request refused")))
      const [name, , attributes] = onlyEvent(spans)
      expect(name).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
      expect(JSON.stringify(attributes)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    }))

  it.effect("does not leak a credential an error's INHERITED inspect hook prints", () =>
    Effect.gen(function*() {
      // A symbol key on the prototype: `Reflect.ownKeys` of the value never saw
      // it, and `util.inspect` calls it, so it reached the operator's terminal
      // and the `.flows/logs/<runId>.log` stream under every console logger.
      class Refused extends Error {}
      Object.defineProperty(Refused.prototype, Symbol.for("nodejs.util.inspect.custom"), {
        value: () => "token=sk-live-e2ecase22NEVERLOGTHIS",
        configurable: true
      })
      const recorded = yield* logged(Effect.logError("action failed", new Refused("request refused")))
      expect(rendered(recorded)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    }))

  it.effect("does not leak a credential an error's INHERITED toStringTag carries", () =>
    Effect.gen(function*() {
      class Refused extends Error {}
      Object.defineProperty(Refused.prototype, Symbol.toStringTag, {
        value: "sk-live-e2ecase22NEVERLOGTHIS",
        configurable: true
      })
      const recorded = yield* logged(Effect.logError("action failed", new Refused("request refused")))
      expect(rendered(recorded)).not.toContain("sk-live-e2ecase22NEVERLOGTHIS")
    }))

  it("does not carry an error's own render hooks onto the copy", () => {
    // A hook is text the walk cannot rewrite in place, and naming it
    // `[Function]` under the name the language CALLS is worse than dropping it:
    // `String(err)` would then throw from inside the renderer, which is the
    // failure this module exists to avoid. A non-function hook does the same.
    const redactor = Redaction.make()
    const hooked = new Error("request refused") as Error & Record<PropertyKey, unknown>
    hooked["toString"] = () => "token=sk-live-abcdefgh"
    hooked["valueOf"] = () => "token=sk-live-abcdefgh"
    hooked["toJSON"] = () => ({ token: "sk-live-abcdefgh" })
    Object.defineProperty(hooked, "constructor", {
      value: { name: "sk-live-abcdefgh" },
      enumerable: true,
      configurable: true,
      writable: true
    })
    hooked[Symbol.toPrimitive] = "sk-live-abcdefgh"
    Object.defineProperty(hooked, Symbol.for("sk-live-abcdefgh"), { value: 1, enumerable: true })
    const copy = RedactedLogger.redactArgument(hooked, redactor) as Error
    expect(() => String(copy)).not.toThrow()
    expect(() => JSON.stringify(copy)).not.toThrow()
    expect(String(copy)).not.toContain("sk-live-abcdefgh")
    expect(inspect(copy)).not.toContain("sk-live-abcdefgh")
    expect(String(JSON.stringify(copy))).not.toContain("sk-live-abcdefgh")
    expect(copy.message).toBe("request refused")
  })

  it("redacts an error's own member NAME as well as its value", () => {
    // The object walk redacts a key; the Error walk defined the original key
    // straight onto the copy, so the same credential-as-a-field-name reached
    // the terminal by the Error route. A credential-NAMED member is replaced
    // wholesale, the way the journal's own walk replaces one.
    const redactor = Redaction.make()
    const carrier = new Error("request refused") as Error & Record<string, unknown>
    carrier["sk-live-abcdefgh"] = "seat"
    carrier["apiKey"] = "hunter2"
    const copy = RedactedLogger.redactArgument(carrier, redactor) as Record<string, unknown>
    expect(inspect(copy)).not.toContain("sk-live-abcdefgh")
    expect(copy["apiKey"]).toBe(Redaction.placeholder)
  })

  it("keeps rendering an error whose own text refuses to be read", () => {
    // `name`, `message` and `stack` can each be an accessor that throws, and
    // reading one happens while the line renders. A refusal costs that piece of
    // text and nothing else.
    const redactor = Redaction.make()
    const hostile = Object.create(Error.prototype) as Error
    for (const key of ["name", "message", "stack"]) {
      Object.defineProperty(hostile, key, {
        get: () => {
          throw new TypeError("refused")
        },
        configurable: true
      })
    }
    const copy = RedactedLogger.redactArgument(hostile, redactor) as Error
    expect(copy).toBeInstanceOf(Error)
    expect(copy.name).toBe("Error")
    expect(copy.message).toBe("")
    expect(copy.stack).toBeUndefined()
  })

  // ---------------------------------------------------------------------------
  // What the binary walk is actually bounded by.
  // ---------------------------------------------------------------------------

  it("does not walk a view that under-reports its own size", () => {
    // `byteLength` was read as an ordinary property, so a caller could shadow
    // it and the bound believed the value. A pooled chunk reporting the bytes
    // it has USED is an ordinary pattern, not an adversarial one, and a 4 MB
    // chunk reporting 12 walked one property per byte anyway. The size now
    // comes from the internal slot, which nothing a caller writes answers for.
    const redactor = Redaction.make()
    class Chunk extends Uint8Array {
      used = 12
      override get byteLength(): number {
        return this.used
      }
    }
    const chunk = new Chunk(4_000_000)
    const started = Date.now()
    const result = redactor(chunk) as Record<string, unknown>
    expect(Date.now() - started).toBeLessThan(200)
    // The true size, not the reported one, and no per-byte member.
    expect(String(result[Redaction.binaryMarker])).toContain("4000000 bytes")
    expect(Object.keys(result)).toEqual([Redaction.binaryMarker])
  })

  it("names a proxied view instead of rebuilding it one key per byte", () => {
    // `ArrayBuffer.isView` reads an internal slot and a proxy has none of its
    // own, so a proxied 2 MB view fell through to the object branch: 2,000 ms
    // and 22.9 million characters for one logged value. A proxy forwards
    // `getPrototypeOf`, so the prototype chain answers where the brand cannot.
    const redactor = Redaction.make()
    const proxied = new Proxy(Object.assign(new Uint8Array(2_000_000), { seat: "sk-live-abcdefgh" }), {})
    const started = Date.now()
    const result = redactor(proxied)
    expect(Date.now() - started).toBeLessThan(200)
    const text = JSON.stringify(result)
    expect(text.length).toBeLessThan(200)
    expect(text).not.toContain("sk-live-abcdefgh")
    // It will not answer from an internal slot, so the bytes are named and no
    // member is read at all.
    expect(result).toEqual({ [Redaction.binaryMarker]: Redaction.binaryMarker })
  })

  it("stops after the member bound on a small view carrying many properties", () => {
    // The size bounds the bytes, not the properties. A four-byte view with more
    // members than the bound costs one rule scan per member without the second
    // half of the bound.
    const redactor = Redaction.make()
    const view = new Uint8Array(4)
    for (let index = 0; index <= Redaction.binaryWalkLimit; index++) {
      Object.defineProperty(view, `p${index}`, { value: "token=sk-live-abcdefgh", enumerable: true })
    }
    const result = redactor(view) as Record<string, unknown>
    // The `[Binary]` name plus exactly the bound, and nothing past it.
    expect(Object.keys(result).length).toBe(Redaction.binaryWalkLimit + 1)
    expect(JSON.stringify(result)).not.toContain("sk-live-abcdefgh")
  })

  it("names a view and a buffer whose sizes live in different slots", () => {
    // Three prototypes define `byteLength` over an internal slot, and the walk
    // asks each in turn. A typed array answers the first, a DataView the
    // second, an ArrayBuffer the third.
    const redactor = Redaction.make()
    expect(JSON.stringify(redactor(new Uint8Array(4)))).toContain("Uint8Array 4 bytes")
    expect(JSON.stringify(redactor(new DataView(new ArrayBuffer(8))))).toContain("DataView 8 bytes")
    expect(JSON.stringify(redactor(new ArrayBuffer(16)))).toContain("ArrayBuffer 16 bytes")
  })

  it("stops climbing a prototype chain that never ends", () => {
    // A proxy may hand back a fresh prototype every time it is asked, which is
    // an endless chain and an unbounded loop inside the walk.
    const redactor = Redaction.make()
    const endless = new Proxy({ token: "sk-live-abcdefgh" }, { getPrototypeOf: () => ({}) })
    expect(JSON.stringify(redactor(endless))).not.toContain("sk-live-abcdefgh")
  })
})
