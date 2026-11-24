/**
 * Probe reports over a real journal: a step reports what it saw, and the
 * alert runtime pages once for however many times the probe failed.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const runId = "lane-site"

const policy: Alerts.Policy = {
  defaults: { owner: "oncall" },
  ...Alerts.probes({
    "site-freshness": { afterMs: 0, severity: "critical" },
    "disk.*": { afterMs: 0 },
    "disk.root": { afterMs: 0 }
  })
}

/** A sink that keeps every alert it was handed. */
const keeping = () => {
  const sent: Array<Alerts.Alert> = []
  return {
    sent,
    layer: Layer.succeed(Alerts.Sink)({ deliver: (alert) => Effect.sync(() => void sent.push(alert)) })
  }
}

const run = <A>(
  sink: Layer.Layer<Alerts.Sink>,
  program: Effect.Effect<A, unknown, Alerts.AlertRuntime | Journal.Journal | NotificationQueue.NotificationQueue>
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(
        Alerts.layer(policy).pipe(
          Layer.provideMerge(Layer.mergeAll(NotificationQueue.layer, sink)),
          Layer.provideMerge(TestJournal.layer()),
          Layer.provideMerge(TestClock.layer())
        )
      ),
      Effect.scoped,
      Effect.orDie
    )
  )

const tick = Effect.flatMap(Alerts.AlertRuntime, (alerts) => alerts.tick(runId))

describe("Alerts.report", () => {
  it("pages once for a probe that fails three times, with the first failure's time and summary", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* TestClock.adjust("1 hour")
        yield* Alerts.report({
          runId,
          probe: "site-freshness",
          state: "failing",
          summary: "site lags main by 979 minutes"
        })
        const first = yield* tick
        yield* TestClock.adjust("1 hour")
        yield* Alerts.report({
          runId,
          probe: "site-freshness",
          state: "failing",
          summary: "site lags main by 1,040 minutes"
        })
        const second = yield* tick
        yield* TestClock.adjust("1 hour")
        yield* Alerts.report({ runId, probe: "site-freshness", state: "failing" })
        const third = yield* tick
        const queue = yield* NotificationQueue.NotificationQueue
        return { first, second, third, pending: yield* queue.pending(runId) }
      })
    )

    const alert: Alerts.Alert = {
      runId,
      condition: "site-freshness",
      since: 3_600_000,
      // The first failing report is the journal's first entry.
      opening: 0,
      firedAt: 3_600_000,
      severity: "critical",
      coalescingKey: Alerts.coalescingKey(runId, "site-freshness"),
      summary: "site lags main by 979 minutes",
      owner: "oncall"
    }
    expect(observed.first.delivered).toEqual([alert])
    expect(observed.second).toEqual({ delivered: [], failed: [], refused: [], suppressed: [alert] })
    expect(observed.third).toEqual({ delivered: [], failed: [], refused: [], suppressed: [alert] })
    expect(sink.sent).toEqual([alert])
    // The owning run's inbox holds the one alert, and it says what the page said.
    expect(observed.pending.map((notification) => [notification.id, notification.payload])).toEqual([[
      Alerts.alertId(alert),
      {
        condition: "site-freshness",
        severity: "critical",
        since: 3_600_000,
        opening: 0,
        firedAt: 3_600_000,
        summary: "site lags main by 979 minutes",
        owner: "oncall"
      }
    ]])
  })

  it("clears on an ok report and pages again when the probe fails again", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* Alerts.report({ runId, probe: "site-freshness", state: "failing", summary: "deploy failed" })
        yield* tick
        yield* TestClock.adjust("10 minutes")
        yield* Alerts.report({ runId, probe: "site-freshness", state: "ok" })
        const cleared = yield* tick
        yield* TestClock.adjust("10 minutes")
        yield* Alerts.report({ runId, probe: "site-freshness", state: "failing", summary: "deploy failed again" })
        const again = yield* tick
        return { cleared, again }
      })
    )

    expect(observed.cleared).toEqual({ delivered: [], failed: [], refused: [], suppressed: [] })
    expect(observed.again.delivered.map((alert) => alert.summary)).toEqual(["deploy failed again"])
    // A condition that re-opens is a new alert, with a new id for the sink to dedupe on.
    expect(sink.sent.map((alert) => Alerts.alertId(alert))).toEqual([
      `alert:${Alerts.coalescingKey(runId, "site-freshness")}:0:s0`,
      `alert:${Alerts.coalescingKey(runId, "site-freshness")}:1200000:s4`
    ])
  })

  it("keeps one probe's reports from opening or closing another's, even when one name reads as a family", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* Alerts.report({ runId, probe: "disk.root", state: "failing" })
        const rootOnly = yield* tick
        yield* Alerts.report({ runId, probe: "disk.*", state: "ok" })
        yield* Alerts.report({ runId, probe: "site-freshness", state: "ok" })
        const still = yield* tick
        return { rootOnly, still }
      })
    )

    // `disk.*` is a probe's name here, not a family: it did not fire on
    // `disk.root`'s failure, and its ok report did not clear `disk.root`.
    expect(observed.rootOnly.delivered.map((alert) => alert.condition)).toEqual(["disk.root"])
    expect(observed.still.suppressed.map((alert) => alert.condition)).toEqual(["disk.root"])
    expect(Alerts.probeEventType("disk.*")).toBe("flows.alerts.probe.disk.%2A")
  })

  it("keeps the first 500 characters of a summary", async () => {
    const sink = keeping()
    await run(
      sink.layer,
      Effect.gen(function*() {
        yield* Alerts.report({ runId, probe: "site-freshness", state: "failing", summary: "x".repeat(501) })
        yield* tick
      })
    )

    expect(sink.sent.map((alert) => alert.summary)).toEqual(["x".repeat(Alerts.maxSummaryLength)])
  })

  it("fails with a typed refusal, and journals nothing, for a report the journal cannot record", async () => {
    const refusal = (input: Alerts.Report) =>
      Effect.runPromise(
        Effect.gen(function*() {
          const error = (yield* Effect.flip(Alerts.report(input))) as NotificationQueue.NotificationError
          const journal = yield* Journal.Journal
          const written = yield* journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 8 })
          return [error._tag, error.code, error.path, written.entries.length]
        }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped)
      )
    const invalid = (path: string) => ["/notifications/NotificationError", "notification_invalid", path, 0]

    // A step that names no probe is wrong, and can now branch on being told so.
    expect(await refusal({ runId, probe: "", state: "failing" })).toEqual(invalid("report"))
    expect(await refusal({ runId: "run\u0000id", probe: "disk", state: "failing" })).toEqual(invalid("runId"))
    expect(await refusal({ runId: "r".repeat(1_025), probe: "disk", state: "failing" })).toEqual(invalid("runId"))
    // Percent-encoding a lone surrogate throws, and a long name encodes past the journal's identifier bound.
    expect(await refusal({ runId, probe: "\uD800", state: "failing" })).toEqual(invalid("probe"))
    expect(await refusal({ runId, probe: "p".repeat(1_024), state: "failing" })).toEqual(invalid("probe"))
  })

  it("never ends a summary on half a character", async () => {
    const sink = keeping()
    await run(
      sink.layer,
      Effect.gen(function*() {
        // The 500th unit is the first half of an emoji: keeping it would leave a lone surrogate.
        yield* Alerts.report({ runId, probe: "site-freshness", state: "failing", summary: `${"x".repeat(499)}😀tail` })
        yield* tick
        yield* Alerts.report({ runId, probe: "site-freshness", state: "ok" })
        // The emoji ends exactly at the bound, so all of it is kept.
        yield* Alerts.report({ runId, probe: "site-freshness", state: "failing", summary: `${"x".repeat(498)}😀tail` })
        yield* tick
      })
    )

    expect(sink.sent.map((alert) => alert.summary)).toEqual(["x".repeat(499), `${"x".repeat(498)}😀`])
  })
})

describe("a detector's summary field", () => {
  const entry = (seq: number, payload: Record<string, unknown>): JournalEvent.Entry =>
    new JournalEvent.Entry({
      runId: JournalEvent.RunId.make(runId),
      seq: JournalEvent.Seq.make(seq),
      eventId: `event-${seq}`,
      sourceId: JournalEvent.SourceId.make("/test"),
      sourceSeq: JournalEvent.SourceSeq.make(seq),
      emittedAtMs: seq * 1_000,
      eventType: "vendor.health",
      payload,
      meta: {}
    })

  const vendor = (summary: string): Alerts.Policy => ({
    rules: { degraded: { afterMs: 0 } },
    detectors: { degraded: { field: "health", value: "degraded", summary } }
  })

  it("carries the opening entry's string and ignores every later one", () => {
    expect(
      Alerts.conditions(vendor("note"), runId, [
        entry(1, { health: "degraded", note: "replica behind" }),
        entry(2, { health: "degraded", note: "replica further behind" })
      ])
    ).toEqual([{ runId, condition: "degraded", since: 1_000, summary: "replica behind" }])
  })

  it("carries nothing when the field is absent, not a string, or only inherited", () => {
    expect(Alerts.conditions(vendor("note"), runId, [entry(1, { health: "degraded" })])).toEqual([
      { runId, condition: "degraded", since: 1_000 }
    ])
    expect(Alerts.conditions(vendor("note"), runId, [entry(1, { health: "degraded", note: 7 })])).toEqual([
      { runId, condition: "degraded", since: 1_000 }
    ])
    expect(Alerts.conditions(vendor("toString"), runId, [entry(1, { health: "degraded" })])).toEqual([
      { runId, condition: "degraded", since: 1_000 }
    ])
  })
})
