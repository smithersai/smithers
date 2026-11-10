import { describe, expect, it } from "@effect/vitest"
import { Effect, Logger, Metric, References } from "effect"
import * as JournalDecode from "../src/JournalDecode.ts"

describe("safe persisted-step diagnostics", () => {
  it.effect("defaults host identity and returns a typed refusal without journal input", () =>
    Effect.gen(function*() {
      const error = yield* JournalDecode.report("fixed-step")
      expect(error).toBeInstanceOf(JournalDecode.JournalDecodeError)
      expect(error).toMatchObject({
        _tag: "JournalDecodeError",
        stepTag: "fixed-step",
        objectId: "unknown",
        codeVersion: "unknown"
      })
    }))
  it.effect.each(["outcome", "payload", "state"] as const)(
    "logs and counts the %s boundary with injected host identity",
    (boundary) =>
      Effect.gen(function*() {
        const logs: Array<unknown> = []
        const capture = Logger.make((options) =>
          logs.push({ message: options.message, fields: options.fiber.getRef(References.CurrentLogAnnotations) })
        )
        const metric = Metric.withAttributes(JournalDecode.failures, { stepTag: "declared-step", boundary })
        const before = (yield* Metric.value(metric)).count
        const error = yield* JournalDecode.report("declared-step", boundary).pipe(
          Effect.provide(Logger.layer([capture])),
          Effect.provideService(JournalDecode.Identity, { objectId: "object", codeVersion: "commit" })
        )
        expect((yield* Metric.value(metric)).count - before).toBe(1)
        expect(error).toMatchObject({ stepTag: "declared-step", objectId: "object", codeVersion: "commit" })
        expect(logs).toHaveLength(1)
        expect(logs[0]).toMatchObject({
          fields: { stepTag: "declared-step", boundary, objectId: "object", codeVersion: "commit" }
        })
      })
  )
})
