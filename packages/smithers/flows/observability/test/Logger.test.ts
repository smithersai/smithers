import { Effect, Logger as EffectLogger, References, Tracer } from "effect"
import { describe, expect, it } from "vitest"
import * as Logger from "../src/Logger.vibe"

const captured = () => {
  const values: Array<{ options: EffectLogger.Options<unknown>; annotations: Readonly<Record<string, unknown>> }> = []
  const logger = EffectLogger.make<unknown, void>((options) => {
    values.push({ options, annotations: options.fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { logger, values }
}

describe("Logger layers", () => {
  it.each([undefined, "Debug", "Warn"] as const)("silences loggers with minimum level %s", async (minimumLogLevel) => {
    const ambient = captured()
    const level = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logFatal("silent even above the minimum")
        return yield* References.MinimumLogLevel
      }).pipe(
        Effect.provide(Logger.layerNoop(minimumLogLevel === undefined ? undefined : { minimumLogLevel })),
        Effect.provide(EffectLogger.layer([ambient.logger])),
        Effect.provideService(References.MinimumLogLevel, "Trace")
      )
    )

    expect(level).toBe(minimumLogLevel ?? "None")
    expect(ambient.values).toEqual([])
  })

  it.each([false, true])("merges the ambient logger only when requested: %s", async (mergeWithExisting) => {
    const ambient = captured()
    const added = captured()
    await Effect.runPromise(
      Effect.logInfo("delivered once per sink").pipe(
        Effect.provide(Logger.layer(added.logger, { mergeWithExisting })),
        Effect.provide(EffectLogger.layer([ambient.logger]))
      )
    )

    expect(added.values.map(({ options }) => options.message)).toEqual([["delivered once per sink"]])
    expect(ambient.values.map(({ options }) => options.message)).toEqual(
      mergeWithExisting ? [["delivered once per sink"]] : []
    )
  })

  it("exposes pretty, structured, and noop layers", () => {
    expect(Logger.layerPrettyDev()).toBeDefined()
    expect(Logger.layerStructuredJson()).toBeDefined()
    expect(Logger.layerNoop()).toBeDefined()
  })

  it("uses the v4 minimum-level reference and preserves annotations", async () => {
    const { logger, values } = captured()
    const program = Effect.gen(function*() {
      yield* Effect.logDebug("hidden")
      yield* Effect.logInfo("visible")
      return yield* References.MinimumLogLevel
    }).pipe(
      Effect.annotateLogs("runId", "run-1"),
      Effect.provide(EffectLogger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Info")
    )

    expect(await Effect.runPromise(program)).toBe("Info")
    expect(values).toHaveLength(1)
    expect(values[0]?.annotations).toEqual({ runId: "run-1" })
  })

  it("leaves an application-chosen minimum level alone and pins it only when asked", async () => {
    const inherited = captured()
    const survived = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logDebug("below the effect default but above the application's")
        return yield* References.MinimumLogLevel
      }).pipe(
        Effect.provide(Logger.layer(inherited.logger)),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )

    expect(survived).toBe("Debug")
    expect(inherited.values).toHaveLength(1)

    const pinned = captured()
    const overridden = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("below the pinned level")
        return yield* References.MinimumLogLevel
      }).pipe(
        Effect.provide(Logger.layer(pinned.logger, { minimumLogLevel: "Warn" })),
        Effect.provideService(References.MinimumLogLevel, "Debug")
      )
    )

    expect(overridden).toBe("Warn")
    expect(pinned.values).toHaveLength(0)
  })

  it("adds the current span's trace_id and span_id to a structured record, and nothing outside a span", async () => {
    const records: Array<ReturnType<typeof Logger.formatStructured.log>> = []
    const sink = EffectLogger.make((options) => {
      records.push(Logger.formatStructured.log(options))
    })
    const parent = Tracer.externalSpan({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logInfo("outside")
        const span = yield* Effect.logInfo("inside").pipe(
          Effect.andThen(Effect.currentSpan),
          Effect.withSpan("work", { parent })
        )
        yield* Effect.logInfo("caller's ids").pipe(
          Effect.annotateLogs({ trace_id: "relayed-trace", span_id: "relayed-span" }),
          Effect.withSpan("relay", { parent })
        )
        expect(span.traceId).toBe(parent.traceId)
        expect(records[1]?.annotations).toEqual({ trace_id: parent.traceId, span_id: span.spanId })
      }).pipe(Effect.provide(EffectLogger.layer([sink])))
    )

    expect(records.map((record) => record.message)).toEqual(["outside", "inside", "caller's ids"])
    expect(records[0]?.annotations).toEqual({})
    expect(records[2]?.annotations).toEqual({ trace_id: "relayed-trace", span_id: "relayed-span" })
  })

  it("writes the span's ids into each structured JSON line", async () => {
    const lines: Array<string> = []
    const parent = Tracer.externalSpan({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" })
    const log = console.log
    console.log = (line: string) => void lines.push(line)
    try {
      await Effect.runPromise(
        Effect.logInfo("joined").pipe(
          Effect.withSpan("work", { parent }),
          Effect.provide(Logger.layerStructuredJson())
        )
      )
    } finally {
      console.log = log
    }

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      message: "joined",
      level: "INFO",
      annotations: { trace_id: parent.traceId, span_id: expect.stringMatching(/^[0-9a-f]{16}$/) }
    })
  })

  it("composes `layer` around a caller-supplied logger, defaults and all", async () => {
    const { logger, values } = captured()
    const level = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logDebug("below the default minimum")
        yield* Effect.logInfo("at the default minimum")
        return yield* References.MinimumLogLevel
      }).pipe(Effect.provide(Logger.layer(logger)))
    )

    expect(level).toBe("Info")
    expect(values).toHaveLength(1)
  })
})
