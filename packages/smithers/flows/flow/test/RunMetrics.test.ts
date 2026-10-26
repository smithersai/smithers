/**
 * `RunMetrics`: the usage metrics every flow run records. Their labels are
 * closed sets or capped, cleaned identifiers; a settlement is classified by
 * its exit's code, never its message; and each recorder lands its metric and
 * its log line, with the same fields, in what the caller provided.
 */
import { describe, expect, it } from "@effect/vitest"
import { Interpreter, RunMetrics } from "@smthrs/flow"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Metric from "effect/Metric"
import * as References from "effect/References"
import * as Schema from "effect/Schema"

class Refused extends Schema.TaggedError<Refused>()("Usage/Refused", { code: Schema.Literal("quota_exceeded") }) {}
class Tagged extends Schema.TaggedError<Tagged>()("Usage/Tagged", { reason: Schema.String }) {}

/**
 * Runs `effect` with a fresh metric registry and a log sink, its usage lines at Info as a telemetry host writes them;
 * answers its value, the snapshot and the log lines.
 */
const observe = <A>(effect: Effect.Effect<A>, level: "Info" | "Debug" = "Info") => {
  const lines: Array<ReturnType<typeof Logger.formatStructured.log>> = []
  const sink = Logger.make((options) => {
    lines.push(Logger.formatStructured.log(options))
  })
  return Effect.gen(function*() {
    const value = yield* effect
    const snapshot = yield* Metric.snapshot
    return { value, snapshot, lines }
  }).pipe(
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.provide(level === "Info" ? RunMetrics.layerInfoLines : Layer.empty),
    Effect.provide(Logger.layer([sink])),
    Effect.provideService(References.MinimumLogLevel, "All")
  )
}

type Snapshot = ReadonlyArray<Metric.Metric.Snapshot>

/** The attributes and state of every series of metric `id`. */
const series = (snapshot: Snapshot, id: string) =>
  snapshot.filter((entry) => entry.id === id).map((entry) => ({ attributes: entry.attributes, state: entry.state }))

describe("RunMetrics labels", () => {
  it("keeps a door, an actor and a placement it lists, reads an absent one as unknown and any other as other", () => {
    expect(RunMetrics.doors.map(RunMetrics.door)).toEqual([...RunMetrics.doors])
    // A person's key press on host UI, such as a plugin keybinding, is its own door, never `other`.
    expect(RunMetrics.door("key")).toBe("key")
    expect(RunMetrics.actors.map(RunMetrics.actor)).toEqual([...RunMetrics.actors])
    expect(RunMetrics.placements.map(RunMetrics.placement)).toEqual([...RunMetrics.placements])
    expect([RunMetrics.door(undefined), RunMetrics.actor(undefined), RunMetrics.placement(undefined)]).toEqual([
      "unknown",
      "unknown",
      "unknown"
    ])
    expect([RunMetrics.door("someone@example.com"), RunMetrics.actor("ann"), RunMetrics.placement("mars")]).toEqual([
      "other",
      "other",
      "other"
    ])
  })

  it("reads a parked run's reason as a wait kind: event is a signal, an unknown reason other", () => {
    expect(["timer", "event", "signal", "approval", "quota", "human", "plugin:x"].map(RunMetrics.waitKind)).toEqual([
      "timer",
      "signal",
      "signal",
      "approval",
      "quota",
      "human",
      "other"
    ])
  })

  it("cleans a value to a short identifier", () => {
    expect(RunMetrics.clean("chat/Respond")).toBe("chat/Respond")
    expect(RunMetrics.clean("flows:@scope/name-1.2_x")).toBe("flows:@scope/name-1.2_x")
    expect(RunMetrics.clean("a flow with spaces & \"quotes\"")).toBe("a_flow_with_spaces____quotes_")
    expect(RunMetrics.clean("")).toBe("unknown")
    expect(RunMetrics.clean("x".repeat(500))).toHaveLength(96)
  })

  it("caps the distinct values a label holds: past the limit, a new value reads other and an old one keeps its name", () => {
    const labels = RunMetrics.makeLabels(2)
    expect([labels.of("a"), labels.of("b"), labels.of("c"), labels.of("a"), labels.of("b c")]).toEqual([
      "a",
      "b",
      "other",
      "a",
      "other"
    ])
    expect(labels.size()).toBe(2)
    // Two values that clean to one label take one place.
    const cleaned = RunMetrics.makeLabels(1)
    expect([cleaned.of("x y"), cleaned.of("x_y"), cleaned.of("z")]).toEqual(["x_y", "x_y", "other"])
  })
})

describe("RunMetrics.settlement", () => {
  it("classifies an exit by outcome and code, never by message", () => {
    expect(RunMetrics.settlement(Exit.succeed("SENTINEL value"))).toEqual({ outcome: "succeeded", code: "none" })
    expect(RunMetrics.settlement(Exit.fail(new Refused({ code: "quota_exceeded" })))).toEqual({
      outcome: "failed",
      code: "quota_exceeded"
    })
    expect(RunMetrics.settlement(Exit.fail(new Tagged({ reason: "SENTINEL reason" })))).toEqual({
      outcome: "failed",
      code: "Usage/Tagged"
    })
    expect(RunMetrics.settlement(Exit.fail("SENTINEL text"))).toEqual({ outcome: "failed", code: "failed" })
    expect(RunMetrics.settlement(Exit.fail({ code: "has spaces SENTINEL" }))).toEqual({
      outcome: "failed",
      code: "failed"
    })
    class Named extends Error {
      override name = "QuotaError"
    }
    expect(RunMetrics.settlement(Exit.die(new Named("SENTINEL")))).toEqual({ outcome: "failed", code: "QuotaError" })
    expect(RunMetrics.settlement(Exit.die(new Error("SENTINEL")))).toEqual({ outcome: "failed", code: "defect" })
    expect(RunMetrics.settlement(Exit.die("SENTINEL"))).toEqual({ outcome: "failed", code: "defect" })
    expect(RunMetrics.settlement(Exit.failCause(Cause.interrupt()))).toEqual({ outcome: "lost", code: "interrupted" })
    expect(
      RunMetrics.settlement(
        Exit.die(
          new Interpreter.InterpreterError({ code: "plan_changed", flow: "x/flow", node: "root", message: "SENTINEL" })
        )
      )
    ).toEqual({ outcome: "refused", code: "plan_changed" })
  })
})

describe("RunMetrics recorders", () => {
  it.effect("records a start and a settlement as metrics and log lines with the same fields", () =>
    Effect.gen(function*() {
      const { lines, snapshot } = yield* observe(Effect.gen(function*() {
        const labels = {
          flow: "chat/Respond",
          door: "slash",
          actor: "person",
          placement: "browser",
          executionId: "e-1"
        }
        yield* RunMetrics.recordStarted(labels)
        yield* RunMetrics.recordSettled({ ...labels, outcome: "succeeded", code: "none", durationMs: 1_250 })
        yield* RunMetrics.recordSettled({ ...labels, door: "nope", outcome: "failed", code: "quota_exceeded" })
        yield* RunMetrics.recordSettled({ ...labels, outcome: "cancelled", code: "cancelled", durationMs: -5 })
      }))
      expect(series(snapshot, "flows_runs_started")).toEqual([{
        attributes: { flow: "chat/Respond", door: "slash", actor: "person", placement: "browser" },
        state: { count: 1, incremental: true }
      }])
      expect(series(snapshot, "flows_runs_settled").map((entry) => entry.attributes)).toEqual([
        {
          flow: "chat/Respond",
          door: "slash",
          actor: "person",
          placement: "browser",
          outcome: "succeeded",
          code: "none"
        },
        {
          flow: "chat/Respond",
          door: "other",
          actor: "person",
          placement: "browser",
          outcome: "failed",
          code: "quota_exceeded"
        },
        {
          flow: "chat/Respond",
          door: "slash",
          actor: "person",
          placement: "browser",
          outcome: "cancelled",
          code: "cancelled"
        }
      ])
      const durations = series(snapshot, "flows_run_duration_ms")
      expect(durations.map((entry) => entry.attributes)).toEqual([
        { flow: "chat/Respond", outcome: "succeeded", placement: "browser" },
        { flow: "chat/Respond", outcome: "cancelled", placement: "browser" }
      ])
      expect(durations.map((entry) => (entry.state as Metric.HistogramState).sum)).toEqual([1_250, 0])
      expect(lines.map((line) => [line.message, line.level, line.annotations])).toEqual([
        ["flow.run.started", "INFO", {
          flow: "chat/Respond",
          door: "slash",
          actor: "person",
          placement: "browser",
          executionId: "e-1"
        }],
        ["flow.run.settled", "INFO", {
          flow: "chat/Respond",
          door: "slash",
          actor: "person",
          placement: "browser",
          outcome: "succeeded",
          code: "none",
          executionId: "e-1",
          durationMs: 1_250
        }],
        ["flow.run.settled", "WARN", {
          flow: "chat/Respond",
          door: "other",
          actor: "person",
          placement: "browser",
          outcome: "failed",
          code: "quota_exceeded",
          executionId: "e-1"
        }],
        ["flow.run.settled", "WARN", {
          flow: "chat/Respond",
          door: "slash",
          actor: "person",
          placement: "browser",
          outcome: "cancelled",
          code: "cancelled",
          executionId: "e-1",
          durationMs: 0
        }]
      ])
    }))

  it.effect("records the first step's wait, steps and retries, and durable waits", () =>
    Effect.gen(function*() {
      const { snapshot } = yield* observe(Effect.gen(function*() {
        yield* RunMetrics.recordFirstStep({ flow: "repo/clone", placement: "cloudflare", delayMs: 40 })
        yield* RunMetrics.recordFirstStep({ flow: "repo/clone", placement: "cloudflare", delayMs: -1 })
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 1, outcome: "failed" })
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 2, outcome: "succeeded" })
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 3, outcome: "interrupted" })
        yield* RunMetrics.recordWait({ flow: "repo/clone", kind: "timer" })
        yield* RunMetrics.recordWaitEnded({ flow: "repo/clone", kind: "timer", durationMs: 500 })
        yield* RunMetrics.recordWaitEnded({ flow: "repo/clone", kind: "timer", durationMs: -3 })
      }))
      const firstStep = series(snapshot, "flows_run_first_step_ms")
      expect(firstStep.map((entry) => entry.attributes)).toEqual([{ flow: "repo/clone", placement: "cloudflare" }])
      expect(firstStep[0]!.state as Metric.HistogramState).toMatchObject({ count: 2, sum: 40, min: 0, max: 40 })
      expect(
        series(snapshot, "flows_steps").map((
          entry
        ) => [entry.attributes, (entry.state as Metric.CounterState<number>).count])
      )
        .toEqual([
          [{ flow: "repo/clone", outcome: "failed" }, 1],
          [{ flow: "repo/clone", outcome: "succeeded" }, 1],
          [{ flow: "repo/clone", outcome: "interrupted" }, 1]
        ])
      expect(series(snapshot, "flows_step_retries")).toEqual([{
        attributes: { flow: "repo/clone" },
        state: { count: 2, incremental: true }
      }])
      expect(series(snapshot, "flows_waits")).toEqual([{
        attributes: { flow: "repo/clone", kind: "timer" },
        state: { count: 1, incremental: true }
      }])
      expect(series(snapshot, "flows_wait_ms")[0]!.state).toMatchObject({ count: 2, sum: 500 })
    }))

  it.effect("records a failed step attempt by its code: flow.step.failed at Warn and flows_step_failures", () =>
    Effect.gen(function*() {
      const steps = Effect.gen(function*() {
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 1, outcome: "failed", code: "sql:Connection", runId: "r-1" })
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 2, outcome: "failed" })
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 3, outcome: "succeeded", code: "ignored" })
        yield* RunMetrics.recordStep({ flow: "repo/clone", attempt: 4, outcome: "interrupted" })
      })
      const { lines, snapshot } = yield* observe(steps)
      expect(lines.map((line) => [line.message, line.level, line.annotations])).toEqual([
        ["flow.step.failed", "WARN", { flow: "repo/clone", attempt: 1, code: "sql:Connection", runId: "r-1" }],
        ["flow.step.failed", "WARN", { flow: "repo/clone", attempt: 2, code: "failed" }]
      ])
      expect(series(snapshot, "flows_step_failures")).toEqual([
        { attributes: { flow: "repo/clone", code: "sql:Connection" }, state: { count: 1, incremental: true } },
        { attributes: { flow: "repo/clone", code: "failed" }, state: { count: 1, incremental: true } }
      ])
      // Where run lines are Debug, so is a failed step's.
      const quiet = yield* observe(steps, "Debug")
      expect(quiet.lines.map((line) => [line.message, line.level])).toEqual([
        ["flow.step.failed", "DEBUG"],
        ["flow.step.failed", "DEBUG"]
      ])
    }))

  it.effect("records a model call, its tokens and a flow.model.call line; no tokens reported, none counted", () =>
    Effect.gen(function*() {
      const { lines, snapshot } = yield* observe(Effect.gen(function*() {
        yield* RunMetrics.recordModelCall({
          flow: "chat/Respond",
          model: "agent",
          outcome: "sealed",
          inputTokens: 1_200,
          outputTokens: 80
        })
        yield* RunMetrics.recordModelCall({ flow: "chat/Respond", model: "agent", outcome: "refused" })
        yield* RunMetrics.recordModelCall({
          flow: "chat/Respond",
          model: "agent",
          outcome: "interrupted",
          inputTokens: 0,
          outputTokens: 0
        })
      }))
      expect(series(snapshot, "flows_model_calls").map((entry) => entry.attributes)).toEqual([
        { flow: "chat/Respond", model: "agent", outcome: "sealed" },
        { flow: "chat/Respond", model: "agent", outcome: "refused" },
        { flow: "chat/Respond", model: "agent", outcome: "interrupted" }
      ])
      expect(series(snapshot, "flows_model_tokens")).toEqual([
        {
          attributes: { flow: "chat/Respond", model: "agent", direction: "input" },
          state: { count: 1_200, incremental: true }
        },
        {
          attributes: { flow: "chat/Respond", model: "agent", direction: "output" },
          state: { count: 80, incremental: true }
        }
      ])
      expect(lines.map((line) => line.annotations)).toEqual([
        { flow: "chat/Respond", model: "agent", outcome: "sealed", inputTokens: 1_200, outputTokens: 80 },
        { flow: "chat/Respond", model: "agent", outcome: "refused", inputTokens: 0, outputTokens: 0 },
        { flow: "chat/Respond", model: "agent", outcome: "interrupted", inputTokens: 0, outputTokens: 0 }
      ])
      expect(lines.every((line) => line.message === "flow.model.call")).toBe(true)
    }))

  it.effect("writes the usage lines at Debug unless the host asks for Info, and counts the same either way", () =>
    Effect.gen(function*() {
      expect(yield* RunMetrics.LineLevel).toBe("Debug")
      const { lines, snapshot } = yield* observe(
        Effect.gen(function*() {
          const labels = { flow: "cli/run", door: "api", actor: "app", placement: "local", executionId: "e-2" }
          yield* RunMetrics.recordStarted(labels)
          yield* RunMetrics.recordSettled({ ...labels, outcome: "failed", code: "defect" })
          yield* RunMetrics.recordModelCall({ flow: "cli/run", model: "agent", outcome: "sealed" })
        }),
        "Debug"
      )
      expect(lines.map((line) => [line.message, line.level])).toEqual([
        ["flow.run.started", "DEBUG"],
        ["flow.run.settled", "DEBUG"],
        ["flow.model.call", "DEBUG"]
      ])
      expect(series(snapshot, "flows_runs_settled")).toHaveLength(1)
    }))

  it.effect("withOrigin sets the origin a run started inside reads, in either argument order", () =>
    Effect.gen(function*() {
      expect(yield* RunMetrics.CurrentOrigin).toEqual({ door: "unknown", actor: "unknown" })
      const read = Effect.gen(function*() {
        return yield* RunMetrics.CurrentOrigin
      })
      expect(yield* RunMetrics.withOrigin(read, { door: "button", actor: "person" })).toEqual({
        door: "button",
        actor: "person"
      })
      expect(yield* read.pipe(RunMetrics.withOrigin({ door: "agent", actor: "agent" }))).toEqual({
        door: "agent",
        actor: "agent"
      })
    }))
})

// Last: it fills this module's per-process label caps, which every test above relies on being open.
describe("RunMetrics caps", () => {
  it("caps flow tags, model ids and codes per process at their published limits", () => {
    expect([RunMetrics.maxFlows, RunMetrics.maxModels, RunMetrics.maxCodes]).toEqual([200, 50, 100])
    const tags = Array.from({ length: RunMetrics.maxFlows + 5 }, (_, index) => `cap/flow-${index}`)
    const labelled = tags.map(RunMetrics.flow)
    expect(new Set(labelled).size).toBeLessThanOrEqual(RunMetrics.maxFlows + 1)
    expect(labelled.at(-1)).toBe("other")
    const models = Array.from(
      { length: RunMetrics.maxModels + 5 },
      (_, index) => RunMetrics.model(`cap-model-${index}`)
    )
    expect(models.at(-1)).toBe("other")
    const codes = Array.from({ length: RunMetrics.maxCodes + 5 }, (_, index) => RunMetrics.code(`cap_code_${index}`))
    expect(codes.at(-1)).toBe("other")
    // `none` is never a slot: a success always reads none.
    expect(RunMetrics.code("none")).toBe("none")
  })
})
