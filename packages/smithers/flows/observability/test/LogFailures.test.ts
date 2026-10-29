import { describe, expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import { LogFailures } from "../src/index.ts"

class Refused extends Data.TaggedError("Refused")<{}> {}

/** Runs `effect` with the counting logger over an ambient logger that records every message, on a fresh registry. */
const counting = <A, E>(effect: Effect.Effect<A, E, LogFailures.Recent>, options?: LogFailures.Options) => {
  const ambient: Array<unknown> = []
  return Effect.gen(function*() {
    const value = yield* effect
    const recent = yield* (yield* LogFailures.Recent).entries
    return { value, recent, ambient }
  }).pipe(
    Effect.provide(LogFailures.layer(options)),
    Effect.provide(Logger.layer([Logger.make(({ message }) => void ambient.push(message))])),
    Effect.provideService(Metric.MetricRegistry, new Map())
  )
}

const count = (attributes: Record<string, string>) =>
  Metric.value(Metric.withAttributes(LogFailures.failures, attributes)).pipe(Effect.map((state) => state.count))

describe("LogFailures", () => {
  it.effect("counts each line at Warn or above by level, record, code and area, and keeps the ambient loggers", () =>
    counting(
      Effect.gen(function*() {
        yield* Effect.logInfo("chat ready")
        yield* Effect.logWarning("outbox write sealed").pipe(Effect.annotateLogs({ reason: "owner", feature: "chat" }))
        yield* Effect.logError("page error").pipe(Effect.annotateLogs({ name: "TypeError", feature: "app" }))
        yield* Effect.logError("page error").pipe(Effect.annotateLogs({ name: "TypeError", feature: "app" }))
        yield* Effect.logFatal("engine gone")
        return {
          sealed: yield* count({ level: "warn", record: "outbox write sealed", code: "owner", area: "chat" }),
          page: yield* count({ level: "error", record: "page error", code: "TypeError", area: "app" }),
          fatal: yield* count({ level: "fatal", record: "engine gone", code: "none", area: "none" }),
          info: yield* count({ level: "info", record: "chat ready", code: "none", area: "none" })
        }
      })
    ).pipe(Effect.map(({ value, ambient }) => {
      expect(value).toEqual({ sealed: 1, page: 2, fatal: 1, info: 0 })
      expect(ambient).toHaveLength(5)
    })))

  it.effect("reads the code from the first annotation present, in order, then from the cause", () =>
    counting(
      Effect.gen(function*() {
        yield* Effect.logWarning("a").pipe(Effect.annotateLogs({ outcome: "failed", errorCode: "sql:Connection" }))
        yield* Effect.logWarning("b").pipe(Effect.annotateLogs({ status: 503, errorCode: 503 }))
        yield* Effect.logWarning("c").pipe(Effect.annotateLogs({ errorCode: "has a message in it", reason: "kept" }))
        yield* Effect.logWarning("d", Cause.fail(new Refused()))
        yield* Effect.logWarning("e", Cause.die(new RangeError("quoted text")))
        yield* Effect.logWarning("f", Cause.die(new Error("quoted text")))
        yield* Effect.logWarning("g", Cause.fail({ code: "too_large" }))
        yield* Effect.logWarning("h", Cause.fail("a string"))
        yield* Effect.logWarning("i", Cause.interrupt())
      }),
      { records: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }
    ).pipe(Effect.map(({ recent }) => {
      expect(recent.map(({ record, code }) => [record, code])).toEqual([
        ["a", "sql:Connection"],
        ["b", "503"],
        ["c", "kept"],
        ["d", "Refused"],
        ["e", "RangeError"],
        ["f", "none"],
        ["g", "too_large"],
        ["h", "none"],
        ["i", "none"]
      ])
    })))

  it.effect("takes a line's code and area from the fields it is told to read", () =>
    counting(
      Effect.logError("x").pipe(Effect.annotateLogs({ errorCode: "ignored", kind: "mine", area: "web" })),
      { codes: ["kind"], area: "area" }
    ).pipe(Effect.map(({ recent }) => expect(recent.map(({ code, area }) => [code, area])).toEqual([["mine", "web"]]))))

  it.effect("names a record only from the program's records, or `other`", () =>
    counting(
      Effect.gen(function*() {
        yield* Effect.logWarning("question not sent")
        yield* Effect.logWarning(`question ${"someone's words"}`)
        yield* Effect.logWarning({ not: "a string" })
      }),
      { records: ["question not sent"] }
    ).pipe(Effect.map(({ recent }) => {
      expect(recent.map(({ record }) => record)).toEqual(["question not sent", "other", "other"])
    })))

  it.effect("without records, keeps a short plain message and caps the distinct ones", () =>
    counting(Effect.gen(function*() {
      yield* Effect.logWarning("chat couldn't restore")
      yield* Effect.logWarning("line\nwith a newline")
      for (let index = 0; index < LogFailures.maxRecords + 1; index++) yield* Effect.logWarning(`record ${index}`)
      return yield* count({ level: "warn", record: "other", code: "none", area: "none" })
    })).pipe(Effect.map(({ value }) => expect(value).toBe(1 + 2))))

  it.effect("caps distinct codes and areas, and keeps only identifiers", () =>
    counting(
      Effect.gen(function*() {
        for (let index = 0; index < LogFailures.maxCodes + 1; index++) {
          yield* Effect.logWarning("w").pipe(Effect.annotateLogs({ code: `code_${index}` }))
        }
        for (let index = 0; index < LogFailures.maxAreas + 1; index++) {
          yield* Effect.logWarning("w").pipe(Effect.annotateLogs({ feature: `area_${index}` }))
        }
        yield* Effect.logWarning("w").pipe(Effect.annotateLogs({ feature: "not an identifier" }))
        return {
          codes: yield* count({ level: "warn", record: "w", code: "other", area: "none" }),
          areas: yield* count({ level: "warn", record: "w", code: "none", area: "other" })
        }
      }),
      { records: ["w"] }
    ).pipe(Effect.map(({ value }) => expect(value).toEqual({ codes: 1, areas: 1 }))))

  it.effect("keeps the latest lines, oldest first, with their span", () =>
    counting(
      Effect.gen(function*() {
        yield* Effect.logWarning("one")
        yield* Effect.logError("two").pipe(Effect.withSpan("work"))
        yield* Effect.logError("three")
      }),
      { keep: 2 }
    ).pipe(Effect.map(({ recent }) => {
      expect(recent.map(({ record, level }) => [record, level])).toEqual([["two", "error"], ["three", "error"]])
      expect(recent[0]?.traceId).toMatch(/^[0-9a-f]{32}$/)
      expect(recent[0]?.spanId).toMatch(/^[0-9a-f]{16}$/)
      expect(recent[1]).not.toHaveProperty("traceId")
      expect(typeof recent[1]?.at).toBe("number")
    })))

  it.effect("keeps nothing when told to keep none, and still counts", () =>
    counting(
      Effect.gen(function*() {
        yield* Effect.logError("gone")
        return yield* count({ level: "error", record: "gone", code: "none", area: "none" })
      }),
      { keep: 0 }
    ).pipe(Effect.map(({ value, recent }) => {
      expect(value).toBe(1)
      expect(recent).toEqual([])
    })))
})
