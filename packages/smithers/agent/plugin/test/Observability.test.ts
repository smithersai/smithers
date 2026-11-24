import { Effect, Fiber, Metric, Tracer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { describe, expect, it } from "vitest"
import type { SequentialHook } from "../src/Hooks.ts"
import * as Instrument from "../src/internal/Instrument.ts"
import * as Load from "../src/Load.ts"
import * as Plugins from "../src/Plugins.ts"
import * as Resolve from "../src/Resolve.ts"
import { host, minimal } from "./support/hostFacts.ts"

interface TestHooks {
  readonly observe: SequentialHook<(secret: string) => Effect.Effect<void>>
}

const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
}

const attributes = (span: Tracer.NativeSpan | undefined) => Object.fromEntries(span?.attributes.entries() ?? [])

const counted = (counter: typeof Instrument.hookRuns, labels: Record<string, string>) =>
  Effect.map(Metric.value(Metric.withAttributes(counter, labels)), (state) => state.count)

describe("plugin observability", () => {
  it("traces and counts each handler, with error.code on a timeout and no argument values", async () => {
    const { spans, tracer } = recordingTracer()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const resolved = yield* Resolve.resolve<TestHooks>([
          { name: "quick", hooks: { observe: () => Effect.void } },
          { name: "stalled", hooks: { observe: () => Effect.never } }
        ], { hooks: { observe: "sequential" } })
        const failures = { hook: "observe", outcome: "hook_failed" }
        const successes = { hook: "observe", outcome: "success" }
        const before = [yield* counted(Instrument.hookRuns, successes), yield* counted(Instrument.hookRuns, failures)]
        const fiber = yield* Effect.forkChild(
          Plugins.make(resolved).sequential("observe", "secret-arg").pipe(Effect.flip)
        )
        yield* TestClock.adjust(Resolve.defaultHandlerTimeout)
        const error = yield* Fiber.join(fiber)
        const after = [yield* counted(Instrument.hookRuns, successes), yield* counted(Instrument.hookRuns, failures)]
        return { error, before, after }
      }).pipe(Effect.provide(TestClock.layer()), Effect.provideService(Tracer.Tracer, tracer))
    )
    expect(result.error).toMatchObject({ code: "hook_failed", plugin: "stalled", hook: "observe" })
    expect(result.after).toEqual([result.before[0]! + 1, result.before[1]! + 1])
    const hooks = spans.filter((span) => span.name === "Plugins.hook")
    expect(hooks.map(attributes)).toEqual([
      { "plugin.name": "quick", "plugin.hook": "observe" },
      { "plugin.name": "stalled", "plugin.hook": "observe", "error.code": "hook_failed" }
    ])
    expect(hooks.map((span) => span.status._tag)).toEqual(["Ended", "Ended"])
    expect(JSON.stringify(spans.map(attributes))).not.toContain("secret-arg")
  })

  it("traces and counts resolution, with error.code on a refused plugin list", async () => {
    const { spans, tracer } = recordingTracer()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const refused = { outcome: "duplicate_name" }
        const before = [
          yield* counted(Instrument.resolutions, { outcome: "success" }),
          yield* counted(Instrument.resolutions, refused)
        ]
        yield* Resolve.resolve([{ name: "one" }])
        const error = yield* Resolve.resolve([{ name: "one" }, { name: "one" }]).pipe(Effect.flip)
        const after = [
          yield* counted(Instrument.resolutions, { outcome: "success" }),
          yield* counted(Instrument.resolutions, refused)
        ]
        return { error, before, after }
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )
    expect(result.error.code).toBe("duplicate_name")
    expect(result.after).toEqual([result.before[0]! + 1, result.before[1]! + 1])
    expect(spans.filter((span) => span.name === "Plugins.resolve").map(attributes)).toEqual([
      {},
      { "error.code": "duplicate_name" }
    ])
  })

  it("traces a load with its counts and counts every outcome by reason", async () => {
    const { spans, tracer } = recordingTracer()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const outcomes = ["loaded", "conflict", "invalid"]
        const read = Effect.forEach(outcomes, (outcome) => counted(Instrument.loads, { outcome }))
        const before = yield* read
        const loaded = yield* Load.load(host(), [
          { tier: "built-in", manifest: minimal("fine") },
          { tier: "built-in", manifest: minimal("dup") },
          { tier: "built-in", manifest: minimal("dup") },
          { tier: "built-in", manifest: 5 }
        ])
        return { loaded, before, after: yield* read }
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
    )
    expect(result.loaded.contributions.plugins.map((plugin) => plugin.id)).toEqual(["fine"])
    expect(result.after).toEqual([result.before[0]! + 1, result.before[1]! + 2, result.before[2]! + 1])
    expect(attributes(spans.find((span) => span.name === "Plugins.load"))).toEqual({
      "plugin.candidates": 4,
      "plugin.loaded": 1,
      "plugin.refused": 3
    })
  })
})
