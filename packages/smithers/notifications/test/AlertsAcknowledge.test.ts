/**
 * Acknowledgement and repeat pages over a real journal: an alert nobody took
 * pages again, an alert somebody took stops, and both survive a new process.
 */
import { Journal, JournalEvent } from "@smthrs/journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Cause, Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Alerts from "../src/Alerts.ts"
import * as NotificationQueue from "../src/NotificationQueue.ts"

const runId = "lane-site"
const hour = 3_600_000

const policy: Alerts.Policy = {
  ...Alerts.probes({
    deploy: { afterMs: 0, repeatMs: hour, severity: "critical" },
    disk: { afterMs: 600_000 }
  })
}

const deployId = (since: number) => Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "deploy"), since })

/** A sink that keeps the id of every page it was handed. */
const keeping = () => {
  const sent: Array<string> = []
  return {
    sent,
    layer: Layer.succeed(Alerts.Sink)({ deliver: (alert) => Effect.sync(() => void sent.push(Alerts.alertId(alert))) })
  }
}

type Services = Alerts.AlertRuntime | Journal.Journal | NotificationQueue.NotificationQueue

/** The storage one test's runtimes share. */
const storage = Layer.mergeAll(NotificationQueue.layer).pipe(
  Layer.provideMerge(TestJournal.layer()),
  Layer.provideMerge(TestClock.layer())
)

/** A new alert runtime over the storage in context, as a second process would build. */
const runtime = (sink: Layer.Layer<Alerts.Sink>, rules: Alerts.Policy = policy) =>
  Alerts.layer(rules).pipe(Layer.provide(sink))

const run = <A>(sink: Layer.Layer<Alerts.Sink>, program: Effect.Effect<A, unknown, Services>) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(runtime(sink).pipe(Layer.provideMerge(storage))),
      Effect.scoped,
      Effect.orDie
    )
  )

const alerts = Alerts.AlertRuntime
const tick = Effect.flatMap(alerts, (service) => service.tick(runId))
const standing = Effect.flatMap(alerts, (service) => service.standing(runId))
const acknowledge = (id: string, by: string) => Effect.flatMap(alerts, (service) => service.acknowledge(runId, id, by))
const failing = (probe: string) => Alerts.report({ runId, probe, state: "failing" })
const states = (list: ReadonlyArray<Alerts.Standing>) =>
  list.map((item) => [item.alertId, item.state, item.acknowledgedBy])

const journaled = Effect.flatMap(Journal.Journal, (journal) =>
  Effect.map(
    journal.entries({ runId: JournalEvent.RunId.make(runId), limit: 512 }),
    (page) => page.entries.map((entry) => entry.eventType)
  ))

describe("an alert's state", () => {
  it("goes from raised to delivered to acknowledged, and an acknowledged alert is not paged again", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* failing("deploy")
        const raised = yield* standing
        yield* tick
        const delivered = yield* standing
        const taken = yield* acknowledge(deployId(0), "will")
        const again = yield* acknowledge(deployId(0), "ana")
        yield* TestClock.adjust("3 hours")
        yield* failing("deploy")
        const later = yield* tick
        return { raised, delivered, taken, again, later, acknowledged: yield* standing }
      })
    )

    expect(states(observed.raised)).toEqual([[deployId(0), "raised", undefined]])
    expect(states(observed.delivered)).toEqual([[deployId(0), "delivered", undefined]])
    expect([observed.taken, observed.again]).toEqual([true, true])
    // Three repeat periods have passed and the probe failed again: nobody is paged.
    expect(observed.later.delivered).toEqual([])
    expect(observed.later.suppressed.map((alert) => alert.reminder)).toEqual([3])
    expect(sink.sent).toEqual([deployId(0)])
    // The first acknowledgement stands.
    expect(states(observed.acknowledged)).toEqual([[deployId(0), "acknowledged", "will"]])
  })

  it("is acknowledged in a process that never saw the page", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* failing("deploy")
        yield* tick
        yield* acknowledge(deployId(0), "will")
        yield* TestClock.adjust("2 hours")
        return yield* Effect.all({ tick, standing }).pipe(Effect.provide(runtime(sink.layer)))
      })
    )

    expect(observed.tick.delivered).toEqual([])
    expect(states(observed.standing)).toEqual([[deployId(0), "acknowledged", "will"]])
    expect(sink.sent).toEqual([deployId(0)])
  })

  it("can be acknowledged before its delay has passed, and then never pages", async () => {
    const sink = keeping()
    const diskId = Alerts.alertId({ coalescingKey: Alerts.coalescingKey(runId, "disk"), since: 0 })
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* failing("disk")
        const early = yield* standing
        const taken = yield* acknowledge(diskId, "will")
        yield* TestClock.adjust("1 hour")
        return { early, taken, late: yield* tick, standing: yield* standing }
      })
    )

    expect(observed.early).toEqual([])
    expect(observed.taken).toBe(true)
    expect(observed.late.suppressed.map((alert) => alert.condition)).toEqual(["disk"])
    expect(states(observed.standing)).toEqual([[diskId, "acknowledged", "will"]])
    expect(sink.sent).toEqual([])
  })

  it("refuses an acknowledgement that names no open alert, and writes nothing", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* failing("deploy")
        yield* TestClock.adjust("1 hour")
        yield* tick
        const before = yield* journaled
        const unknown = yield* acknowledge("alert:nobody:nothing:0", "will")
        const repeat = yield* acknowledge(`${deployId(0)}:r1`, "will")
        yield* Alerts.report({ runId, probe: "deploy", state: "ok" })
        const cleared = yield* acknowledge(deployId(0), "will")
        return { unknown, repeat, cleared, before, after: yield* journaled }
      })
    )

    expect([observed.unknown, observed.repeat, observed.cleared]).toEqual([false, false, false])
    expect(observed.after).toEqual([...observed.before, Alerts.probeEventType("deploy")])
  })

  it("keeps the first 200 characters of who acknowledged", async () => {
    const observed = await run(
      keeping().layer,
      Effect.gen(function*() {
        yield* failing("deploy")
        yield* acknowledge(deployId(0), "w".repeat(201))
        return yield* standing
      })
    )

    expect(observed.map((item) => item.acknowledgedBy)).toEqual(["w".repeat(200)])
  })

  it("ignores an acknowledgement another producer journals, or one that names nobody", async () => {
    const sink = keeping()
    const forge = (sourceId: string, payload: Record<string, unknown>) =>
      Effect.flatMap(Journal.Journal, (journal) =>
        journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(runId),
            sourceId: JournalEvent.SourceId.make(sourceId),
            eventType: Alerts.acknowledgedEventType,
            payload
          })
        ))
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* failing("deploy")
        // A step in the run can name the alert. Only the alerter's source counts.
        yield* forge("/flow/step", { runId, alertId: deployId(0), by: "mallory" })
        yield* forge(`/notifications/alerts/${deployId(0)}/acknowledged`, { runId, alertId: deployId(0) })
        yield* forge("/flow/step", { runId, by: "mallory" })
        // The record's own fields are not evidence about the probe either.
        yield* forge("/flow/step", { state: "ok" })
        return { tick: yield* tick, standing: yield* standing }
      })
    )

    expect(observed.tick.delivered.map((alert) => alert.condition)).toEqual(["deploy"])
    expect(states(observed.standing)).toEqual([[deployId(0), "delivered", undefined]])
  })
})

describe("a rule with repeatMs", () => {
  it("pages again each period while nobody acknowledges, and stops when somebody does", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        const queue = yield* NotificationQueue.NotificationQueue
        yield* failing("deploy")
        const first = yield* tick
        yield* TestClock.adjust("30 minutes")
        const early = yield* tick
        yield* TestClock.adjust("30 minutes")
        const second = yield* tick
        yield* TestClock.adjust("70 minutes")
        const third = yield* tick
        const pending = yield* queue.pending(runId)
        yield* acknowledge(deployId(0), "will")
        yield* TestClock.adjust("2 hours")
        return { first, early, second, third, pending, last: yield* tick }
      })
    )

    expect(observed.first.delivered.map((alert) => [alert.reminder, alert.firedAt])).toEqual([[undefined, 0]])
    expect(observed.early.delivered).toEqual([])
    // A repeat is stamped with the journal instant it came due, not the tick's.
    expect(observed.second.delivered.map((alert) => [alert.reminder, alert.firedAt])).toEqual([[1, hour]])
    expect(observed.third.delivered.map((alert) => [alert.reminder, alert.firedAt])).toEqual([[2, 2 * hour]])
    expect(observed.last.delivered).toEqual([])
    expect(sink.sent).toEqual([deployId(0), `${deployId(0)}:r1`, `${deployId(0)}:r2`])
    // The run's inbox holds one entry for the condition, the latest page.
    expect(observed.pending.map((notification) => notification.id)).toEqual([`${deployId(0)}:r2`])
  })

  it("counts an alert as delivered when only a repeat ever reached the sink", async () => {
    const sink = keeping()
    const observed = await run(
      sink.layer,
      Effect.gen(function*() {
        yield* failing("deploy")
        yield* TestClock.adjust("90 minutes")
        yield* tick
        return yield* standing
      })
    )

    expect(sink.sent).toEqual([`${deployId(0)}:r1`])
    expect(states(observed)).toEqual([[deployId(0), "delivered", undefined]])
  })

  it("fails the composition when the period is not a positive whole number", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.asVoid(alerts).pipe(
        Effect.provide(
          runtime(Alerts.layerNoop, { rules: { deploy: { afterMs: 0, repeatMs: 0 } } }).pipe(
            Layer.provideMerge(storage)
          )
        ),
        Effect.scoped
      )
    )

    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  })
})
